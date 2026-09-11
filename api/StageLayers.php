<?php

require_once(__DIR__ . '/RestController.php');

/**
 * Stage-monitor layers.
 *
 * A layer is a placed band on the presentation output ("Timer" bottom-centre, "Clock"
 * top-right) holding an ordered list of cues. Structurally this is `Styles` with a
 * `sort_order`: one JSON `data` blob per row, account-scoped, read and written whole.
 * The cues do not get a table of their own because nothing ever queries an individual
 * cue — the editor loads a layer and saves a layer.
 *
 * GET    /rest/StageLayers        → all layers for the account, in operator order
 * GET    /rest/StageLayers/{id}   → one layer
 * POST   /rest/StageLayers        → create
 * PUT    /rest/StageLayers/{id}   → update (partial)
 * DELETE /rest/StageLayers/{id}   → delete
 */
class StageLayers extends RestController
{
    protected function get(Request &$req, Response &$res): never
    {
        $account = $req->account;
        $idRaw = $req->path->get(0, null, false);

        if (is_numeric($idRaw)) {
            $this->handleGetSingleLayer($res, $account, intval($idRaw));
        }

        $this->handleListLayers($res, $account);
    }

    private function handleGetSingleLayer(Response &$res, int $account, int $id): never
    {
        $stmt = self::prepare('
				SELECT `id`, `name`, `enabled`, `sort_order`, `data`, `created_at`, `updated_at`
				FROM `stage_layers`
				WHERE `id` = ? AND `account` = ?
			');
        $stmt->bind_param('ii', $id, $account)->execute()->fetchOne($layer)->close();

        if (!$layer) {
            $res->error(404, 'Stage layer not found');
        }

        $res->success($this->hydrate($layer));
    }

    private function handleListLayers(Response &$res, int $account): never
    {
        // Ordered by sort_order, then name so a set of layers created in one go (all
        // sort_order 0) still comes back in a stable, meaningful order.
        $stmt = self::prepare('
				SELECT `id`, `name`, `enabled`, `sort_order`, `data`, `created_at`, `updated_at`
				FROM `stage_layers`
				WHERE `account` = ?
				ORDER BY `sort_order`, `name`
			');
        $stmt->bind_param('i', $account)->execute()->fetchAll($layers)->close();

        foreach ($layers as &$layer) {
            $layer = $this->hydrate($layer);
        }

        $res->success($layers);
    }

    /** Normalise a row for the client: real types, and `data` as an object. */
    private function hydrate(array $layer): array
    {
        $layer['id'] = (int)$layer['id'];
        $layer['enabled'] = (bool)$layer['enabled'];
        $layer['sort_order'] = (int)$layer['sort_order'];
        $layer['data'] = json_decode($layer['data'], true) ?: [];
        return $layer;
    }

    protected function post(Request &$req, Response &$res): never
    {
        $req->params->check('name', 'data');

        $account = $req->account;
        $name = $req->params->get('name');
        $enabled = $req->params->getAsBool('enabled', true) ? 1 : 0;
        $sortOrder = intval($req->params->get('sort_order', 0, false) ?? 0);
        $data = json_encode($req->params->getAsObject('data'));

        $stmt = self::prepare('
				INSERT INTO `stage_layers` (`account`, `name`, `enabled`, `sort_order`, `data`)
				VALUES (?, ?, ?, ?, ?)
			');
        $stmt->bind_param('isiis', $account, $name, $enabled, $sortOrder, $data)->execute()->id($id)->close();

        $res->success([
            'id' => $id,
            'name' => $name,
            'enabled' => (bool)$enabled,
            'sort_order' => $sortOrder,
            'message' => 'Stage layer created'
        ]);
    }

    protected function put(Request &$req, Response &$res): never
    {
        $req->path->checkNumeric(0);
        $id = $req->path->getAsInt(0);
        $account = $req->account;

        // Partial update: only the fields actually sent are touched, so saving a cue list
        // does not have to round-trip the name and placement as well.
        $fields = [];
        $types = '';
        $values = [];

        $nameRaw = $req->params->get('name', null, false);
        if ($nameRaw !== null) {
            $fields[] = '`name` = ?';
            $types .= 's';
            $values[] = $nameRaw;
        }

        $enabledRaw = $req->params->get('enabled', null, false);
        if ($enabledRaw !== null) {
            $fields[] = '`enabled` = ?';
            $types .= 'i';
            $values[] = $enabledRaw ? 1 : 0;
        }

        $sortRaw = $req->params->get('sort_order', null, false);
        if ($sortRaw !== null) {
            $fields[] = '`sort_order` = ?';
            $types .= 'i';
            $values[] = intval($sortRaw);
        }

        $dataRaw = $req->params->get('data', null, false);
        if ($dataRaw !== null) {
            $fields[] = '`data` = ?';
            $types .= 's';
            $values[] = json_encode($dataRaw);
        }

        if (count($fields) > 0) {
            $sql = 'UPDATE `stage_layers` SET ' . implode(', ', $fields) . ' WHERE `id` = ? AND `account` = ?';
            $types .= 'ii';
            $values[] = $id;
            $values[] = $account;

            $stmt = self::prepare($sql);
            $stmt->bind_param($types, ...$values)->execute()->close();
        }

        $res->success(['message' => 'Stage layer updated', 'id' => $id]);
    }

    protected function delete(Request &$req, Response &$res): never
    {
        $req->path->checkNumeric(0);
        $id = $req->path->getAsInt(0);
        $account = $req->account;

        $stmt = self::prepare('
				DELETE FROM `stage_layers`
				WHERE `id` = ? AND `account` = ?
			');
        $stmt->bind_param('ii', $id, $account)->execute()->close();

        $res->success(['message' => 'Stage layer deleted']);
    }
}
