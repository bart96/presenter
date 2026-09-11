<?php

require_once(__DIR__ . '/RestController.php');

/**
 * GET  /rest/AdminMigrations         → returns current schema version and list of all migrations
 *                                      with applied status, description, and applied_at timestamp.
 * POST /rest/AdminMigrations         → runs all pending migrations and returns the results.
 *
 * Both methods require admin authentication.
 */
class AdminMigrations extends RestController
{
    protected function get(Request &$req, Response &$res): never
    {
        $this->requireAdmin($res);

        $status = $this->getMigrationStatus();
        $res->success($status);
    }

    protected function post(Request &$req, Response &$res): never
    {
        $this->requireAdmin($res);

        $status = $this->getMigrationStatus();

        if ($status['pendingCount'] === 0) {
            $res->success([
                'message' => 'Database is already up to date.',
                'applied' => [],
                'currentVersion' => $status['currentVersion'],
            ]);
        }

        $applied = [];
        $errors = [];

        $db = self::getConnection();

        foreach ($this->getMigrations() as $version => $migration) {
            if ($version <= $status['currentVersion']) {
                continue;
            }

            $db->begin_transaction();
            try {
                ob_start();
                $migration['up']($db);
                $output = ob_get_clean();

                $stmt = $db->prepare('INSERT INTO `schema_version` (`version`, `description`) VALUES (?, ?)');
                $stmt->bind_param('is', $version, $migration['description']);
                $stmt->execute();
                $stmt->close();

                $db->commit();
                $applied[] = [
                    'version' => $version,
                    'description' => $migration['description'],
                    'output' => trim($output),
                ];
            } catch (Exception $e) {
                ob_end_clean();
                $db->rollback();
                $errors[] = [
                    'version' => $version,
                    'description' => $migration['description'],
                    'error' => $e->getMessage(),
                ];
                break; // Stop on first failure, consistent with migrate.php
            }
        }

        $newStatus = $this->getMigrationStatus();

        $res->success([
            'message' => count($errors) > 0
                ? 'Migration stopped due to an error.'
                : count($applied) . ' migration(s) applied successfully.',
            'applied' => $applied,
            'errors' => $errors,
            'currentVersion' => $newStatus['currentVersion'],
        ]);
    }

    // -------------------------------------------------------------------------

    private function getMigrationStatus(): array
    {
        $db = self::getConnection();

        // Ensure the schema_version table exists
        $db->query("
            CREATE TABLE IF NOT EXISTS `schema_version` (
                `version` INT NOT NULL,
                `description` VARCHAR(500) NOT NULL,
                `applied_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (`version`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        ");

        // Load applied migrations
        $result = $db->query('SELECT `version`, `description`, `applied_at` FROM `schema_version` ORDER BY `version`');
        $appliedMap = [];
        while ($row = $result->fetch_assoc()) {
            $appliedMap[(int)$row['version']] = $row['applied_at'];
        }
        $currentVersion = empty($appliedMap) ? 0 : max(array_keys($appliedMap));

        $allMigrations = $this->getMigrations();
        $migrations = [];
        foreach ($allMigrations as $version => $migration) {
            $migrations[] = [
                'version' => $version,
                'description' => $migration['description'],
                'applied' => isset($appliedMap[$version]),
                'appliedAt' => $appliedMap[$version] ?? null,
            ];
        }

        $pendingCount = count(array_filter($migrations, fn ($m) => !$m['applied']));

        return [
            'currentVersion' => $currentVersion,
            'latestVersion' => empty($allMigrations) ? 0 : max(array_keys($allMigrations)),
            'pendingCount' => $pendingCount,
            'migrations' => $migrations,
        ];
    }

    /** Returns the migrations array (same structure as migrate.php). */
    private function getMigrations(): array
    {
        $db = self::getConnection();

        $tableExists = function (string $table) use ($db): bool {
            $result = $db->query("SHOW TABLES LIKE '{$table}'");
            return $result->num_rows > 0;
        };

        $columnExists = function (string $table, string $column) use ($db): bool {
            $result = $db->query("SHOW COLUMNS FROM `{$table}` LIKE '{$column}'");
            return $result->num_rows > 0;
        };

        $fkExists = function (string $table, string $constraintName) use ($db): bool {
            $dbName = DB['database'];
            $result = $db->query("
                SELECT COUNT(*) AS c FROM information_schema.TABLE_CONSTRAINTS
                WHERE TABLE_SCHEMA = '{$dbName}'
                  AND TABLE_NAME = '{$table}'
                  AND CONSTRAINT_NAME = '{$constraintName}'
                  AND CONSTRAINT_TYPE = 'FOREIGN KEY'
            ");
            return intval($result->fetch_assoc()['c'] ?? 0) > 0;
        };

        return [
            1 => [
                'description' => 'Add styles table and style_window_overrides',
                'up' => function (mysqli $db) use ($tableExists) {
                    if (!$tableExists('styles')) {
                        $db->query("
                            CREATE TABLE `styles` (
                                `id` INT AUTO_INCREMENT PRIMARY KEY,
                                `account` INT NOT NULL,
                                `name` VARCHAR(200) NOT NULL,
                                `enabled` TINYINT(1) DEFAULT 1,
                                `data` JSON NOT NULL,
                                `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                                UNIQUE KEY `uk_styles_account_name` (`account`, `name`),
                                CONSTRAINT `fk_styles_account` FOREIGN KEY (`account`)
                                    REFERENCES `account` (`license`) ON DELETE CASCADE
                            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
                        ");
                        echo "Created table: styles\n";
                    }
                    if (!$tableExists('style_window_overrides')) {
                        $db->query("
                            CREATE TABLE `style_window_overrides` (
                                `id` INT AUTO_INCREMENT PRIMARY KEY,
                                `style_id` INT NOT NULL,
                                `window_name` VARCHAR(200) NOT NULL,
                                `override_style_id` INT NOT NULL,
                                UNIQUE KEY `uk_swo` (`style_id`, `window_name`),
                                CONSTRAINT `fk_swo_style` FOREIGN KEY (`style_id`)
                                    REFERENCES `styles` (`id`) ON DELETE CASCADE,
                                CONSTRAINT `fk_swo_override` FOREIGN KEY (`override_style_id`)
                                    REFERENCES `styles` (`id`) ON DELETE CASCADE
                            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
                        ");
                        echo "Created table: style_window_overrides\n";
                    }
                },
            ],

            2 => [
                'description' => 'Add metrics table',
                'up' => function (mysqli $db) use ($tableExists) {
                    if (!$tableExists('metrics')) {
                        $db->query("
                            CREATE TABLE `metrics` (
                                `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
                                `account` INT NOT NULL,
                                `user_sub` VARCHAR(200) DEFAULT NULL,
                                `event` VARCHAR(100) NOT NULL,
                                `entity_type` VARCHAR(50) DEFAULT NULL,
                                `entity_id` VARCHAR(200) DEFAULT NULL,
                                `metadata` JSON DEFAULT NULL,
                                `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                INDEX `idx_metrics_account` (`account`),
                                INDEX `idx_metrics_event` (`event`),
                                INDEX `idx_metrics_created` (`created_at`),
                                CONSTRAINT `fk_metrics_account` FOREIGN KEY (`account`)
                                    REFERENCES `account` (`license`) ON DELETE CASCADE
                            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
                        ");
                        echo "Created table: metrics\n";
                    }
                },
            ],

            3 => [
                'description' => 'Add show_item_types table',
                'up' => function (mysqli $db) use ($tableExists) {
                    if (!$tableExists('show_item_types')) {
                        $db->query("
                            CREATE TABLE `show_item_types` (
                                `id` INT AUTO_INCREMENT PRIMARY KEY,
                                `account` INT NOT NULL,
                                `type_key` VARCHAR(50) NOT NULL,
                                `label` VARCHAR(100) NOT NULL,
                                `color` VARCHAR(20) NOT NULL DEFAULT '#1976d2',
                                `icon` VARCHAR(50) NOT NULL DEFAULT 'MusicNote',
                                `is_default` TINYINT(1) DEFAULT 0,
                                UNIQUE KEY `uk_sit_account_type` (`account`, `type_key`),
                                CONSTRAINT `fk_sit_account` FOREIGN KEY (`account`)
                                    REFERENCES `account` (`license`) ON DELETE CASCADE
                            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
                        ");
                        echo "Created table: show_item_types\n";
                    }
                },
            ],

            4 => [
                'description' => 'Add new columns to account table',
                'up' => function (mysqli $db) use ($columnExists) {
                    if (!$columnExists('account', 'active')) {
                        $db->query("ALTER TABLE `account` ADD COLUMN `active` TINYINT(1) NOT NULL DEFAULT 1");
                        echo "Added column: account.active\n";
                    }
                    if (!$columnExists('account', 'name')) {
                        $db->query("ALTER TABLE `account` ADD COLUMN `name` VARCHAR(200) DEFAULT NULL");
                        echo "Added column: account.name\n";
                    }
                    if (!$columnExists('account', 'created_at')) {
                        $db->query("ALTER TABLE `account` ADD COLUMN `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP");
                        echo "Added column: account.created_at\n";
                    }
                    if (!$columnExists('account', 'lastactivity')) {
                        $db->query("ALTER TABLE `account` ADD COLUMN `lastactivity` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP");
                        echo "Added column: account.lastactivity\n";
                    }
                    if (!$columnExists('account', 'default_style_id')) {
                        $db->query("ALTER TABLE `account` ADD COLUMN `default_style_id` INT DEFAULT NULL");
                        echo "Added column: account.default_style_id\n";
                    }
                    if (!$columnExists('account', 'default_language')) {
                        $db->query("ALTER TABLE `account` ADD COLUMN `default_language` VARCHAR(10) DEFAULT 'EN'");
                        echo "Added column: account.default_language\n";
                    }
                    if (!$columnExists('account', 'show_title_template')) {
                        $db->query("ALTER TABLE `account` ADD COLUMN `show_title_template` VARCHAR(200) DEFAULT 'Show {dd}.{MM}.{yyyy}'");
                        echo "Added column: account.show_title_template\n";
                    }
                    if (!$columnExists('account', 'window_names')) {
                        $db->query("ALTER TABLE `account` ADD COLUMN `window_names` JSON DEFAULT NULL");
                        echo "Added column: account.window_names\n";
                    }
                    if (!$columnExists('account', 'musician_names')) {
                        $db->query("ALTER TABLE `account` ADD COLUMN `musician_names` JSON DEFAULT NULL");
                        echo "Added column: account.musician_names\n";
                    }
                },
            ],

            5 => [
                'description' => 'Add style_id to songs and shows tables',
                'up' => function (mysqli $db) use ($columnExists) {
                    if (!$columnExists('songs', 'style_id')) {
                        $db->query("ALTER TABLE `songs` ADD COLUMN `style_id` INT DEFAULT NULL");
                        echo "Added column: songs.style_id\n";
                    }
                    if (!$columnExists('songs', 'song_key')) {
                        $db->query("ALTER TABLE `songs` ADD COLUMN `song_key` VARCHAR(10) DEFAULT NULL");
                        echo "Added column: songs.song_key\n";
                    }
                    if (!$columnExists('songs', 'ccli_number')) {
                        $db->query("ALTER TABLE `songs` ADD COLUMN `ccli_number` VARCHAR(50) DEFAULT NULL");
                        echo "Added column: songs.ccli_number\n";
                    }
                    if (!$columnExists('shows', 'style_id')) {
                        $db->query("ALTER TABLE `shows` ADD COLUMN `style_id` INT DEFAULT NULL");
                        echo "Added column: shows.style_id\n";
                    }
                },
            ],

            6 => [
                'description' => 'Add OIDC providers tables',
                'up' => function (mysqli $db) use ($tableExists) {
                    if (!$tableExists('oidc_providers')) {
                        $db->query("
                            CREATE TABLE `oidc_providers` (
                                `id` INT(11) NOT NULL AUTO_INCREMENT,
                                `name` VARCHAR(200) NOT NULL,
                                `discovery_url` VARCHAR(500) NOT NULL,
                                `client_id` VARCHAR(300) NOT NULL,
                                `client_secret` VARCHAR(300) NOT NULL,
                                `scopes` VARCHAR(300) NOT NULL DEFAULT 'openid email profile',
                                `required_group` VARCHAR(200) DEFAULT NULL,
                                `enabled` TINYINT(1) NOT NULL DEFAULT 1,
                                `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                                PRIMARY KEY (`id`),
                                UNIQUE KEY `uk_oidc_providers_name` (`name`)
                            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
                        ");
                        echo "Created table: oidc_providers\n";
                    }
                    if (!$tableExists('account_oidc_providers')) {
                        $db->query("
                            CREATE TABLE `account_oidc_providers` (
                                `license` INT(11) NOT NULL,
                                `provider_id` INT(11) NOT NULL,
                                `is_default` TINYINT(1) NOT NULL DEFAULT 0,
                                PRIMARY KEY (`license`, `provider_id`),
                                KEY `fk_aop_provider` (`provider_id`),
                                CONSTRAINT `fk_aop_account` FOREIGN KEY (`license`) REFERENCES `account` (`license`) ON DELETE CASCADE,
                                CONSTRAINT `fk_aop_provider` FOREIGN KEY (`provider_id`) REFERENCES `oidc_providers` (`id`) ON DELETE CASCADE
                            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
                        ");
                        echo "Created table: account_oidc_providers\n";
                    }
                },
            ],

            7 => [
                'description' => 'Insert default show_item_types for existing accounts',
                'up' => function (mysqli $db) {
                    $result = $db->query('SELECT `license` FROM `account`');
                    while ($row = $result->fetch_assoc()) {
                        $license = intval($row['license']);
                        $check = $db->query("SELECT COUNT(*) AS c FROM `show_item_types` WHERE `account` = {$license}");
                        $count = intval($check->fetch_assoc()['c']);
                        if ($count === 0) {
                            $db->query("INSERT INTO `show_item_types` (`account`, `type_key`, `label`, `color`, `icon`, `is_default`) VALUES
                                ({$license}, 'song', 'Song', '#1976d2', 'MusicNote', 1),
                                ({$license}, 'media', 'Media', '#f9a825', 'Image', 1),
                                ({$license}, 'bible_verse', 'Bible Verse', '#388e3c', 'MenuBook', 1)
                            ");
                            echo "Inserted default show_item_types for account {$license}\n";
                        }
                    }
                },
            ],

            8 => [
                'description' => 'Migrate songs.order from comma-separated to JSON orders map',
                'up' => function (mysqli $db) {
                    $result = $db->query("SHOW COLUMNS FROM `songs` LIKE 'order'");
                    if ($result->num_rows === 0) {
                        echo "No 'order' column in songs — skipping.\n";
                        return;
                    }
                    $col = $result->fetch_assoc();
                    $colType = strtolower($col['Type'] ?? '');
                    if (strpos($colType, 'json') !== false) {
                        echo "songs.order is already JSON — skipping.\n";
                        return;
                    }

                    $songs = $db->query('SELECT `account`, `songnumber`, `order` FROM `songs`');
                    $converted = 0;
                    while ($row = $songs->fetch_assoc()) {
                        $oldOrder = $row['order'] ?? '';
                        if (empty($oldOrder)) {
                            continue;
                        }
                        $parsed = json_decode($oldOrder, true);
                        if (is_array($parsed) && isset($parsed['Default'])) {
                            continue;
                        }
                        $blockNames = array_filter(array_map('trim', explode(',', $oldOrder)), fn ($b) => $b !== '');
                        $newOrders = json_encode(['Default' => array_values($blockNames)]);
                        $stmt = $db->prepare('UPDATE `songs` SET `order` = ? WHERE `account` = ? AND `songnumber` = ?');
                        $stmt->bind_param('sii', $newOrders, $row['account'], $row['songnumber']);
                        $stmt->execute();
                        $stmt->close();
                        $converted++;
                    }
                    echo "Converted {$converted} songs.order entries.\n";
                    $db->query("UPDATE `songs` SET `order` = '{\"Default\":[]}' WHERE `order` IS NULL OR TRIM(`order`) = ''");
                    $db->query('ALTER TABLE `songs` MODIFY COLUMN `order` JSON NOT NULL');
                    echo "Changed songs.order column type to JSON.\n";
                },
            ],

            9 => [
                'description' => 'Migrate shows.order from number array to typed ShowItem array',
                'up' => function (mysqli $db) {
                    $colResult = $db->query("SHOW COLUMNS FROM `shows` LIKE 'order'");
                    if ($colResult->num_rows === 0) {
                        echo "No 'order' column in shows — skipping.\n";
                        return;
                    }
                    $colInfo = $colResult->fetch_assoc();
                    $colType = strtolower($colInfo['Type'] ?? '');
                    $isAlreadyJson = (strpos($colType, 'json') !== false);

                    $shows = $db->query("SELECT `account`, `title`, CAST(`order` AS CHAR) AS `order_raw` FROM `shows`");
                    if (!$shows) {
                        throw new Exception('Failed to read shows: ' . $db->error);
                    }
                    $converted = 0;
                    while ($row = $shows->fetch_assoc()) {
                        $oldOrder = trim($row['order_raw'] ?? '');
                        $account = intval($row['account']);
                        $title = $row['title'];
                        if (empty($oldOrder)) {
                            $s = $db->prepare("UPDATE `shows` SET `order` = '[]' WHERE `account` = ? AND `title` = ?");
                            $s->bind_param('is', $account, $title);
                            $s->execute();
                            $s->close();
                            continue;
                        }
                        $parsed = json_decode($oldOrder, true);
                        if (is_array($parsed) && count($parsed) > 0 && isset($parsed[0]['type'])) {
                            continue;
                        }
                        if (is_array($parsed) && count($parsed) === 0) {
                            continue;
                        }
                        $numbers = [];
                        if (is_array($parsed) && count($parsed) > 0) {
                            $numbers = $parsed;
                        } else {
                            $trimmed = trim($oldOrder, " \t\n\r\0\x0B\"'");
                            if (preg_match('/^\d+(\s*,\s*\d+)*$/', $trimmed)) {
                                $numbers = array_map('trim', explode(',', $trimmed));
                            }
                        }
                        $newOrder = [];
                        foreach ($numbers as $num) {
                            if (is_numeric($num) && $num !== '') {
                                $newOrder[] = ['type' => 'song', 'songNumber' => intval($num), 'order' => 'Default'];
                            }
                        }
                        $newJson = json_encode($newOrder);
                        $s = $db->prepare("UPDATE `shows` SET `order` = ? WHERE `account` = ? AND `title` = ?");
                        $s->bind_param('sis', $newJson, $account, $title);
                        $s->execute();
                        $s->close();
                        $converted++;
                    }
                    echo "Converted {$converted} shows.order entries.\n";
                    if (!$isAlreadyJson) {
                        $db->query("UPDATE `shows` SET `order` = '[]' WHERE `order` IS NULL OR TRIM(CAST(`order` AS CHAR)) = ''");
                        $db->query('ALTER TABLE `shows` MODIFY COLUMN `order` JSON NOT NULL');
                        if ($db->error) {
                            throw new Exception('ALTER TABLE failed: ' . $db->error);
                        }
                        echo "Changed shows.order column type to JSON.\n";
                    }
                },
            ],

            10 => [
                'description' => 'Add FK constraints for style_id on account, songs, shows',
                'up' => function (mysqli $db) use ($fkExists) {
                    if (!$fkExists('account', 'fk_account_style')) {
                        $db->query("ALTER TABLE `account` ADD CONSTRAINT `fk_account_style` FOREIGN KEY (`default_style_id`) REFERENCES `styles` (`id`) ON DELETE SET NULL");
                        echo "Added FK: account.fk_account_style\n";
                    }
                    if (!$fkExists('songs', 'fk_songs_style')) {
                        $db->query("ALTER TABLE `songs` ADD CONSTRAINT `fk_songs_style` FOREIGN KEY (`style_id`) REFERENCES `styles` (`id`) ON DELETE SET NULL");
                        echo "Added FK: songs.fk_songs_style\n";
                    }
                    if (!$fkExists('shows', 'fk_shows_style')) {
                        $db->query("ALTER TABLE `shows` ADD CONSTRAINT `fk_shows_style` FOREIGN KEY (`style_id`) REFERENCES `styles` (`id`) ON DELETE SET NULL");
                        echo "Added FK: shows.fk_shows_style\n";
                    }
                },
            ],

            11 => [
                'description' => 'Fix blocks table FK to reference songs instead of account',
                'up' => function (mysqli $db) use ($fkExists) {
                    if ($fkExists('blocks', 'fk_blocks_account')) {
                        $db->query('ALTER TABLE `blocks` DROP FOREIGN KEY `fk_blocks_account`');
                        echo "Dropped FK: blocks.fk_blocks_account\n";
                    }
                    if (!$fkExists('blocks', 'fk_blocks_song')) {
                        $db->query("ALTER TABLE `blocks` ADD CONSTRAINT `fk_blocks_song` FOREIGN KEY (`account`, `songnumber`) REFERENCES `songs` (`account`, `songnumber`) ON DELETE CASCADE");
                        echo "Added FK: blocks.fk_blocks_song\n";
                    }
                },
            ],

            12 => [
                'description' => 'Add pdf_area_mappings table for storing block-to-PDF-region mappings',
                'up' => function (mysqli $db) use ($tableExists) {
                    if (!$tableExists('pdf_area_mappings')) {
                        $db->query("
                            CREATE TABLE `pdf_area_mappings` (
                                `id` INT AUTO_INCREMENT PRIMARY KEY,
                                `account` INT NOT NULL,
                                `songnumber` INT NOT NULL,
                                `filename` VARCHAR(300) NOT NULL,
                                `musician_name` VARCHAR(200) NOT NULL DEFAULT '_',
                                `mappings` JSON NOT NULL,
                                `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                                UNIQUE KEY `uk_pam` (`account`, `songnumber`, `filename`, `musician_name`),
                                CONSTRAINT `fk_pam_account` FOREIGN KEY (`account`)
                                    REFERENCES `account` (`license`) ON DELETE CASCADE
                            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
                        ");
                        echo "Created table: pdf_area_mappings\n";
                    }
                },
            ],

            13 => [
                'description' => 'Add pdf_annotations table (one-row-per-annotation with normalized columns)',
                'up' => function (mysqli $db) use ($tableExists) {
                    $db->query('DROP TABLE IF EXISTS `pdf_annotations`');
                    $db->query("
                        CREATE TABLE `pdf_annotations` (
                            `id` INT AUTO_INCREMENT PRIMARY KEY,
                            `account` INT NOT NULL,
                            `songnumber` INT NOT NULL,
                            `filename` VARCHAR(300) NOT NULL,
                            `layer` VARCHAR(200) NOT NULL,
                            `tool` VARCHAR(20) NOT NULL,
                            `page` INT NOT NULL,
                            `x` DOUBLE NOT NULL,
                            `y` DOUBLE NOT NULL,
                            `color` VARCHAR(20) NOT NULL DEFAULT '#ff0000',
                            `opacity` DOUBLE NOT NULL DEFAULT 1.0,
                            `sort_order` INT NOT NULL DEFAULT 0,
                            `data` JSON NOT NULL,
                            `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            INDEX `idx_pa_layer_order` (`account`, `songnumber`, `filename`, `layer`, `sort_order`),
                            CONSTRAINT `fk_pa_account` FOREIGN KEY (`account`)
                                REFERENCES `account` (`license`) ON DELETE CASCADE
                        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
                    ");
                    echo "Created table: pdf_annotations\n";
                },
            ],

            14 => [
                'description' => 'Add ChurchTools per-account configuration columns',
                'up' => function (mysqli $db) use ($columnExists) {
                    if (!$columnExists('account', 'church_tools_url')) {
                        $db->query("ALTER TABLE `account` ADD COLUMN `church_tools_url` VARCHAR(500) DEFAULT NULL");
                        echo "Added column: account.church_tools_url\n";
                    }
                    if (!$columnExists('account', 'church_tools_token')) {
                        $db->query("ALTER TABLE `account` ADD COLUMN `church_tools_token` VARCHAR(500) DEFAULT NULL");
                        echo "Added column: account.church_tools_token\n";
                    }
                },
            ],

            15 => [
                'description' => 'Add viewer_token column to account table for standalone viewer access',
                'up' => function (mysqli $db) use ($columnExists) {
                    if (!$columnExists('account', 'viewer_token')) {
                        $db->query("ALTER TABLE `account` ADD COLUMN `viewer_token` VARCHAR(64) DEFAULT NULL");
                        echo "Added column: account.viewer_token\n";
                        $db->query("ALTER TABLE `account` ADD UNIQUE KEY `uk_account_viewer_token` (`viewer_token`)");
                        echo "Added unique index: uk_account_viewer_token\n";
                    }
                },
            ],

            16 => [
                'description' => 'Link shows to a ChurchTools event for agenda sync',
                'up' => function (mysqli $db) use ($columnExists) {
                    if (!$columnExists('shows', 'event_id')) {
                        $db->query("ALTER TABLE `shows` ADD COLUMN `event_id` INT DEFAULT NULL");
                        echo "Added column: shows.event_id\n";
                    }
                    if (!$columnExists('shows', 'event_name')) {
                        $db->query("ALTER TABLE `shows` ADD COLUMN `event_name` VARCHAR(255) DEFAULT NULL");
                        echo "Added column: shows.event_name\n";
                    }
                },
            ],

            17 => [
                'description' => 'Add shows.groups column for item groups',
                'up' => function (mysqli $db) use ($columnExists) {
                    if (!$columnExists('shows', 'groups')) {
                        $db->query("ALTER TABLE `shows` ADD COLUMN `groups` JSON DEFAULT NULL");
                        echo "Added column: shows.groups\n";
                    }
                },
            ],

            18 => [
                'description' => 'Add songs.updated_at column for song change detection',
                'up' => function (mysqli $db) use ($columnExists) {
                    if (!$columnExists('songs', 'updated_at')) {
                        $db->query("ALTER TABLE `songs` ADD COLUMN `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");
                        echo "Added column: songs.updated_at\n";
                    }
                },
            ],

            19 => [
                'description' => 'Add set_lists, set_list_entries and set_list_entry_tags tables',
                'up' => function (mysqli $db) use ($tableExists) {
                    if (!$tableExists('set_lists')) {
                        $db->query("
                            CREATE TABLE `set_lists` (
                                `id` INT AUTO_INCREMENT PRIMARY KEY,
                                `account` INT NOT NULL,
                                `name` VARCHAR(200) NOT NULL,
                                `sort_order` INT NOT NULL DEFAULT 0,
                                `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                                UNIQUE KEY `uk_set_lists_account_name` (`account`, `name`),
                                CONSTRAINT `fk_set_lists_account` FOREIGN KEY (`account`)
                                    REFERENCES `account` (`license`) ON DELETE CASCADE
                            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
                        ");
                        echo "Created table: set_lists\n";
                    }
                    if (!$tableExists('set_list_entries')) {
                        // `account` is carried here so the row can point at the composite
                        // songs(account, songnumber) key — a deleted song takes its set list
                        // entries with it. Renumbering moves these rows (see SongRenumber).
                        $db->query("
                            CREATE TABLE `set_list_entries` (
                                `id` INT AUTO_INCREMENT PRIMARY KEY,
                                `set_list_id` INT NOT NULL,
                                `account` INT NOT NULL,
                                `songnumber` INT NOT NULL,
                                `sort_order` INT NOT NULL DEFAULT 0,
                                `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                                UNIQUE KEY `uk_sle_list_song` (`set_list_id`, `songnumber`),
                                KEY `idx_sle_song` (`account`, `songnumber`),
                                CONSTRAINT `fk_sle_set_list` FOREIGN KEY (`set_list_id`)
                                    REFERENCES `set_lists` (`id`) ON DELETE CASCADE,
                                CONSTRAINT `fk_sle_song` FOREIGN KEY (`account`, `songnumber`)
                                    REFERENCES `songs` (`account`, `songnumber`) ON DELETE CASCADE
                            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
                        ");
                        echo "Created table: set_list_entries\n";
                    }
                    if (!$tableExists('set_list_entry_tags')) {
                        // One row per Tag Assignment: (entry, tag) is unique, and the playback
                        // metadata (key / block order name) hangs off the assignment, not the entry.
                        $db->query("
                            CREATE TABLE `set_list_entry_tags` (
                                `id` INT AUTO_INCREMENT PRIMARY KEY,
                                `set_list_entry_id` INT NOT NULL,
                                `tag_name` VARCHAR(100) NOT NULL,
                                `custom_key` VARCHAR(20) DEFAULT NULL,
                                `block_order_name` VARCHAR(200) DEFAULT NULL,
                                `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                                UNIQUE KEY `uk_slet_entry_tag` (`set_list_entry_id`, `tag_name`),
                                CONSTRAINT `fk_slet_entry` FOREIGN KEY (`set_list_entry_id`)
                                    REFERENCES `set_list_entries` (`id`) ON DELETE CASCADE
                            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
                        ");
                        echo "Created table: set_list_entry_tags\n";
                    }
                },
            ],

            20 => [
                'description' => 'Make pdf_area_mappings per PDF file instead of per musician',
                'up' => function (mysqli $db) use ($tableExists, $columnExists) {
                    if (!$tableExists('pdf_area_mappings') || !$columnExists('pdf_area_mappings', 'musician_name')) {
                        return;
                    }
                    // The mapped regions describe the PDF itself, so every musician looking at
                    // the same file needs the same ones. Collapse the per-musician rows, keeping
                    // the most recently updated one for each (account, songnumber, filename).
                    $db->query('
                        DELETE pam FROM `pdf_area_mappings` pam
                        JOIN `pdf_area_mappings` keep
                          ON  keep.`account`    = pam.`account`
                          AND keep.`songnumber` = pam.`songnumber`
                          AND keep.`filename`   = pam.`filename`
                          AND (keep.`updated_at` > pam.`updated_at`
                               OR (keep.`updated_at` = pam.`updated_at` AND keep.`id` > pam.`id`))
                    ');
                    echo 'Collapsed duplicate area mappings: ' . $db->affected_rows . " row(s) removed\n";

                    $indexExists = function (string $index) use ($db): bool {
                        $r = $db->query("SHOW INDEX FROM `pdf_area_mappings` WHERE Key_name = '{$index}'");
                        return $r->num_rows > 0;
                    };

                    // DDL implicitly commits, so each step is guarded: a re-run after a
                    // partial failure picks up where it stopped instead of erroring out.
                    // `uk_pam` is the leftmost index on `account`, so it is what satisfies
                    // fk_pam_account — without a stand-in, dropping it fails with errno 1553.
                    if (!$indexExists('idx_pam_account')) {
                        $db->query('ALTER TABLE `pdf_area_mappings` ADD INDEX `idx_pam_account` (`account`)');
                    }
                    if ($indexExists('uk_pam')) {
                        $db->query('ALTER TABLE `pdf_area_mappings` DROP INDEX `uk_pam`');
                    }
                    $db->query('ALTER TABLE `pdf_area_mappings` DROP COLUMN `musician_name`');
                    if (!$indexExists('uk_pam')) {
                        $db->query('ALTER TABLE `pdf_area_mappings` ADD UNIQUE KEY `uk_pam` (`account`, `songnumber`, `filename`)');
                    }
                    // The new uk_pam is leftmost on `account` and takes the FK over again.
                    try {
                        $db->query('ALTER TABLE `pdf_area_mappings` DROP INDEX `idx_pam_account`');
                    } catch (\Throwable $e) {
                        echo "Kept helper index idx_pam_account: " . $e->getMessage() . "\n";
                    }
                    echo "pdf_area_mappings is now keyed by (account, songnumber, filename)\n";
                },
            ],

            21 => [
                'description' => 'Language lists per song and account, and slot-based language styles',
                'up' => function (mysqli $db) use ($columnExists, $tableExists) {
                    // Per song: the ordered list of languages, first entry being the default.
                    // A style's language slots are positions in this list, so the order is what
                    // decides which language a design's "second language" actually styles.
                    if (!$columnExists('songs', 'languages')) {
                        $db->query('ALTER TABLE `songs` ADD COLUMN `languages` JSON DEFAULT NULL');
                        echo "Added column: songs.languages\n";
                    }
                    // Per account: the pool every song picks from.
                    if (!$columnExists('account', 'languages')) {
                        $db->query('ALTER TABLE `account` ADD COLUMN `languages` JSON DEFAULT NULL');
                        echo "Added column: account.languages\n";
                    }

                    if (!$tableExists('styles')) {
                        return;
                    }

                    // Styles used to name languages outright ("lines tagged DE look like this"),
                    // which only works while every song uses the same languages in the same
                    // roles. They now describe positions instead, so one design fits a
                    // German-with-English song and an English-with-German one alike.
                    //
                    // The old list was already stored in display order with the default entry
                    // first, so position *is* the conversion: default -> slot 1, then 2, 3, …
                    $result = $db->query('SELECT `id`, `data` FROM `styles`');
                    $converted = 0;

                    while ($row = $result->fetch_assoc()) {
                        $data = json_decode($row['data'], true);

                        if (!is_array($data)) {
                            continue;
                        }

                        $changed = false;

                        // Fields of the named-language model that nothing ever read.
                        foreach (['showLanguages', 'primaryLanguage', 'translationColor'] as $dead) {
                            if (array_key_exists($dead, $data)) {
                                unset($data[$dead]);
                                $changed = true;
                            }
                        }

                        $entries = $data['languageStyles']['value'] ?? null;

                        if (is_array($entries)) {
                            $next = 2;
                            $rewritten = [];

                            foreach ($entries as $entry) {
                                if (!is_array($entry)) {
                                    continue;
                                }
                                // Already converted (a re-run, or a style saved by a new client).
                                if (array_key_exists('slot', $entry)) {
                                    $rewritten[] = $entry;
                                    continue;
                                }

                                $language = $entry['language'] ?? '';
                                unset($entry['language']);
                                $entry['slot'] = $language === '' ? 1 : $next++;
                                $rewritten[] = $entry;
                                $changed = true;
                            }

                            if ($changed) {
                                $data['languageStyles']['value'] = $rewritten;
                            }
                        }

                        if (!$changed) {
                            continue;
                        }

                        $encoded = json_encode($data);
                        $stmt = $db->prepare('UPDATE `styles` SET `data` = ? WHERE `id` = ?');
                        $stmt->bind_param('si', $encoded, $row['id']);
                        $stmt->execute();
                        $stmt->close();
                        $converted++;
                    }

                    echo "Converted {$converted} style(s) to language slots\n";
                },
            ],

            22 => [
                'description' => 'Add stage_layers table for the stage monitor cue system',
                'up' => function (mysqli $db) use ($tableExists) {
                    if ($tableExists('stage_layers')) {
                        return;
                    }
                    // A layer is a placed band on the presentation output holding an ordered
                    // list of cues (clock / countdown / count-up / message). The cues live in
                    // `data` rather than a table of their own: they are only ever read and
                    // written as a whole layer, exactly like `styles`.`data`.
                    $db->query("
                        CREATE TABLE `stage_layers` (
                            `id` INT AUTO_INCREMENT PRIMARY KEY,
                            `account` INT NOT NULL,
                            `name` VARCHAR(200) NOT NULL,
                            `enabled` TINYINT(1) DEFAULT 1,
                            `sort_order` INT NOT NULL DEFAULT 0,
                            `data` JSON NOT NULL,
                            `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                            UNIQUE KEY `uk_stage_layers_account_name` (`account`, `name`),
                            CONSTRAINT `fk_stage_layers_account` FOREIGN KEY (`account`)
                                REFERENCES `account` (`license`) ON DELETE CASCADE
                        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
                    ");
                    echo "Created table: stage_layers\n";
                },
            ],

            23 => [
                'description' => 'Add bands and their assignment to shows and set lists',
                'up' => function (mysqli $db) use ($tableExists) {
                    // A band is the group of people that plays a show. Until now one only
                    // existed implicitly, as the name of a song order ("Youth Band [G]"),
                    // so it could not be named, coloured or listed anywhere on its own.
                    if (!$tableExists('bands')) {
                        $db->query("
                            CREATE TABLE `bands` (
                                `id` INT AUTO_INCREMENT PRIMARY KEY,
                                `account` INT NOT NULL,
                                `name` VARCHAR(200) NOT NULL,
                                `color` VARCHAR(20) DEFAULT NULL,
                                `members` JSON DEFAULT NULL,
                                `sort_order` INT NOT NULL DEFAULT 0,
                                `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                                UNIQUE KEY `uk_bands_account_name` (`account`, `name`),
                                CONSTRAINT `fk_bands_account` FOREIGN KEY (`account`)
                                    REFERENCES `account` (`license`) ON DELETE CASCADE
                            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
                        ");
                        echo "Created table: bands\n";
                    }

                    // Several bands can share one show or one set list, so the assignment is
                    // a join table. Both sides cascade: dropping a band takes its assignments
                    // with it and leaves the shows themselves untouched.
                    if (!$tableExists('show_bands')) {
                        $db->query("
                            CREATE TABLE `show_bands` (
                                `account` INT NOT NULL,
                                `show_title` VARCHAR(200) NOT NULL,
                                `band_id` INT NOT NULL,
                                PRIMARY KEY (`account`, `show_title`, `band_id`),
                                KEY `idx_show_bands_band` (`band_id`),
                                CONSTRAINT `fk_show_bands_show` FOREIGN KEY (`account`, `show_title`)
                                    REFERENCES `shows` (`account`, `title`) ON DELETE CASCADE,
                                CONSTRAINT `fk_show_bands_band` FOREIGN KEY (`band_id`)
                                    REFERENCES `bands` (`id`) ON DELETE CASCADE
                            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
                        ");
                        echo "Created table: show_bands\n";
                    }

                    if ($tableExists('set_lists') && !$tableExists('set_list_bands')) {
                        $db->query("
                            CREATE TABLE `set_list_bands` (
                                `set_list_id` INT NOT NULL,
                                `band_id` INT NOT NULL,
                                PRIMARY KEY (`set_list_id`, `band_id`),
                                KEY `idx_set_list_bands_band` (`band_id`),
                                CONSTRAINT `fk_slb_set_list` FOREIGN KEY (`set_list_id`)
                                    REFERENCES `set_lists` (`id`) ON DELETE CASCADE,
                                CONSTRAINT `fk_slb_band` FOREIGN KEY (`band_id`)
                                    REFERENCES `bands` (`id`) ON DELETE CASCADE
                            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
                        ");
                        echo "Created table: set_list_bands\n";
                    }
                },
            ],
        ];
    }
}
