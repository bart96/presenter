<?php

require_once(__DIR__ . '/RestController.php');

/**
 * Bands — the groups of people that play the shows of an account.
 *
 * A band used to exist only implicitly, as the name of a song order ("Youth Band [G]"),
 * which meant it could never be renamed, coloured or listed. It is now an account-scoped
 * row carrying the musicians on it, and shows and set lists point at it through join
 * tables (`show_bands`, `set_list_bands`) because several bands can share one service.
 *
 * `members` is a JSON list rather than a table of its own: nothing ever joins on a single
 * member — they exist to be offered as suggestions on the musician page.
 *
 * GET    /rest/Bands           → every band of the account, in display order
 * POST   /rest/Bands           → { name, color?, members? }  create
 * PUT    /rest/Bands/{id}      → { name?, color?, members? } partial update
 * PUT    /rest/Bands/reorder   → { order: [id, …] }          persist the display order
 * DELETE /rest/Bands/{id}      → delete (assignments cascade, shows are left alone)
 */
class Bands extends RestController
{
    /** Longest member list we store — a band, not a mailing list. */
    private const MAX_MEMBERS = 100;

    protected function get(Request &$req, Response &$res): never
    {
        $account = $req->account;

        $stmt = self::prepare('
                SELECT `id`, `name`, `color`, `members`, `sort_order`, `created_at`, `updated_at`
                FROM `bands`
                WHERE `account` = ?
                ORDER BY `sort_order`, `name`
            ');
        $stmt->bind_param('i', $account)->execute()->fetchAll($rows)->close();

        $res->success(array_map(fn ($row) => $this->hydrate($row), $rows));
    }

    /** Normalise a row for the client: real types, and `members` as a list. */
    private function hydrate(array $row): array
    {
        return [
            'id' => (int)$row['id'],
            'name' => $row['name'],
            'color' => $row['color'],
            'members' => $this->decodeMembers($row['members'] ?? null),
            'sortOrder' => (int)$row['sort_order'],
            'createdAt' => $row['created_at'] ?? null,
            'updatedAt' => $row['updated_at'] ?? null,
        ];
    }

    private function decodeMembers(?string $raw): array
    {
        $decoded = $raw === null ? [] : json_decode($raw, true);

        return is_array($decoded) ? array_values(array_filter($decoded, 'is_string')) : [];
    }

    /**
     * Trim, drop the blanks and collapse duplicates, keeping the order the client sent —
     * the list is a picker, so its sequence is the band's own idea of who comes first.
     */
    private function sanitiseMembers(mixed $raw): array
    {
        if (!is_array($raw)) {
            return [];
        }

        $members = [];
        foreach ($raw as $entry) {
            if (!is_string($entry) && !is_numeric($entry)) {
                continue;
            }
            $name = mb_substr(trim((string)$entry), 0, 200);
            if ($name === '') {
                continue;
            }
            if (!in_array($name, $members, true)) {
                $members[] = $name;
            }
            if (count($members) >= self::MAX_MEMBERS) {
                break;
            }
        }

        return $members;
    }

    /** A hex colour, or null when the band should just use the default chip colour. */
    private function sanitiseColor(mixed $raw): ?string
    {
        if (!is_string($raw)) {
            return null;
        }
        $color = trim($raw);

        return preg_match('/^#[0-9a-fA-F]{3,8}$/', $color) === 1 ? $color : null;
    }

    protected function post(Request &$req, Response &$res): never
    {
        $req->params->check('name');

        $account = $req->account;
        $name = mb_substr(trim((string)$req->params->get('name')), 0, 200);

        if ($name === '') {
            $res->error(400, 'Band name must not be empty');
        }

        $stmt = self::prepare('SELECT `id` FROM `bands` WHERE `account` = ? AND `name` = ?');
        $stmt->bind_param('is', $account, $name)->execute()->fetchOne($existing)->close();
        if ($existing) {
            $res->error(409, 'A band with this name already exists');
        }

        $color = $this->sanitiseColor($req->params->get('color', null, false));
        $members = json_encode($this->sanitiseMembers($req->params->getAsArray('members', [])));

        // Append after the current last band so the list keeps a stable order.
        $stmt = self::prepare('SELECT COALESCE(MAX(`sort_order`), -1) + 1 AS `next` FROM `bands` WHERE `account` = ?');
        $stmt->bind_param('i', $account)->execute()->fetchOne($sortRow)->close();
        $sortOrder = (int)($sortRow['next'] ?? 0);

        $stmt = self::prepare('INSERT INTO `bands` (`account`, `name`, `color`, `members`, `sort_order`) VALUES (?, ?, ?, ?, ?)');
        $stmt->bind_param('isssi', $account, $name, $color, $members, $sortOrder)->execute()->id($id)->close();

        $res->success([
            'id' => (int)$id,
            'name' => $name,
            'color' => $color,
            'members' => json_decode($members, true),
            'sortOrder' => $sortOrder,
            'message' => 'Band created',
        ]);
    }

    protected function put(Request &$req, Response &$res): never
    {
        // PUT /rest/Bands/reorder → persist the display order; PUT /rest/Bands/{id} → edit.
        if ($req->path->get(0, '', false) === 'reorder') {
            $this->handleReorder($req, $res);
        }

        $req->path->checkNumeric(0);

        $id = $req->path->getAsInt(0);
        $account = $req->account;

        $stmt = self::prepare('SELECT `id` FROM `bands` WHERE `id` = ? AND `account` = ?');
        $stmt->bind_param('ii', $id, $account)->execute()->fetchOne($band)->close();
        if (!$band) {
            $res->error(404, 'Band not found');
        }

        // Partial update: renaming a band must not clear its members, and editing the
        // members must not make the client send the name back.
        $fields = [];
        $types = '';
        $values = [];

        if ($req->params->provided('name')) {
            $name = mb_substr(trim((string)$req->params->get('name')), 0, 200);
            if ($name === '') {
                $res->error(400, 'Band name must not be empty');
            }

            $stmt = self::prepare('SELECT `id` FROM `bands` WHERE `account` = ? AND `name` = ? AND `id` <> ?');
            $stmt->bind_param('isi', $account, $name, $id)->execute()->fetchOne($clash)->close();
            if ($clash) {
                $res->error(409, 'A band with this name already exists');
            }

            $fields[] = '`name` = ?';
            $types .= 's';
            $values[] = $name;
        }

        if ($req->params->provided('color')) {
            $fields[] = '`color` = ?';
            $types .= 's';
            $values[] = $this->sanitiseColor($req->params->get('color', null, false));
        }

        if ($req->params->provided('members')) {
            $fields[] = '`members` = ?';
            $types .= 's';
            $values[] = json_encode($this->sanitiseMembers($req->params->getAsArray('members', [])));
        }

        if (count($fields) === 0) {
            $res->error(400, 'No fields to update');
        }

        $sql = 'UPDATE `bands` SET ' . implode(', ', $fields) . ' WHERE `id` = ? AND `account` = ?';
        $types .= 'ii';
        $values[] = $id;
        $values[] = $account;

        $stmt = self::prepare($sql);
        $stmt->bind_param($types, ...$values)->execute()->close();

        $stmt = self::prepare('
                SELECT `id`, `name`, `color`, `members`, `sort_order`, `created_at`, `updated_at`
                FROM `bands`
                WHERE `id` = ? AND `account` = ?
            ');
        $stmt->bind_param('ii', $id, $account)->execute()->fetchOne($updated)->close();

        $res->success($this->hydrate($updated) + ['message' => 'Band updated']);
    }

    /**
     * Persist the display order. Takes every id in its new position; ids the account does
     * not own are ignored, so a stale client can never reshuffle someone else's bands.
     */
    private function handleReorder(Request &$req, Response &$res): never
    {
        $req->params->checkArray('order');

        $account = $req->account;
        $ids = array_values(array_filter(array_map('intval', $req->params->getAsArray('order')), fn ($id) => $id > 0));

        if (count($ids) === 0) {
            $res->success(['message' => 'Nothing to reorder']);
        }

        $tx = self::transaction();
        try {
            $position = 0;
            foreach ($ids as $id) {
                $stmt = self::prepare('UPDATE `bands` SET `sort_order` = ? WHERE `id` = ? AND `account` = ?');
                $stmt->bind_param('iii', $position, $id, $account)->execute()->close();
                $position++;
            }
            $tx->commit();
        } catch (\Throwable $e) {
            $tx->rollback();
            $res->error(500, 'Failed to reorder bands: ' . $e->getMessage());
        }

        $res->success(['message' => 'Bands reordered', 'order' => $ids]);
    }

    protected function delete(Request &$req, Response &$res): never
    {
        $req->path->checkNumeric(0);
        $id = $req->path->getAsInt(0);
        $account = $req->account;

        // The join tables cascade, so the shows and set lists this band played stay put
        // and simply lose the assignment.
        $stmt = self::prepare('DELETE FROM `bands` WHERE `id` = ? AND `account` = ?');
        $stmt->bind_param('ii', $id, $account)->execute()->close();

        $res->success(['message' => 'Band deleted']);
    }
}
