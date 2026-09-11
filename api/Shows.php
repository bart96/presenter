<?php

require_once(__DIR__ . '/RestController.php');
require_once(__DIR__ . '/../classes/ChurchToolsCcli.php');

class Shows extends RestController
{
    protected function get(Request &$req, Response &$res): never
    {
        $account = $req->account;
        $limit = $req->path->getAsInt('0', 10);
        $offset = $req->path->getAsInt('1', 0) * $limit;
        // Optional single-show fetch by title — avoids loading the whole library just to look up
        // one show (used by the update poller and the musician follow-operator sync).
        $title = $req->query->get('title', '', false);

        $result = [
            "limit" => $limit,
            "offset" => $offset,
            "account" => $account,
            "shows" => []
        ];

        if ($title !== '') {
            $stmt = self::prepare('
			SELECT `title`, `order`, `groups`, `date`, `style_id`, `event_id`, `event_name`
			FROM `shows`
			WHERE `account` = ? AND `title` = ?
			LIMIT 1
		');
            $stmt->bind_param('is', $account, $title)->execute();
        } else {
            $stmt = self::prepare('
			SELECT `title`, `order`, `groups`, `date`, `style_id`, `event_id`, `event_name`
			FROM `shows`
			WHERE `account` = ?
			ORDER BY `date` DESC
			LIMIT ?
			OFFSET ?
		');
            $stmt->bind_param('iii', $account, $limit, $offset)->execute();
        }
        $stmt->fetchAll($rows);
        $stmt->close();

        $bandsByTitle = $this->fetchBandIds($account, array_column($rows, 'title'));

        foreach ($rows as $row) {
            $decoded = json_decode($row['order'], true);
            if ($decoded === null && $row['order'] !== null && $row['order'] !== 'null') {
                require_once(__DIR__ . '/../classes/Logging.php');
                Logging::warning('Shows: json_decode failed for show "' . $row['title'] . '", raw value: ' . substr($row['order'], 0, 200));
            }
            $groups = isset($row['groups']) ? json_decode($row['groups'], true) : null;
            $result["shows"][] = [
                'title' => $row['title'],
                'order' => is_array($decoded) ? $decoded : [],
                'groups' => is_array($groups) ? $groups : null,
                'date' => $row['date'],
                'styleId' => $row['style_id'] ? (int)$row['style_id'] : null,
                'eventId' => $row['event_id'] !== null ? (int)$row['event_id'] : null,
                'eventName' => $row['event_name'] ?? null,
                'bandIds' => $bandsByTitle[$row['title']] ?? []
            ];
        }

        $res->success($result);
    }

    /**
     * Band assignments for the given show titles, as title → [bandId, …].
     *
     * One query for the whole page rather than one per show: a show carries at most a
     * handful of bands, and the list view needs them all to draw its chips.
     */
    private function fetchBandIds(int $account, array $titles): array
    {
        $titles = array_values(array_unique(array_filter($titles, 'is_string')));
        if (count($titles) === 0) {
            return [];
        }

        $placeholders = implode(',', array_fill(0, count($titles), '?'));

        // A deployment that has the new code but has not run migration 23 yet has no
        // `show_bands` table. Bands are decoration on this endpoint — losing the whole show
        // list over them would be a far worse failure than showing no chips.
        try {
            $stmt = self::prepare("
					SELECT sb.`show_title`, sb.`band_id`
					FROM `show_bands` sb
					INNER JOIN `bands` b ON b.`id` = sb.`band_id`
					WHERE sb.`account` = ? AND sb.`show_title` IN ({$placeholders})
					ORDER BY b.`sort_order`, b.`name`
				");
            $stmt->bind_param('i' . str_repeat('s', count($titles)), $account, ...$titles)->execute()->fetchAll($rows)->close();
        } catch (\Throwable $e) {
            return [];
        }

        $byTitle = [];
        foreach ($rows as $row) {
            $byTitle[$row['show_title']][] = (int)$row['band_id'];
        }

        return $byTitle;
    }

    /**
     * Replace the show's band assignments with the given ids.
     *
     * Ids the account does not own are dropped rather than rejected: the caller is saving a
     * show, and a band that was deleted elsewhere must not cost them the save.
     */
    private function writeBandIds(int $account, string $title, array $bandIds): void
    {
        $stmt = self::prepare('DELETE FROM `show_bands` WHERE `account` = ? AND `show_title` = ?');
        $stmt->bind_param('is', $account, $title)->execute()->close();

        $ids = array_values(array_unique(array_filter(array_map('intval', $bandIds), fn ($id) => $id > 0)));
        foreach ($ids as $bandId) {
            $stmt = self::prepare('
					INSERT IGNORE INTO `show_bands` (`account`, `show_title`, `band_id`)
					SELECT ?, ?, `id` FROM `bands` WHERE `id` = ? AND `account` = ?
				');
            $stmt->bind_param('isii', $account, $title, $bandId, $account)->execute()->close();
        }
    }

    protected function post(Request &$req, Response &$res): never
    {
        $req->params->check('title')->checkArray('order');

        $account = $req->account;
        $title = $req->params->get('title');
        $order = $req->params->getAsArray('order');
        $styleIdRaw = $req->params->get('styleId', null, false);
        $styleId = ($styleIdRaw === null || $styleIdRaw === '' || (int)$styleIdRaw === 0) ? null : (int)$styleIdRaw;
        $eventIdRaw = $req->params->get('eventId', null, false);
        $eventId = ($eventIdRaw === null || $eventIdRaw === '' || (int)$eventIdRaw === 0) ? null : (int)$eventIdRaw;
        $eventName = $req->params->get('eventName', null, false);
        // Only touch the event link when the caller actually sent `eventId` — a save that omits it
        // (e.g. a reorder/auto-save) must NOT clear the show's ChurchTools event association.
        $updateEvent = $req->params->provided('eventId');

        // Validate order doesn't contain invalid song numbers
        foreach ($order as $item) {
            if (is_numeric($item) && intval($item) === -1) {
                $res->error(400, 'order contains invalid song number');
            }
        }

        // Store order as JSON to support both legacy and new format
        $orderValue = json_encode($order);
        if ($orderValue === false) {
            $res->error(400, 'Failed to encode order as JSON: ' . json_last_error_msg());
        }

        // Item groups (optional). Stored as a JSON array; null when the caller doesn't send them.
        $groups = $req->params->getAsArray('groups', []);
        $groupsValue = $req->params->provided('groups') ? json_encode($groups) : null;

        // Preserve the existing event link on update unless the caller explicitly sent eventId.
        $eventUpdate = $updateEvent
            ? "`event_id` = VALUES(`event_id`),\n\t\t\t\t\t`event_name` = VALUES(`event_name`),\n\t\t\t\t\t"
            : '';
        // Only overwrite `groups` when the caller sent them (preserve on order-only saves).
        $groupsUpdate = $req->params->provided('groups') ? "`groups` = VALUES(`groups`),
					" : '';
        $stmt = self::prepare("
				INSERT INTO `shows` (
					`account`, `title`, `order`, `groups`, `style_id`, `event_id`, `event_name`
				) VALUES (
					?, ?, ?, ?, ?, ?, ?
				)
				ON DUPLICATE KEY UPDATE
					`order` = VALUES(`order`),
					{$groupsUpdate}`style_id` = VALUES(`style_id`),
					{$eventUpdate}`date` = CURRENT_TIMESTAMP
			");

        $stmt->bind_param('isssiis', $account, $title, $orderValue, $groupsValue, $styleId, $eventId, $eventName)->execute()->close();

        // Same rule as the event link: only rewrite the bands when the caller actually sent
        // them, so an order-only auto-save cannot strip a show of the bands playing it.
        if ($req->params->provided('bandIds')) {
            $this->writeBandIds($account, $title, $req->params->getAsArray('bandIds', []));
        }

        // If the show is linked to a ChurchTools event, reconcile that event's agenda with the
        // show's songs on EVERY save — so add/remove/reorder all stay in sync, not just reassign.
        $eventSync = $this->syncEventAgendaIfLinked($account, $title, $order);

        $res->success([
            'message'   => 'show "' . $title . '" successfully uploaded',
            'eventSync' => $eventSync,
        ]);
    }

    /**
     * Reconcile the linked ChurchTools event's agenda with the show's songs (best-effort — never
     * fails the save). Returns the sync result, or null when the show isn't linked / CT is off.
     */
    private function syncEventAgendaIfLinked(int $account, string $title, array $order): ?array
    {
        // The event link may have been preserved (not sent) — read it from the DB.
        $row = null;
        $stmt = self::prepare('SELECT `event_id` FROM `shows` WHERE `account` = ? AND `title` = ?');
        $stmt->bind_param('is', $account, $title)->execute()->fetchOne($row)->close();
        $eventId = ($row && $row['event_id'] !== null) ? (int)$row['event_id'] : 0;
        if ($eventId <= 0) {
            return null;
        }

        $cfg = $this->getCtConfig($account);
        if ($cfg === null) {
            return null;
        }

        // Song numbers from the show order (items are objects after JSON decode).
        $songNumbers = [];
        foreach ($order as $item) {
            $type = is_object($item) ? ($item->type ?? null) : (is_array($item) ? ($item['type'] ?? null) : null);
            $num  = is_object($item) ? ($item->songNumber ?? null) : (is_array($item) ? ($item['songNumber'] ?? null) : null);
            if ($type === 'song' && $num !== null) {
                $songNumbers[] = (int)$num;
            }
        }

        try {
            $details = $this->fetchSongDetails($account, $songNumbers);
            return ChurchToolsCcli::syncEventAgenda($eventId, $songNumbers, $details, $cfg);
        } catch (\Throwable $e) {
            require_once(__DIR__ . '/../classes/Logging.php');
            Logging::debug('Shows: event agenda sync failed: ' . $e->getMessage());
            return ['ok' => false, 'synced' => 0, 'reason' => 'exception'];
        }
    }

    /** Load title/authors/copyright/ccli_number for the given song numbers, keyed by song number. */
    private function fetchSongDetails(int $account, array $songNumbers): array
    {
        $details = [];
        $nums    = array_values(array_filter(array_map('intval', $songNumbers)));
        if (count($nums) === 0) {
            return $details;
        }
        $placeholders = implode(',', array_fill(0, count($nums), '?'));
        $types        = 'i' . str_repeat('i', count($nums));
        $stmt = self::prepare("SELECT `songnumber`, `title`, `authors`, `copyright`, `ccli_number` FROM `songs` WHERE `account` = ? AND `songnumber` IN ({$placeholders})");
        $stmt->bind_param($types, $account, ...$nums)->execute()->fetchAll($rows)->close();
        foreach ($rows as $r) {
            $details[(int)$r['songnumber']] = $r;
        }
        return $details;
    }

    /** Load the account's ChurchTools config (url + token), or null if not configured. */
    private function getCtConfig(int $account): ?array
    {
        if (!$account) {
            return null;
        }
        $row = null;
        $stmt = self::prepare('SELECT `church_tools_url`, `church_tools_token` FROM `account` WHERE `license` = ?');
        $stmt->bind_param('i', $account)->execute()->fetchOne($row)->close();
        if (!$row || empty($row['church_tools_url']) || empty($row['church_tools_token'])) {
            return null;
        }
        return ['url' => $row['church_tools_url'], 'token' => $row['church_tools_token']];
    }

    protected function delete(Request &$req, Response &$res): never
    {
        $req->params->check('title');

        $account = $req->account;
        $title = $req->params->get('title');

        $stmt = self::prepare('
				DELETE FROM `shows`
				WHERE `account` = ?
				AND `title` = ?
			');

        $stmt->bind_param('is', $account, $title)->execute()->close();

        $res->success([
            'message' => 'show "' . $title . '" successfully deleted'
        ]);
    }
}
