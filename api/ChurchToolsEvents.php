<?php

require_once(__DIR__ . '/RestController.php');
require_once(__DIR__ . '/../config.php');
require_once(__DIR__ . '/../classes/ChurchToolsClient.php');
require_once(__DIR__ . '/../classes/ChurchToolsCcli.php');

/**
 * ChurchToolsEvents — list upcoming ChurchTools events and sync a show's songs to an
 * event's agenda.
 *
 *   GET  /rest/ChurchToolsEvents              → next upcoming events [{ id, name, startDate }]
 *   POST /rest/ChurchToolsEvents/<eventId>/sync  body { songs:[{ ccli, title, author }] }
 *        → lazily creates any missing songs in ChurchTools, then sets the event agenda's
 *          songs to exactly the show's songs (replace).
 */
class ChurchToolsEvents extends RestController
{
    /** Load the account's ChurchTools config (url + token), or null if not configured. */
    private function getCtConfig(): ?array
    {
        $account = $_SESSION['account'] ?? 0;
        if (!$account) {
            return null;
        }
        $stmt = self::prepare('SELECT `church_tools_url`, `church_tools_token` FROM `account` WHERE `license` = ?');
        $stmt->bind_param('i', $account)->execute()->fetchOne($row)->close();
        if (!$row || empty($row['church_tools_url']) || empty($row['church_tools_token'])) {
            return null;
        }
        return ['url' => $row['church_tools_url'], 'token' => $row['church_tools_token']];
    }

    protected function get(Request &$req, Response &$res): never
    {
        $cfg = $this->getCtConfig();
        if ($cfg === null) {
            $res->error(404, 'ChurchTools integration is not configured for this account');
        }

        // Paginated, bidirectional: the client passes from/to + direction to page through past
        // and future events (default: upcoming events from today, forward).
        $limit     = $req->query->getAsInt('limit', 10);
        $direction = $req->query->get('direction', 'forward', false);
        $from      = $req->query->get('from', '', false);
        $to        = $req->query->get('to', '', false);

        $params = [
            'limit'     => $limit > 0 ? $limit : 10,
            'direction' => in_array($direction, ['forward', 'backward'], true) ? $direction : 'forward',
        ];
        if ($from !== '') {
            $params['from'] = $from;
        }
        if ($to !== '') {
            $params['to'] = $to;
        }
        if ($from === '' && $to === '') {
            $params['from'] = date('Y-m-d');
        }
        $data = ChurchToolsClient::get('events', $params, $cfg);

        if ($data === false) {
            $res->error(502, 'Could not reach ChurchTools');
        }

        $events = [];
        foreach (($data['data'] ?? []) as $event) {
            $events[] = [
                'id'        => $event['id'] ?? null,
                'name'      => $event['name'] ?? null,
                'startDate' => $event['startDate'] ?? null,
            ];
        }

        $res->success(['events' => $events]);
    }

    protected function post(Request &$req, Response &$res): never
    {
        $cfg = $this->getCtConfig();
        if ($cfg === null) {
            $res->error(404, 'ChurchTools integration is not configured for this account');
        }

        $eventId = $req->path->getAsInt(0, 0);
        $action  = $req->path->get(1, '');
        if ($eventId === 0 || $action !== 'sync') {
            $res->error(400, 'Expected POST /rest/ChurchToolsEvents/<eventId>/sync');
        }

        // The client sends the show's song numbers (in order); resolve details here, then sync.
        $songNumbers = array_map('intval', $req->params->getAsArray('songNumbers'));
        $details     = self::fetchSongDetails($songNumbers);

        $result = ChurchToolsCcli::syncEventAgenda($eventId, $songNumbers, $details, $cfg);
        if (!$result['ok'] && ($result['reason'] ?? '') === 'unresolved') {
            $res->error(502, 'Could not resolve any CCLI song to a ChurchTools arrangement; agenda left unchanged', true);
        }
        $res->success([
            'message' => 'Synced ' . $result['synced'] . ' song(s) to the event agenda',
            'synced'  => $result['synced'],
            'ok'      => $result['ok'],
        ]);
    }

    /**
     * Load title/authors/copyright/ccli_number for the given song numbers, keyed by song number.
     * Shared with the show-save endpoint (which triggers the same agenda sync).
     *
     * @return array<int,array>
     */
    public static function fetchSongDetails(array $songNumbers): array
    {
        $details = [];
        $songNumbers = array_map('intval', $songNumbers)
            |> array_filter(...)
            |> array_values(...);
        if (count($songNumbers) === 0) {
            return $details;
        }
        $account      = $_SESSION['account'] ?? 0;
        $placeholders = $songNumbers
            |> count(...)
            |> (fn ($x) => array_fill(0, $x, '?'))
            |> (fn ($x) => implode(',', $x));
        $types        = 'i' . str_repeat('i', count($songNumbers));
        $stmt = self::prepare("SELECT `songnumber`, `title`, `authors`, `copyright`, `ccli_number` FROM `songs` WHERE `account` = ? AND `songnumber` IN ({$placeholders})");
        $stmt->bind_param($types, $account, ...$songNumbers)->execute()->fetchAll($rows)->close();
        foreach ($rows as $row) {
            $details[(int)$row['songnumber']] = $row;
        }
        return $details;
    }
}
