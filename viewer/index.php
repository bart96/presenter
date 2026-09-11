<?php
/**
 * Presenter Live Viewer
 *
 * Connects to the WebSocket relay server and shows the currently active
 * presenter block text in real time. No database connection needed — the relay
 * resolves the viewer token to an account on its own.
 *
 * Settings live in `config.php` (copy `config-example.php` to create it). Keeping
 * them out of this file means the token is never committed and pulling a new
 * version of the viewer cannot overwrite a deployment's settings.
 *
 * The token can come from either side:
 *   - `?token=…` in the URL — the link the app builds under Settings → Viewer Token
 *   - `token` in config.php — for a fixed screen that is opened without arguments
 * The URL wins, so one deployed copy serves both uses.
 */

// ── Configuration ─────────────────────────────────────────────────────────────

$configFile = __DIR__ . '/config.php';
$config = is_file($configFile) ? require $configFile : [];
if (!is_array($config)) {
    $config = [];
}

$configuredToken = is_string($config['token'] ?? null) ? trim($config['token']) : '';
$isDevelopment = !empty($config['development']);
$wsHost = is_array($config['ws_host'] ?? null) ? $config['ws_host'] : [];

// ── Helper: render a minimal error page ───────────────────────────────────────
function renderError(string $title, string $message): void
{
    echo '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>' . htmlspecialchars($title) . '</title>';
    echo '<meta name="viewport" content="width=device-width,initial-scale=1">';
    echo '<style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0a0a0a;color:#fff;font-family:sans-serif;text-align:center;padding:2rem}';
    echo 'h1{font-size:1.4rem;margin-bottom:.75rem;color:#e05252}p{color:rgba(255,255,255,.55);font-size:.9rem}</style></head><body>';
    echo '<div><h1>' . htmlspecialchars($title) . '</h1><p>' . htmlspecialchars($message) . '</p></div></body></html>';
}

// ── Resolve the token ─────────────────────────────────────────────────────────
// A token in the URL overrides the configured one, so the same deployed copy can
// serve a fixed screen and per-account links. A malformed one is refused rather
// than quietly falling back to the house token — otherwise a mistyped link would
// silently show someone else's service.

$queryToken = trim($_GET['token'] ?? '');

if ($queryToken !== '' && !preg_match('/^[0-9a-f]{64}$/', $queryToken)) {
    http_response_code(400);
    renderError('Invalid Token', 'The token in the address is not a valid viewer token.');
    exit;
}

$token = $queryToken !== '' ? $queryToken : $configuredToken;

if (!preg_match('/^[0-9a-f]{64}$/', $token)) {
    http_response_code(503);
    renderError(
        'Not Configured',
        is_file($configFile)
            ? 'Set a valid viewer token in config.php, or open this page with ?token=…'
            : 'Copy config-example.php to config.php and set your viewer token, or open this page with ?token=…'
    );
    exit;
}

// ── Build WS URL ──────────────────────────────────────────────────────────────

$wsUrl = '';
if (!empty($wsHost['host'])) {
    $scheme = !empty($wsHost['wss']) ? 'wss' : 'ws';
    $host   = $wsHost['host'];
    $port   = (int) ($wsHost['port'] ?? 443);
    $path   = $wsHost['path'] ?? '';
    $path   = ($path && $path !== '/') ? $path : '';
    $wsUrl  = "{$scheme}://{$host}:{$port}{$path}";
}

if (empty($wsUrl)) {
    http_response_code(503);
    renderError(
        'Not Configured',
        is_file($configFile)
            ? 'Set ws_host in config.php so the viewer knows which relay to connect to.'
            : 'Copy config-example.php to config.php and set ws_host.'
    );
    exit;
}

// ── Render viewer page ────────────────────────────────────────────────────────

$tokenJson  = json_encode($token);
$wsUrlJson  = json_encode($wsUrl);
$debugMode  = isset($_GET['debug']);

?><!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Presenter Live View</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #0a0a0a;
      --text: #ffffff;
      --meta: rgba(255,255,255,0.45);
      --accent: #4a90d9;
      --error: #e05252;
      --fade: 0.35s ease;
      /* Lyrics size multiplier and alignment — set from the menu, kept in localStorage. */
      --scale: 1;
      --align: center;
    }

    html, body {
      width: 100%;
      min-height: 100%;
      background: var(--bg);
      color: var(--text);
      font-family: 'Roboto', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      overflow-y: auto;
      overflow-x: hidden;
    }

    /* ── Status pill (connection indicator) — top left, out of the text's way ── */
    #status-bar {
      position: fixed;
      top: 0;
      left: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 14px;
      background: rgba(10,10,10,0.85);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border-bottom-right-radius: 8px;
      font-size: 11px;
      color: var(--meta);
      z-index: 100;
      transition: opacity var(--fade);
    }
    #status-bar.hide { opacity: 0; pointer-events: none; }

    /* Dev deployment marker — see 'development' in config.php. Fixed and click-through,
       so it costs the projection no space and can never swallow a tap. */
    #dev-stripe {
      position: fixed;
      top: 0; left: 0; right: 0;
      height: 4px;
      z-index: 2147483647;
      pointer-events: none;
      background: repeating-linear-gradient(135deg, #f0a020 0 10px, #1a1206 10px 20px);
    }

    #status-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: #555;
      flex-shrink: 0;
      transition: background 0.4s;
    }
    #status-dot.connecting { background: #f5a623; animation: pulse 1.2s ease-in-out infinite; }
    #status-dot.connected  { background: #4caf50; animation: none; }
    #status-dot.error      { background: var(--error); animation: none; }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.3; }
    }

    /* ── Black-screen overlay ────────────────────────────────────────────────── */
    #black-overlay {
      position: fixed;
      inset: 0;
      background: #000;
      z-index: 50;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.4s ease;
    }
    #black-overlay.active { opacity: 1; pointer-events: auto; }

    /* ── Main content area ───────────────────────────────────────────────────── */
    #stage {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: calc(100vh - 34px); /* viewport minus the info bar; the status pill floats */
      /* Horizontal padding matters for left/right alignment — text must not touch the
         screen edge, which a projector's overscan can clip. */
      padding: 3vh 4%;
      text-align: center;
    }

    /* Lyrics — large, bold, tight */
    #lyrics {
      font-size: calc(clamp(28px, 4.5vw, 96px) * var(--scale));
      text-align: var(--align);
      line-height: 1.25;
      font-weight: 700;
      letter-spacing: 0.01em;
      max-width: 1400px;
      width: 100%;
      transition: opacity var(--fade);
    }

    #lyrics.fade-out { opacity: 0; }

    .line { display: block; }
    .line.translation {
      color: var(--meta);
      font-size: 0.6em;
      font-weight: 400;
      margin-top: 0.15em;
    }

    /* Waiting / empty state */
    #waiting {
      font-size: clamp(14px, 2vw, 20px);
      font-weight: 400;
      color: var(--meta);
      display: none;
    }
    #waiting.visible { display: block; }

    /* ── Info bar — one slim row at the bottom ───────────────────────────────── */
    #info-bar {
      position: sticky;
      bottom: 0;
      width: 100%;
      height: 34px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      /* Symmetric padding keeps the text centred despite the menu button on the right. */
      padding: 0 44px;
      background: rgba(10,10,10,0.85);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      font-size: 11px;
      color: var(--meta);
      letter-spacing: 0.05em;
      text-transform: uppercase;
      z-index: 100;
    }
    /* One line, always: on a narrow screen the show title gives way first and the block
       name — the most useful part — is never truncated. */
    #info-bar > span { white-space: nowrap; }
    #info-bar #meta-show,
    #info-bar #meta-song { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    #info-bar .separator { opacity: 0.3; flex-shrink: 0; }
    #info-bar #block-name { color: var(--accent); flex-shrink: 0; }

    /* ── Menu — one small button at the right end of the info bar ────────────── */
    #menu-btn {
      position: absolute;
      right: 6px;
      top: 50%;
      transform: translateY(-50%);
      display: flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 24px;
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 5px;
      background: transparent;
      color: var(--meta);
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
      transition: color 0.2s, border-color 0.2s;
    }
    #menu-btn:hover,
    #menu-btn[aria-expanded="true"] { color: var(--text); border-color: rgba(255,255,255,0.35); }

    /* Opens upwards — the bar sits at the bottom of the page. */
    #menu {
      position: absolute;
      right: 6px;
      bottom: 40px;
      min-width: 160px;
      /* Never taller than the window — matters in landscape on a phone. */
      max-height: calc(100vh - 60px);
      overflow-y: auto;
      padding: 6px;
      background: rgba(20,20,20,0.97);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 8px;
      box-shadow: 0 8px 26px rgba(0,0,0,0.55);
      z-index: 120;
    }
    #menu[hidden], #menu [hidden] { display: none; }
    #menu .menu-title {
      padding: 4px 8px 6px;
      font-size: 10px;
      letter-spacing: 0.08em;
      color: rgba(255,255,255,0.35);
    }
    #menu .menu-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      width: 100%;
      padding: 8px;
      border: none;
      border-radius: 5px;
      background: transparent;
      color: var(--text);
      font: inherit;
      font-size: 12px;
      /* The info bar is uppercase + tracked out; menu entries read as normal text. */
      text-transform: none;
      letter-spacing: normal;
      text-align: left;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }
    #menu .menu-item:hover { background: rgba(255,255,255,0.07); }
    #menu .menu-item.active { color: var(--accent); }
    #menu .menu-item .check { opacity: 0; }
    #menu .menu-item.active .check { opacity: 1; }
    /* Read-only entry: the loaded show, which the bar only shows briefly. */
    #menu .menu-info {
      padding: 0 8px 6px;
      max-width: 220px;
      font-size: 12px;
      color: var(--text);
      text-transform: none;
      letter-spacing: normal;
      white-space: normal;
      line-height: 1.35;
    }
    #menu .menu-sep {
      height: 1px;
      margin: 4px 6px 6px;
      background: rgba(255,255,255,0.1);
    }

    /* Debug log */
    #debug-log {
      position: fixed;
      bottom: 34px; left: 0; right: 0;
      max-height: 180px;
      overflow-y: auto;
      background: rgba(0,0,0,0.82);
      backdrop-filter: blur(6px);
      font-family: 'Courier New', monospace;
      font-size: 11px;
      color: rgba(255,255,255,0.65);
      padding: 6px 12px;
      z-index: 200;
      display: none;
    }
    #debug-log.visible { display: block; }
    #debug-log .entry { padding: 1px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
    #debug-log .entry.warn  { color: #f5a623; }
    #debug-log .entry.error { color: #e05252; }
    #debug-log .entry.ok    { color: #4caf50; }
    #debug-toggle {
      position: fixed;
      bottom: 38px; left: 12px;
      font-size: 10px;
      color: rgba(255,255,255,0.2);
      cursor: pointer;
      z-index: 201;
      user-select: none;
    }
    #debug-toggle:hover { color: rgba(255,255,255,0.5); }
  </style>
</head>
<body>
<?php if ($isDevelopment) { ?>
  <div id="dev-stripe" role="note" aria-label="Development deployment"></div>
<?php } ?>
  <div id="status-bar">
    <div id="status-dot"></div>
    <span id="status-text">Connecting…</span>
  </div>

  <div id="black-overlay"></div>

  <div id="stage">
    <div id="lyrics"></div>
    <div id="waiting">Waiting for presenter…</div>
  </div>

  <!-- Info bar: show · song · block — one slim row at the bottom -->
  <div id="info-bar">
    <span id="meta-show"></span>
    <span id="meta-song"></span>
    <span class="separator" id="sep-block" style="display:none">·</span>
    <span id="block-name"></span>

    <!-- Menu: text size presets, remembered per device -->
    <button type="button" id="menu-btn" aria-label="Menu" aria-haspopup="true" aria-expanded="false">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>
      </svg>
    </button>
    <div id="menu" role="menu" aria-label="Viewer options" hidden>
      <div class="menu-title">SHOW</div>
      <div class="menu-info" id="menu-show">—</div>
      <div class="menu-sep"></div>
      <div class="menu-title">TEXT SIZE</div>
      <button type="button" class="menu-item" role="menuitemradio" data-scale="0.7">Small<span class="check">✓</span></button>
      <button type="button" class="menu-item" role="menuitemradio" data-scale="1">Normal<span class="check">✓</span></button>
      <button type="button" class="menu-item" role="menuitemradio" data-scale="1.35">Large<span class="check">✓</span></button>
      <button type="button" class="menu-item" role="menuitemradio" data-scale="1.8">Huge<span class="check">✓</span></button>
      <div class="menu-sep"></div>
      <div class="menu-title">TEXT ALIGNMENT</div>
      <button type="button" class="menu-item" role="menuitemradio" data-align="left">Left<span class="check">✓</span></button>
      <button type="button" class="menu-item" role="menuitemradio" data-align="center">Center<span class="check">✓</span></button>
      <button type="button" class="menu-item" role="menuitemradio" data-align="right">Right<span class="check">✓</span></button>
      <!-- Hidden when the browser has no element fullscreen (e.g. iPhone Safari). -->
      <div id="fs-section">
        <div class="menu-sep"></div>
        <div class="menu-title">DISPLAY</div>
        <button type="button" class="menu-item" role="menuitemcheckbox" id="menu-fullscreen">Fullscreen<span class="check">✓</span></button>
      </div>
    </div>
  </div>

  <div id="debug-log"></div>
  <?php if ($debugMode): ?>
  <span id="debug-toggle">debug</span>
  <?php endif; ?>

  <script>
    (function () {
      'use strict';

      const TOKEN     = <?= $tokenJson ?>;
      const WS_URL    = <?= $wsUrlJson ?>;
      const RECONNECT = 3000;

      // Empty-state wording: before anything has been presented vs. after the selection
      // went stale (see "Selection expiry" below).
      const WAITING_TEXT = 'Waiting for presenter…';
      const NO_TEXT_TEXT = 'No text is currently available.';

      // Fallback if the relay does not advertise its TTL (older server): 1 hour.
      const DEFAULT_TTL_MS = 3600000;
      const SIZE_KEY  = 'presenter-viewer-text-scale';
      const ALIGN_KEY = 'presenter-viewer-text-align';
      const ALIGNMENTS = ['left', 'center', 'right'];

      // How long the bar names the loaded show before making room for song · block.
      // It reappears whenever the show changes, and stays readable in the menu.
      const SHOW_TITLE_MS = 3000;

      // ── DOM refs ────────────────────────────────────────────────────────────
      const dot         = document.getElementById('status-dot');
      const statusText  = document.getElementById('status-text');
      const metaShow    = document.getElementById('meta-show');
      const metaSong    = document.getElementById('meta-song');
      const sepBlock    = document.getElementById('sep-block');
      const blockNameEl = document.getElementById('block-name');
      const lyricsEl    = document.getElementById('lyrics');
      const waitingEl   = document.getElementById('waiting');
      const blackOver   = document.getElementById('black-overlay');
      const statusBar   = document.getElementById('status-bar');
      const debugLog    = document.getElementById('debug-log');
      const debugToggle = document.getElementById('debug-toggle');
      const menuBtn     = document.getElementById('menu-btn');
      const menu        = document.getElementById('menu');
      const menuShow    = document.getElementById('menu-show');
      const fsItem      = document.getElementById('menu-fullscreen');
      const fsSection   = document.getElementById('fs-section');

      const DEBUG = <?= $debugMode ? 'true' : 'false' ?>;

      // Auto-show debug panel when ?debug is present
      if (DEBUG) debugLog.classList.add('visible');

      let ws             = null;
      let stopped        = false;  // transient stop (reconnects after visibility change)
      let permanentStop  = false;  // permanent stop (invalid token — never reconnect)
      let hideTimer      = null;
      let reconnectCount = 0;
      let syncTtlMs      = DEFAULT_TTL_MS;  // overridden by auth_ok
      let expiryTimer    = null;

      // ── Menu + text size ────────────────────────────────────────────────────
      // A viewer screen can be anything from a phone to a projector, so the size is a
      // per-device choice rather than something the presenter controls. It lives behind
      // the menu button so the bar itself stays free for show · song · block.
      function applyScale(scale, persist) {
        document.documentElement.style.setProperty('--scale', String(scale));
        Array.prototype.forEach.call(menu.querySelectorAll('.menu-item'), function (b) {
          const on = parseFloat(b.dataset.scale) === scale;
          b.classList.toggle('active', on);
          b.setAttribute('aria-checked', on ? 'true' : 'false');
        });
        if (persist) {
          try { localStorage.setItem(SIZE_KEY, String(scale)); } catch (e) { /* private mode */ }
        }
      }

      function applyAlign(align, persist) {
        document.documentElement.style.setProperty('--align', align);
        Array.prototype.forEach.call(menu.querySelectorAll('.menu-item[data-align]'), function (b) {
          const on = b.dataset.align === align;
          b.classList.toggle('active', on);
          b.setAttribute('aria-checked', on ? 'true' : 'false');
        });
        if (persist) {
          try { localStorage.setItem(ALIGN_KEY, align); } catch (e) { /* private mode */ }
        }
      }

      (function initPreferences() {
        var scale = 1;
        var align = 'center';
        try {
          var v = parseFloat(localStorage.getItem(SIZE_KEY));
          if (v > 0) scale = v;
          var a = localStorage.getItem(ALIGN_KEY);
          if (ALIGNMENTS.indexOf(a) !== -1) align = a;
        } catch (e) { /* private mode */ }
        applyScale(scale, false);
        applyAlign(align, false);
      })();

      function setMenuOpen(open) {
        menu.hidden = !open;
        menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      }

      menuBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        setMenuOpen(menu.hidden);
      });

      // Picking a size or alignment deliberately leaves the menu open, so they can be
      // compared against the live text without reopening it each time.
      menu.addEventListener('click', function (e) {
        const sizeItem = e.target.closest('.menu-item[data-scale]');
        if (sizeItem) applyScale(parseFloat(sizeItem.dataset.scale), true);
        const alignItem = e.target.closest('.menu-item[data-align]');
        if (alignItem) applyAlign(alignItem.dataset.align, true);
      });

      document.addEventListener('click', function (e) {
        if (!menu.hidden && !menu.contains(e.target) && !menuBtn.contains(e.target)) setMenuOpen(false);
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') setMenuOpen(false);
      });

      // ── Fullscreen ──────────────────────────────────────────────────────────
      // Replaces the old double-click-anywhere gesture, which was undiscoverable and
      // fired by accident. Hidden entirely where the API does not exist, rather than
      // offering a control that silently does nothing.
      if (!document.documentElement.requestFullscreen) {
        fsSection.hidden = true;
      } else {
        function syncFullscreenItem() {
          const on = !!document.fullscreenElement;
          fsItem.classList.toggle('active', on);
          fsItem.setAttribute('aria-checked', on ? 'true' : 'false');
        }
        fsItem.addEventListener('click', function () {
          if (document.fullscreenElement) {
            document.exitFullscreen().catch(function (err) { dbg('Exit fullscreen failed: ' + err.message, 'warn'); });
          } else {
            document.documentElement.requestFullscreen().catch(function (err) {
              dbg('Fullscreen request failed: ' + err.message, 'warn');
            });
          }
          setMenuOpen(false);   // one-shot action, unlike comparing text sizes
        });
        // Also catches leaving fullscreen via Esc or the browser's own UI.
        document.addEventListener('fullscreenchange', syncFullscreenItem);
        syncFullscreenItem();
      }

      // ── Info bar ────────────────────────────────────────────────────────────
      // Rendered from these three, so the show title can drop out on a timer without the
      // next sync putting it straight back.
      let currentShow      = '';
      let currentSong      = '';
      let currentBlock     = '';
      let showTitleVisible = false;
      let showTitleTimer   = null;

      // The bar shows EITHER the show title (its first 10 s) OR song · block — never both,
      // so whichever is on screen has the full width and nothing shuffles sideways.
      function updateInfoBar() {
        const naming = showTitleVisible && !!currentShow;

        metaShow.textContent   = naming ? currentShow : '';
        metaShow.style.display = naming ? '' : 'none';

        metaSong.textContent   = naming ? '' : currentSong;
        metaSong.style.display = (!naming && currentSong) ? '' : 'none';

        blockNameEl.textContent   = naming ? '' : currentBlock;
        blockNameEl.style.display = (!naming && currentBlock) ? '' : 'none';

        sepBlock.style.display = (!naming && currentSong && currentBlock) ? '' : 'none';
      }

      /** Name the show for SHOW_TITLE_MS, then hand the space back to song · block. */
      function noteShowTitle(showTitle) {
        if (showTitle === currentShow) return;   // same show — do not restart the timer
        currentShow = showTitle;
        menuShow.textContent = showTitle || '—';
        clearTimeout(showTitleTimer);
        showTitleVisible = !!showTitle;
        if (showTitle) {
          showTitleTimer = setTimeout(function () {
            showTitleVisible = false;
            updateInfoBar();
          }, SHOW_TITLE_MS);
        }
      }

      // ── Selection expiry ────────────────────────────────────────────────────
      // Showing a block for days after the service is worse than showing nothing, so the
      // relay expires its cached selection (SYNC_TTL_SECONDS) and pushes `sync_expired`.
      // We run the same countdown locally as well, so the text still clears if the relay
      // restarts or the connection dies while this page keeps sitting on screen.
      function armExpiry(ageMs) {
        clearTimeout(expiryTimer);
        if (!(syncTtlMs > 0)) return;   // 0 = expiry disabled server-side
        const remaining = Math.max(0, syncTtlMs - (ageMs > 0 ? ageMs : 0));
        expiryTimer = setTimeout(function () {
          dbg('Selection expired locally after ' + syncTtlMs + 'ms', 'warn');
          showNoText();
        }, remaining);
      }

      /** Clear everything and state plainly that nothing is being presented. */
      function showNoText() {
        clearTimeout(expiryTimer);
        clearTimeout(showTitleTimer);
        lyricsEl.innerHTML = '';
        // Reset the show too, so whatever comes next is announced again for 10 s.
        currentShow = currentSong = currentBlock = '';
        showTitleVisible = false;
        menuShow.textContent = '—';
        updateInfoBar();
        blackOver.classList.remove('active');
        waitingEl.textContent = NO_TEXT_TEXT;
        waitingEl.classList.add('visible');
      }

      // ── Debug log ───────────────────────────────────────────────────────────
      if (debugToggle) {
        debugToggle.addEventListener('click', () => debugLog.classList.toggle('visible'));
      }

      function dbg(msg, level) {
        if (!DEBUG) return;
        const ts  = new Date().toISOString().slice(11, 23);
        const el  = document.createElement('div');
        el.className = 'entry' + (level ? ' ' + level : '');
        el.textContent = '[' + ts + '] ' + msg;
        debugLog.prepend(el);
        // keep at most 80 entries
        while (debugLog.children.length > 80) debugLog.lastChild.remove();
        console.log('[Viewer]', msg);
      }

      // ── Status helpers ──────────────────────────────────────────────────────
      function setStatus(state, text) {
        dot.className          = state;
        statusText.textContent = text;
        clearTimeout(hideTimer);
        if (state === 'connected') {
          hideTimer = setTimeout(() => statusBar.classList.add('hide'), 5000);
        } else {
          statusBar.classList.remove('hide');
        }
      }

      // ── Render ──────────────────────────────────────────────────────────────
      // `ageMs` is set on replayed selections: the countdown must run from when the
      // selection was made, not from when this page happened to connect.
      function render(data, ageMs) {
        armExpiry(ageMs);
        blackOver.classList.toggle('active', !!data.isBlack);

        const lines     = Array.isArray(data.blockLines) ? data.blockLines : [];
        const blockName = data.blockName || '';
        const songTitle = data.songTitle || '';
        const showTitle = data.showTitle || '';

        // Info bar — song · block, preceded by the show for its first 10 s only.
        noteShowTitle(showTitle);
        currentSong  = songTitle;
        currentBlock = blockName;
        updateInfoBar();

        lyricsEl.classList.add('fade-out');
        setTimeout(function () {
          lyricsEl.innerHTML = '';
          if (lines.length > 0) {
            lines.forEach(function (line) {
              const span       = document.createElement('span');
              span.className   = 'line' + (line.language ? ' translation' : '');
              span.textContent = line.text || '';
              lyricsEl.appendChild(span);
            });
            waitingEl.classList.remove('visible');
            lyricsEl.style.opacity = '';
          } else {
            waitingEl.textContent = WAITING_TEXT;
            waitingEl.classList.add('visible');
          }
          lyricsEl.classList.remove('fade-out');
        }, 200);
      }

      // ── WebSocket ───────────────────────────────────────────────────────────
      function connect() {
        if (permanentStop || stopped) return;
        reconnectCount++;
        dbg('Connecting to ' + WS_URL + ' (attempt #' + reconnectCount + ')');
        setStatus('connecting', 'Connecting…');

        try {
          ws = new WebSocket(WS_URL);
        } catch (e) {
          dbg('WebSocket constructor threw: ' + e.message, 'error');
          setStatus('error', 'Connection failed: ' + e.message);
          setTimeout(connect, RECONNECT);
          return;
        }

        ws.onopen = function () {
          if (permanentStop || stopped) { ws.close(); return; }
          dbg('Socket open — sending auth token');
          // `client` is descriptive only — it lets the operator's connected-clients
          // tooltip count this page as a text viewer.
          ws.send(JSON.stringify({ action: 'auth', token: TOKEN, client: { role: 'viewer' } }));
        };

        ws.onmessage = function (event) {
          var msg;
          try { msg = JSON.parse(event.data); } catch (e) {
            dbg('Non-JSON message: ' + event.data.slice(0, 100), 'warn');
            return;
          }

          dbg('← ' + JSON.stringify(msg).slice(0, 120));

          if (msg.type === 'auth_ok') {
            dbg('Authenticated — account ' + msg.account, 'ok');
            if (typeof msg.syncTtlSeconds === 'number' && msg.syncTtlSeconds >= 0) {
              syncTtlMs = msg.syncTtlSeconds * 1000;
              dbg('Selection TTL from relay: ' + (syncTtlMs ? syncTtlMs + 'ms' : 'disabled'));
            }
            setStatus('connected', 'Connected');
            // A replayed selection (if any) arrives right after this and overwrites it.
            waitingEl.textContent = WAITING_TEXT;
            waitingEl.classList.add('visible');
            return;
          }

          if (msg.type === 'sync_expired') {
            dbg('Relay reports the selection expired', 'warn');
            showNoText();
            return;
          }

          if (msg.type === 'auth_error') {
            const errText = msg.error || 'Authentication failed.';
            dbg('Auth error (permanent): ' + errText, 'error');
            setStatus('error', errText);
            permanentStop = true;   // invalid token — never reconnect
            ws.close();
            return;
          }

          if (msg.type === 'error') {
            dbg('Server error: ' + (msg.error || '(no message)'), 'warn');
            setStatus('error', msg.error || 'Server error');
            return;
          }

          if (msg.action === 'musician_sync' && msg.data) {
            // Two very different messages share this action. The operator broadcasts the
            // full presentation state; a musician on MIDI sync broadcasts a bare position
            // report (item/block/line/songNumber only) addressed at the operator, which
            // happens to reach us as well. Rendering that one blanked the text, cleared
            // song and block from the bar and dropped the black overlay — repaired only
            // when the operator's next broadcast happened to come, and not at all when
            // the musician's position was one the operator was already on.
            //
            // Only the operator's payload carries `contentType`, so that is the tell.
            if (typeof msg.data.contentType !== 'string') {
              dbg('Position report from a peer ignored — not a presentation state');
              return;
            }
            dbg('Sync received — block: ' + (msg.data.blockName || '(empty)') +
                (msg.replay ? ' (replay, age ' + (msg.ageMs || 0) + 'ms)' : ''), 'ok');
            render(msg.data, msg.ageMs);
          }
        };

        ws.onerror = function (e) {
          dbg('Socket error event fired', 'error');
          if (!permanentStop) setStatus('error', 'Connection error — retrying…');
        };

        ws.onclose = function (e) {
          dbg('Socket closed — code ' + e.code + ' reason: ' + (e.reason || '(none)'),
              e.code === 4003 || e.code === 4002 ? 'error' : 'warn');
          if (permanentStop) return;
          if (stopped) return;
          // 4010 = the operator cleared the connected clients. Reconnecting on a timer
          // would put us straight back, so wait for the viewer to ask for it.
          if (e.code === 4010) {
            dbg('Disconnected by operator — not reconnecting automatically', 'warn');
            permanentStop = true;
            setStatus('error', 'Disconnected by the presenter. Reload this page to reconnect.');
            return;
          }
          setStatus('connecting', 'Reconnecting… (#' + reconnectCount + ')');
          setTimeout(connect, RECONNECT);
        };
      }

      dbg('Page loaded — WS_URL: ' + WS_URL);
      dbg('Token prefix: ' + TOKEN.slice(0, 8) + '…');
      connect();

      // Reconnect when tab becomes visible again
      document.addEventListener('visibilitychange', function () {
        if (permanentStop) return;
        if (!document.hidden && (!ws || ws.readyState > 1)) {
          stopped = false;
          dbg('Tab visible — reconnecting');
          connect();
        }
      });

      // (Fullscreen lives in the menu — the old double-click-anywhere gesture is gone.)
    })();
  </script>
</body>
</html>
