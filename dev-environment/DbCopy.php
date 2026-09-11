<?php

// This file lives in `dev-environment/` in the repo and in `api/` once deployed, so
// every path below is resolved against the app root one level up — the same in both.
//
// api/utils.php refuses to load unless API is defined, which rest.php does before anything
// else. The CLI entry point at the bottom is a second, legitimate caller, so declare the
// same value here; under rest.php this is already defined and does nothing.
if (!defined('API')) {
    define('API', dirname(__DIR__) . '/api/');
}

require_once(dirname(__DIR__) . '/api/RestController.php');

/**
 * Copy another deployment's database into this one.
 *
 * GET  /rest/DbCopy → what a copy would do: source, target, per-table row counts,
 *                     the URL rewrites that would be applied.
 * POST /rest/DbCopy → run it. Body: { dryRun?: bool, tables?: string[] }
 *
 * Both require admin authentication.
 *
 * ── Dev only ────────────────────────────────────────────────────────────────────────────
 * This file lives in `dev-environment/`, outside `api/`, so no production build can pick
 * it up — `npm run build:web:dev` is the only thing that copies it into `dist-dev/api/`.
 * Even there it stays inert until someone puts a `copy.config.php` next to `config.php`,
 * so a stray upload cannot expose it. `/rest/DbCopy` 404s wherever the file is absent.
 *
 * To work on it locally, copy it into `api/` (gitignored there) — see
 * dev-environment/README.md.
 *
 * The SOURCE comes from copy.config.php; the TARGET is always this deployment's own
 * database, taken from config.php. There is no configuration that could make this write
 * to production.
 *
 * It also runs from the command line, which is the better option for a large database —
 * no HTTP timeout, and progress as it goes:
 *
 *   php DbCopy.php --dry-run
 *   php DbCopy.php --yes
 *   php DbCopy.php --yes --tables=songs,blocks
 */
class DbCopy extends RestController
{
    private const DEFAULTS = [
        'source_url'            => '',
        'target_url'            => '',
        'source_db'             => [],
        'exclude_tables'        => [],
        'structure_only_tables' => [],
        'replace_urls'          => true,
        'replace_bare_host'     => false,
        'skip_columns'          => [],
        'extra_replacements'    => [],
        'batch_size'            => 500,
        'data_dir'              => [],
    ];

    private const TEXT_TYPES = "'char','varchar','tinytext','text','mediumtext','longtext','json'";

    // ── REST ────────────────────────────────────────────────────────────────────────────

    protected function get(Request &$req, Response &$res): never
    {
        $this->requireAdmin($res);

        $config = self::config();
        $source = self::connectSource($config);

        $res->success([
            'source' => [
                'url'           => $config['source_url'],
                'host'          => $config['source_db']['host'],
                'database'      => $config['source_db']['database'],
                'schemaVersion' => self::schemaVersion($source),
            ],
            'target' => [
                'url'           => self::targetUrl($config),
                'host'          => DB['host'],
                'database'      => DB['database'],
                'schemaVersion' => self::schemaVersion(self::getConnection()),
            ],
            'replacements' => array_map(
                fn ($pair) => ['from' => $pair[0], 'to' => $pair[1]],
                self::replacements($config)
            ),
            'tables'  => self::plan($source, $config, []),
            'dataDir' => self::dataDirStatus($config),
        ]);
    }

    protected function post(Request &$req, Response &$res): never
    {
        $this->requireAdmin($res);

        $dryRun = $req->params->getAsBool('dryRun', false);
        $tables = array_values(array_filter(array_map('strval', $req->params->getAsArray('tables', []))));

        // A full copy outlasts the default execution time on most shared hosts, and a
        // browser that gives up must not leave the target half-written.
        set_time_limit(0);
        ignore_user_abort(true);

        $result = self::execute(self::config(), $dryRun, $tables);

        $res->success($result);
    }

    // ── Config ──────────────────────────────────────────────────────────────────────────

    public static function configPath(): string
    {
        return dirname(__DIR__) . '/copy.config.php';
    }

    /** Whether a copy is configured on this deployment at all. */
    public static function isConfigured(): bool
    {
        return is_file(self::configPath());
    }

    private static function config(): array
    {
        if (!self::isConfigured()) {
            throw new Error('copy.config.php is not present — copying is disabled on this deployment');
        }

        $config = require self::configPath();

        if (!is_array($config)) {
            throw new Error('copy.config.php must return an array');
        }

        $config = $config + self::DEFAULTS;
        $config['source_db'] = $config['source_db'] + ['host' => '', 'port' => 3306, 'database' => '', 'user' => '', 'password' => ''];

        foreach (['host', 'database', 'user'] as $key) {
            if (($config['source_db'][$key] ?? '') === '') {
                throw new Error('copy.config.php: source_db.' . $key . ' is empty');
            }
        }

        if (!defined('DB') || !is_array(DB)) {
            throw new Error('config.php defines no DB constant');
        }

        // The one mistake that would be unrecoverable: copying a database onto itself.
        if (
            strcasecmp((string) $config['source_db']['host'], (string) DB['host']) === 0
            && strcasecmp((string) $config['source_db']['database'], (string) DB['database']) === 0
        ) {
            throw new Error(
                'source and target are the same database (' . DB['host'] . '/' . DB['database'] . ') — refusing to run'
            );
        }

        return $config;
    }

    private static function targetUrl(array $config): string
    {
        $url = self::trimUrl((string) $config['target_url']);

        return $url !== '' ? $url : self::trimUrl(defined('BASE_URL') ? BASE_URL : '');
    }

    /** Strip a trailing slash so both `…/x` and `…` forms replace cleanly. */
    private static function trimUrl(string $url): string
    {
        return rtrim(trim($url), '/');
    }

    /**
     * Literal from → to pairs, applied in order.
     *
     * The shorter forms are only safe when the hosts actually differ. With a shared host
     * (dev on a sub-path of the source) they are substrings of what the full-URL pairs
     * just wrote, and a second pass over the same rows would double the sub-path.
     *
     * @return array<array{0: string, 1: string}>
     */
    private static function replacements(array $config): array
    {
        $pairs = [];

        if (!empty($config['replace_urls'])) {
            $source = self::trimUrl((string) $config['source_url']);
            $target = self::targetUrl($config);

            if ($source === '' || $target === '') {
                throw new Error('copy.config.php: source_url and target_url must resolve to real URLs when replace_urls is on');
            }

            $sourceHost = parse_url($source, PHP_URL_HOST) ?: $source;
            $targetHost = parse_url($target, PHP_URL_HOST) ?: $target;
            $sourcePath = (string) (parse_url($source, PHP_URL_PATH) ?? '');

            // Both schemes, so a stored `http://…` is caught even when the source is HTTPS.
            foreach (['https://', 'http://'] as $scheme) {
                $pairs[] = [$scheme . $sourceHost . $sourcePath, $target];
            }

            if (strcasecmp($sourceHost, $targetHost) !== 0) {
                $pairs[] = ['//' . $sourceHost . $sourcePath, (string) preg_replace('#^https?:#', '', $target)];

                if (!empty($config['replace_bare_host'])) {
                    $pairs[] = [$sourceHost, $targetHost];
                }
            }
        }

        foreach ((array) $config['extra_replacements'] as $pair) {
            $from = (string) ($pair['from'] ?? '');
            if ($from !== '') {
                $pairs[] = [$from, (string) ($pair['to'] ?? '')];
            }
        }

        return $pairs;
    }

    // ── Connections ─────────────────────────────────────────────────────────────────────

    private static function connectSource(array $config): mysqli
    {
        static $link = null;

        if ($link instanceof mysqli) {
            return $link;
        }

        $db = $config['source_db'];

        try {
            $link = new mysqli(
                (string) $db['host'],
                (string) $db['user'],
                (string) $db['password'],
                (string) $db['database'],
                (int) $db['port']
            );
        } catch (Throwable $e) {
            throw new Error('cannot reach the source database (' . $db['host'] . '/' . $db['database'] . '): ' . $e->getMessage());
        }

        $link->set_charset('utf8mb4');

        return $link;
    }

    /** Backtick-quote an identifier. */
    private static function q(string $identifier): string
    {
        return '`' . str_replace('`', '``', $identifier) . '`';
    }

    private static function schemaVersion(mysqli $link): ?int
    {
        try {
            $result = $link->query('SELECT MAX(`version`) FROM `schema_version`');
            $row = $result ? $result->fetch_row() : null;

            return $row && $row[0] !== null ? (int) $row[0] : null;
        } catch (Throwable) {
            return null; // no schema_version table yet
        }
    }

    // ── Plan ────────────────────────────────────────────────────────────────────────────

    /**
     * What would be copied, with the source's row counts.
     *
     * @param string[] $only Restrict to these table names; empty means all of them.
     * @return array<array{name: string, rows: int, mode: string}>
     */
    private static function plan(mysqli $source, array $config, array $only): array
    {
        $excluded      = array_map('strtolower', (array) $config['exclude_tables']);
        $structureOnly = array_map('strtolower', (array) $config['structure_only_tables']);

        $plan = [];
        $result = $source->query("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'");

        while ($row = $result->fetch_row()) {
            $table = $row[0];

            if ($only && !in_array($table, $only, true)) {
                continue;
            }

            $mode = in_array(strtolower($table), $excluded, true)
                ? 'excluded'
                : (in_array(strtolower($table), $structureOnly, true) ? 'structure' : 'data');

            $plan[] = [
                'name' => $table,
                'rows' => $mode === 'data'
                    ? (int) $source->query('SELECT COUNT(*) FROM ' . self::q($table))->fetch_row()[0]
                    : 0,
                'mode' => $mode,
            ];
        }

        $result->free();

        return $plan;
    }

    // ── Copy ────────────────────────────────────────────────────────────────────────────

    /**
     * @param string[] $only Restrict to these table names; empty means all of them.
     * @param ?callable $log Called with a progress line, for the CLI.
     */
    private static function execute(array $config, bool $dryRun, array $only, ?callable $log = null): array
    {
        $started = microtime(true);
        $say = $log ?? static fn () => null;

        $source = self::connectSource($config);
        $target = self::getConnection();

        $plan = self::plan($source, $config, $only);
        $plan = array_values(array_filter($plan, fn ($entry) => $entry['mode'] !== 'excluded'));

        if (!$plan) {
            throw new Error('nothing to copy — every source table is excluded');
        }

        $say(sprintf(
            '%s %s/%s → %s/%s',
            $dryRun ? 'Would copy' : 'Copying',
            $config['source_db']['host'],
            $config['source_db']['database'],
            DB['host'],
            DB['database']
        ));

        $pairs = self::replacements($config);
        $rowsCopied = 0;
        $rewrites = [];

        $line = fn (array $entry) => '  ' . str_pad($entry['name'], 28)
            . ($entry['mode'] === 'data' ? $entry['rows'] . ' rows' : 'structure only');

        if ($dryRun) {
            foreach ($plan as $entry) {
                $say($line($entry));
            }
            // Nothing is written, so report what the plan holds — otherwise a preview
            // always claims zero rows.
            $rowsCopied = array_sum(array_column($plan, 'rows'));
        } else {
            // Copy and rewrite share one bracketed session; constraint checks stay off while
            // the tables come and go. The connection charset is not touched here — DB.php
            // connects as utf8mb4, which is what the row copy (real_escape_string) and the
            // rewrite both need for a 4-byte character to survive the round trip.
            $target->query('SET FOREIGN_KEY_CHECKS = 0');
            $target->query('SET UNIQUE_CHECKS = 0');
            $target->query("SET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO'");

            try {
                foreach ($plan as $entry) {
                    $rowsCopied += self::copyTable($source, $target, $entry, (int) $config['batch_size']);
                    $say($line($entry));
                }

                if ($pairs) {
                    $say('Rewriting URLs');
                    $rewrites = self::rewrite($target, $config, $pairs, array_column($plan, 'name'));

                    foreach ($rewrites as $rewrite) {
                        $say('  ' . $rewrite['column'] . ': ' . $rewrite['rows'] . ' row(s)');
                    }
                }
            } finally {
                $target->query('SET FOREIGN_KEY_CHECKS = 1');
                $target->query('SET UNIQUE_CHECKS = 1');
            }
        }

        $rowsRewritten = array_sum(array_column($rewrites, 'rows'));

        // ── Uploaded files ──
        $dataFiles = null;
        $dataStatus = self::dataDirStatus($config);

        if ($dataStatus['configured'] && $dataStatus['readable'] && !$dryRun) {
            $dataFiles = self::copyTree($dataStatus['source'], $dataStatus['target']);
            $say('  data: ' . $dataFiles . ' file(s) → ' . $dataStatus['target']);
        }

        return [
            'dryRun'        => $dryRun,
            'tables'        => $plan,
            'rowsCopied'    => $rowsCopied,
            'replacements'  => array_map(fn ($pair) => ['from' => $pair[0], 'to' => $pair[1]], $pairs),
            'rewrites'      => $rewrites,
            'rowsRewritten' => $rowsRewritten,
            'dataFiles'     => $dataFiles,
            'dataDir'       => $dataStatus,
            'schemaVersion' => $dryRun ? self::schemaVersion($source) : self::schemaVersion($target),
            'durationMs'    => (int) round((microtime(true) - $started) * 1000),
        ];
    }

    /** Drop, recreate and refill one table. Returns the number of rows written. */
    private static function copyTable(mysqli $source, mysqli $target, array $entry, int $batchSize): int
    {
        $quoted = self::q($entry['name']);
        $create = $source->query('SHOW CREATE TABLE ' . $quoted)->fetch_row()[1];

        $target->query('DROP TABLE IF EXISTS ' . $quoted);
        $target->query($create);

        if ($entry['mode'] !== 'data' || $entry['rows'] === 0) {
            return 0;
        }

        // Streamed (MYSQLI_USE_RESULT) so a large table is never held in memory in full.
        // The writes go over the other connection, which stays free while the read is open.
        $rows    = $source->query('SELECT * FROM ' . $quoted, MYSQLI_USE_RESULT);
        $columns = array_map(fn ($field) => self::q($field->name), $rows->fetch_fields());
        $prefix  = 'INSERT INTO ' . $quoted . ' (' . implode(',', $columns) . ') VALUES ';

        $written = 0;
        $batch = [];

        $flush = function () use (&$batch, &$written, $target, $prefix): void {
            if (!$batch) {
                return;
            }
            $target->real_query($prefix . implode(',', $batch));
            $written += count($batch);
            $batch = [];
        };

        while ($row = $rows->fetch_row()) {
            $values = array_map(
                fn ($value) => $value === null ? 'NULL' : "'" . $target->real_escape_string((string) $value) . "'",
                $row
            );
            $batch[] = '(' . implode(',', $values) . ')';

            if (count($batch) >= max(1, $batchSize)) {
                $flush();
            }
        }

        $flush();
        $rows->free();

        return $written;
    }

    /**
     * Apply the replacement pairs to every text and JSON column of the copied tables.
     *
     * @param array<array{0: string, 1: string}> $pairs
     * @param string[] $tables
     * @return array<array{column: string, rows: int}>
     */
    private static function rewrite(mysqli $target, array $config, array $pairs, array $tables): array
    {
        $skip = [];
        foreach ((array) $config['skip_columns'] as $column) {
            $skip[strtolower(trim((string) $column))] = true;
        }

        $statement = $target->prepare(
            'SELECT TABLE_NAME, COLUMN_NAME
               FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = ?
                AND DATA_TYPE IN (' . self::TEXT_TYPES . ')
                AND (EXTRA IS NULL OR EXTRA NOT LIKE \'%GENERATED%\')
              ORDER BY TABLE_NAME, ORDINAL_POSITION'
        );
        $database = DB['database'];
        $statement->bind_param('s', $database);
        $statement->execute();
        $columns = $statement->get_result()->fetch_all(MYSQLI_ASSOC);
        $statement->close();

        $rewrites = [];

        foreach ($columns as $column) {
            $table = $column['TABLE_NAME'];
            $name  = $column['COLUMN_NAME'];

            if (!in_array($table, $tables, true) || isset($skip[strtolower($table . '.' . $name)])) {
                continue;
            }

            $qt = self::q($table);
            $qc = self::q($name);
            $affected = 0;

            foreach ($pairs as [$from, $to]) {
                // REPLACE() casts a JSON column to text; assigning the result back re-parses
                // it, which is safe here because swapping one URL for another keeps the JSON
                // valid.
                $update = $target->prepare(
                    'UPDATE ' . $qt . ' SET ' . $qc . ' = REPLACE(' . $qc . ', ?, ?) WHERE ' . $qc . ' LIKE ?'
                );
                $like = '%' . $from . '%';
                $update->bind_param('sss', $from, $to, $like);
                $update->execute();
                $affected += max(0, $update->affected_rows);
                $update->close();
            }

            if ($affected > 0) {
                $rewrites[] = ['column' => $table . '.' . $name, 'rows' => $affected];
            }
        }

        return $rewrites;
    }

    // ── Uploaded files ──────────────────────────────────────────────────────────────────

    private static function dataDirStatus(array $config): array
    {
        $source = trim((string) (($config['data_dir'] ?? [])['source'] ?? ''));
        $target = trim((string) (($config['data_dir'] ?? [])['target'] ?? '')) ?: dirname(__DIR__) . '/data';

        return [
            'configured' => $source !== '',
            'readable'   => $source !== '' && is_dir($source),
            'source'     => $source,
            'target'     => $target,
        ];
    }

    /** Recursive copy; existing files are overwritten, extra files in the target are left. */
    private static function copyTree(string $from, string $to): int
    {
        if (!is_dir($to) && !@mkdir($to, 0775, true) && !is_dir($to)) {
            throw new Error('cannot create ' . $to);
        }

        $copied = 0;

        foreach (scandir($from) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }

            $source = $from . DIRECTORY_SEPARATOR . $entry;
            $target = $to . DIRECTORY_SEPARATOR . $entry;

            if (is_dir($source)) {
                $copied += self::copyTree($source, $target);
            } elseif (@copy($source, $target)) {
                $copied++;
            }
        }

        return $copied;
    }

    // ── CLI ─────────────────────────────────────────────────────────────────────────────

    public static function cli(array $argv): never
    {
        $has = fn (string $name) => in_array('--' . $name, $argv, true);
        $value = function (string $name) use ($argv): string {
            foreach ($argv as $arg) {
                if (str_starts_with($arg, '--' . $name . '=')) {
                    return substr($arg, strlen($name) + 3);
                }
            }
            return '';
        };

        $say = static function (string $line): void {
            echo $line . PHP_EOL;
            @flush();
        };

        $dryRun = $has('dry-run');

        try {
            $config = self::config();

            if (!$dryRun && !$has('yes')) {
                $say('This DROPS and rewrites every source table in ' . DB['host'] . '/' . DB['database'] . '.');
                $say('Re-run with --yes, or --dry-run to preview.');
                exit(1);
            }

            set_time_limit(0);

            $only = array_values(array_filter(array_map('trim', explode(',', $value('tables')))));
            $result = self::execute($config, $dryRun, $only, $say);

            $say('');
            $say(sprintf(
                '%s %d table(s), %s row(s), %s rewritten in %.1fs',
                $dryRun ? 'Would copy' : 'Copied',
                count($result['tables']),
                number_format($result['rowsCopied']),
                number_format($result['rowsRewritten']),
                $result['durationMs'] / 1000
            ));

            if (!$dryRun) {
                $say('Schema is at v' . ($result['schemaVersion'] ?? '?') . ' — run pending migrations from the admin panel.');
            }
        } catch (Throwable $e) {
            fwrite(STDERR, 'ERROR: ' . $e->getMessage() . PHP_EOL);
            exit(1);
        }

        exit(0);
    }
}

// Direct CLI invocation (`php api/DbCopy.php …`), not a require from rest.php.
if (PHP_SAPI === 'cli' && isset($argv[0]) && realpath($argv[0]) === realpath(__FILE__)) {
    require_once(dirname(__DIR__) . '/config.php');
    DbCopy::cli($argv);
}
