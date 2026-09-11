<?php

/**
 * Configuration for the "copy data from another database" admin action.
 *
 * Rename this file to `copy.config.php` on the server that should RECEIVE the data
 * (the dev subdomain) and fill in the source below. Its presence is what switches the
 * action on: without it the admin panel shows nothing and `/rest/DbCopy` refuses to run.
 *
 * Only the SOURCE is configured here. The target is this deployment itself — the copy
 * writes into the database from `config.php`, so the two sets of credentials never meet
 * in one file, and there is no way to accidentally point the copy at production.
 *
 * Never place this file on the production server.
 */

return [
    // Public URL of the source deployment, and of this one. Occurrences of the source URL
    // in the copied data (media links, style backgrounds, …) are rewritten to the target
    // URL. Leave 'target_url' empty to use BASE_URL from config.php.
    'source_url' => 'https://presenter.example.com',
    'target_url' => '',

    // Read-only credentials are enough — nothing is ever written to the source.
    'source_db' => [
        'host'     => 'localhost',
        'port'     => 3306,
        'database' => 'presenter_prod',
        'user'     => 'readonly_user',
        'password' => '',
    ],

    // Tables to leave out entirely. They keep whatever this database already holds.
    'exclude_tables' => [],

    // Tables to recreate empty — structure copied, rows skipped. Useful for anything
    // large and uninteresting on a dev box.
    'structure_only_tables' => [
        'metrics',
    ],

    // Rewrite source_url → target_url in every text and JSON column after copying.
    'replace_urls' => true,

    // Also rewrite the bare hostname, without a scheme. Off by default: a hostname on its
    // own is easy to hit inside an unrelated string. Ignored when both URLs share a host.
    'replace_bare_host' => false,

    // Columns the rewrite must not touch, as `table.column`. These two hold addresses of
    // other systems, which stay the same no matter which deployment reads them.
    'skip_columns' => [
        'oidc_providers.discovery_url',
        'account.church_tools_url',
    ],

    // Extra literal replacements applied after the URL ones, e.g.
    //   ['from' => 'https://cdn.example.com', 'to' => 'https://cdn-dev.example.com'],
    'extra_replacements' => [],

    // Rows per INSERT while copying. Lower it if the server has a small max_allowed_packet.
    'batch_size' => 500,

    // Uploaded PDFs and icons. Only works when the source deployment's `data/` directory is
    // readable from this server (same hosting account). 'target' defaults to this app's own
    // `data/`. Leave 'source' empty to skip files entirely.
    'data_dir' => [
        'source' => '',
        'target' => '',
    ],
];
