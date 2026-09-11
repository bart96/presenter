<?php

/**
 * Presenter Live Viewer — configuration template.
 *
 * Copy this file to `config.php` next to it and fill in the values:
 *
 *     cp config-example.php config.php
 *
 * `config.php` is git-ignored, so the token never reaches version control and
 * pulling a new version of the viewer cannot overwrite your settings.
 *
 * The token may be left empty when the page is always opened with `?token=…`
 * (the link the Presenter app builds under Settings → Viewer Token). A token
 * given in the URL always wins over the one configured here, so one deployed
 * copy can serve both a fixed screen and per-account links.
 *
 * Save `config.php` as UTF-8 WITHOUT a byte-order mark. PHP echoes a BOM as page
 * output before any header is sent, which silently turns the viewer's 400/503
 * error responses into 200s and puts stray bytes at the top of the page. Windows
 * editors and PowerShell's `Set-Content -Encoding utf8` add one by default.
 */

return [
    // Viewer token — Settings → General → Viewer Token in the Presenter app.
    // 64 hex characters. Leave empty to require `?token=` on every request.
    'token' => '',

    // Set true on a dev deployment. Paints a striped bar across the top of the page so a
    // screen showing the dev viewer can never be mistaken for the live one — the two are
    // otherwise identical, and a projection has no address bar to check.
    'development' => false,

    // WebSocket relay server.
    // Set 'wss' => true when the relay sits behind a TLS-terminating reverse proxy.
    // 'path' is optional; use a sub-path (e.g. '/ws') when the relay shares the
    // hostname of the PHP app and is routed by path in that proxy.
    'ws_host' => [
        'wss' => true,
        'host' => 'presenter.example.com',
        'port' => 443,
        'path' => '/',
    ],
];
