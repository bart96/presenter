<?php

require_once(__DIR__ . '/RestController.php');

/**
 * Set Lists — a reusable, account-scoped planning layer on top of the song library.
 *
 * GET    /rest/SetLists          → every set list of the account, with entries, tag
 *                                  assignments and band ids nested. Set lists are small
 *                                  (tens of songs), so one round trip keeps the UI simple.
 * POST   /rest/SetLists          → { name, bandIds? }         create
 * PUT    /rest/SetLists/{id}     → { name?, bandIds? }        partial update
 * DELETE /rest/SetLists/{id}     → delete (entries + tag assignments cascade)
 *
 * Entries and tag assignments are managed through /rest/SetListEntries.
 */
class SetLists extends RestController
{
    protected function get(Request &$req, Response &$res): never
    {
        $account = $req->account;

        $stmt = self::prepare('
                SELECT `id`, `name`, `created_at`, `updated_at`
                FROM `set_lists`
                WHERE `account` = ?
                ORDER BY `sort_order`, `name`
            ');
        $stmt->bind_param('i', $account)->execute()->fetchAll($lists)->close();

        if (count($lists) === 0) {
            $res->success([]);
        }

        // Bulk-load entries and tag assignments for ALL of the account's set lists so the
        // client never has to fan out one request per list.
        $stmt = self::prepare('
                SELECT e.`id`, e.`set_list_id`, e.`songnumber`, s.`title`, s.`authors`
                FROM `set_list_entries` e
                INNER JOIN `set_lists` l ON l.`id` = e.`set_list_id`
                LEFT JOIN `songs` s ON s.`account` = e.`account` AND s.`songnumber` = e.`songnumber`
                WHERE l.`account` = ?
                ORDER BY e.`sort_order`, e.`id`
            ');
        $stmt->bind_param('i', $account)->execute()->fetchAll($entryRows)->close();

        $stmt = self::prepare('
                SELECT t.`id`, t.`set_list_entry_id`, t.`tag_name`, t.`custom_key`, t.`block_order_name`
                FROM `set_list_entry_tags` t
                INNER JOIN `set_list_entries` e ON e.`id` = t.`set_list_entry_id`
                INNER JOIN `set_lists` l ON l.`id` = e.`set_list_id`
                WHERE l.`account` = ?
                ORDER BY t.`tag_name`
            ');
        $stmt->bind_param('i', $account)->execute()->fetchAll($tagRows)->close();

        // Band assignments for every list of the account — one query, same reasoning as above.
        // Guarded because the table only exists after migration 23: a deployment running the
        // new code against the old schema still gets its set lists, minus the band chips.
        $bandRows = [];
        try {
            $stmt = self::prepare('
                    SELECT sb.`set_list_id`, sb.`band_id`
                    FROM `set_list_bands` sb
                    INNER JOIN `set_lists` l ON l.`id` = sb.`set_list_id`
                    INNER JOIN `bands` b ON b.`id` = sb.`band_id`
                    WHERE l.`account` = ?
                    ORDER BY b.`sort_order`, b.`name`
                ');
            $stmt->bind_param('i', $account)->execute()->fetchAll($bandRows)->close();
        } catch (\Throwable $e) {
            $bandRows = [];
        }

        $bandsByList = [];
        foreach ($bandRows as $row) {
            $bandsByList[(int)$row['set_list_id']][] = (int)$row['band_id'];
        }

        $tagsByEntry = [];
        foreach ($tagRows as $row) {
            $tagsByEntry[(int)$row['set_list_entry_id']][] = [
                'id' => (int)$row['id'],
                'tagName' => $row['tag_name'],
                'customKey' => $row['custom_key'],
                'blockOrderName' => $row['block_order_name'],
            ];
        }

        $entriesByList = [];
        foreach ($entryRows as $row) {
            $entryId = (int)$row['id'];
            $entriesByList[(int)$row['set_list_id']][] = [
                'id' => $entryId,
                'songNumber' => (int)$row['songnumber'],
                'songTitle' => $row['title'],
                'songAuthors' => $row['authors'],
                'tags' => $tagsByEntry[$entryId] ?? [],
            ];
        }

        $result = [];
        foreach ($lists as $list) {
            $id = (int)$list['id'];
            $result[] = [
                'id' => $id,
                'name' => $list['name'],
                'bandIds' => $bandsByList[$id] ?? [],
                'createdAt' => $list['created_at'],
                'updatedAt' => $list['updated_at'],
                'entries' => $entriesByList[$id] ?? [],
            ];
        }

        $res->success($result);
    }

    protected function post(Request &$req, Response &$res): never
    {
        $req->params->check('name');

        $account = $req->account;
        $name = trim((string)$req->params->get('name'));

        if ($name === '') {
            $res->error(400, 'Set list name must not be empty');
        }

        $stmt = self::prepare('SELECT `id` FROM `set_lists` WHERE `account` = ? AND `name` = ?');
        $stmt->bind_param('is', $account, $name)->execute()->fetchOne($existing)->close();
        if ($existing) {
            $res->error(409, 'A set list with this name already exists');
        }

        // Append after the current last list so the tab strip keeps a stable order.
        $stmt = self::prepare('SELECT COALESCE(MAX(`sort_order`), -1) + 1 AS `next` FROM `set_lists` WHERE `account` = ?');
        $stmt->bind_param('i', $account)->execute()->fetchOne($sortRow)->close();
        $sortOrder = (int)($sortRow['next'] ?? 0);

        $stmt = self::prepare('INSERT INTO `set_lists` (`account`, `name`, `sort_order`) VALUES (?, ?, ?)');
        $stmt->bind_param('isi', $account, $name, $sortOrder)->execute()->id($id)->close();

        if ($req->params->provided('bandIds')) {
            $this->writeBandIds($account, (int)$id, $req->params->getAsArray('bandIds', []));
        }

        $res->success([
            'id' => (int)$id,
            'name' => $name,
            'bandIds' => $this->fetchBandIds($account, (int)$id),
            'entries' => [],
            'message' => 'Set list created',
        ]);
    }

    protected function put(Request &$req, Response &$res): never
    {
        // PUT /rest/SetLists/reorder → persist the tab order; PUT /rest/SetLists/{id} → rename.
        if ($req->path->get(0, '', false) === 'reorder') {
            $this->handleReorder($req, $res);
        }

        $req->path->checkNumeric(0);

        $id = $req->path->getAsInt(0);
        $account = $req->account;

        // Partial update: the band picker saves without touching the name, and a rename
        // must not have to send the bands back with it.
        if (!$req->params->provided('name') && !$req->params->provided('bandIds')) {
            $res->error(400, 'No fields to update');
        }

        $stmt = self::prepare('SELECT `id`, `name` FROM `set_lists` WHERE `id` = ? AND `account` = ?');
        $stmt->bind_param('ii', $id, $account)->execute()->fetchOne($list)->close();
        if (!$list) {
            $res->error(404, 'Set list not found');
        }

        $name = $list['name'];

        if ($req->params->provided('name')) {
            $name = trim((string)$req->params->get('name'));

            if ($name === '') {
                $res->error(400, 'Set list name must not be empty');
            }

            $stmt = self::prepare('SELECT `id` FROM `set_lists` WHERE `account` = ? AND `name` = ? AND `id` <> ?');
            $stmt->bind_param('isi', $account, $name, $id)->execute()->fetchOne($clash)->close();
            if ($clash) {
                $res->error(409, 'A set list with this name already exists');
            }

            $stmt = self::prepare('UPDATE `set_lists` SET `name` = ? WHERE `id` = ? AND `account` = ?');
            $stmt->bind_param('sii', $name, $id, $account)->execute()->close();
        }

        if ($req->params->provided('bandIds')) {
            $this->writeBandIds($account, $id, $req->params->getAsArray('bandIds', []));
        }

        $res->success([
            'id' => $id,
            'name' => $name,
            'bandIds' => $this->fetchBandIds($account, $id),
            'message' => 'Set list updated',
        ]);
    }

    /** The bands assigned to one set list, in the order the band list itself is shown in. */
    private function fetchBandIds(int $account, int $setListId): array
    {
        try {
            $stmt = self::prepare('
                    SELECT sb.`band_id`
                    FROM `set_list_bands` sb
                    INNER JOIN `bands` b ON b.`id` = sb.`band_id`
                    WHERE sb.`set_list_id` = ? AND b.`account` = ?
                    ORDER BY b.`sort_order`, b.`name`
                ');
            $stmt->bind_param('ii', $setListId, $account)->execute()->fetchAll($rows)->close();
        } catch (\Throwable $e) {
            return [];
        }

        return array_map(fn ($row) => (int)$row['band_id'], $rows);
    }

    /**
     * Replace the set list's band assignments. Ids the account does not own are dropped
     * rather than rejected — a band deleted elsewhere must not cost the user their save.
     */
    private function writeBandIds(int $account, int $setListId, array $bandIds): void
    {
        $stmt = self::prepare('DELETE FROM `set_list_bands` WHERE `set_list_id` = ?');
        $stmt->bind_param('i', $setListId)->execute()->close();

        $ids = array_values(array_unique(array_filter(array_map('intval', $bandIds), fn ($id) => $id > 0)));
        foreach ($ids as $bandId) {
            $stmt = self::prepare('
                    INSERT IGNORE INTO `set_list_bands` (`set_list_id`, `band_id`)
                    SELECT ?, `id` FROM `bands` WHERE `id` = ? AND `account` = ?
                ');
            $stmt->bind_param('iii', $setListId, $bandId, $account)->execute()->close();
        }
    }

    /**
     * Persist the left-to-right order of the tab strip.
     * Takes the full list of ids in their new order; ids the account does not own are ignored,
     * so a stale client can never reshuffle someone else's lists.
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
                $stmt = self::prepare('UPDATE `set_lists` SET `sort_order` = ? WHERE `id` = ? AND `account` = ?');
                $stmt->bind_param('iii', $position, $id, $account)->execute()->close();
                $position++;
            }
            $tx->commit();
        } catch (\Throwable $e) {
            $tx->rollback();
            $res->error(500, 'Failed to reorder set lists: ' . $e->getMessage());
        }

        $res->success(['message' => 'Set lists reordered', 'order' => $ids]);
    }

    protected function delete(Request &$req, Response &$res): never
    {
        $req->path->checkNumeric(0);
        $id = $req->path->getAsInt(0);
        $account = $req->account;

        $stmt = self::prepare('DELETE FROM `set_lists` WHERE `id` = ? AND `account` = ?');
        $stmt->bind_param('ii', $id, $account)->execute()->close();

        $res->success(['message' => 'Set list deleted']);
    }
}
