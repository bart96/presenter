/**
 * Early error capture script.
 *
 * Loaded as a classic (non-module) <script> tag BEFORE any ES-module code runs.
 * This means it catches errors that occur during module initialisation — e.g.
 * a missing browser API that prevents the Redux store or React from loading,
 * which would otherwise produce a blank white page with no logged evidence.
 *
 * Works only in the web (PHP) deployment; harmlessly no-ops in Electron
 * because the fetch to /rest/Log will fail and be silently swallowed.
 */

import { isThirdPartyNoise } from './utils/errorNoise';

const MAX_QUEUE = 20;
let queue: string[] = [];

/* ── helpers ─────────────────────────────────────────────────── */

function formatUA(): string {
  try {
    return navigator.userAgent;
  } catch (_e) {
    return 'unknown';
  }
}

/** Read the configured backendUrl from localStorage (mirrors getBackendBaseUrl). */
function getBackendUrl(): string {
  // Desktop app only — the browser build always talks to the origin it was served from.
  if (!(window as { api?: unknown }).api) return '';
  try {
    const raw = localStorage.getItem('presenter_settings');
    if (raw) {
      const parsed = JSON.parse(raw) as { backendUrl?: unknown };
      if (parsed?.backendUrl) {
        return String(parsed.backendUrl).trim().replace(/\/+$/, '');
      }
    }
  } catch (_e) {
    /* ignore */
  }
  return '';
}

function sendLog(message: string): void {
  try {
    const base = getBackendUrl();
    const url = base + '/rest/Log';
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
      credentials: 'include',
    }).catch(() => {
      /* best-effort */
    });
  } catch (_e) {
    /* fetch not available or network error – ignore */
  }
}

function enqueue(message: string): void {
  if (queue.length < MAX_QUEUE) {
    queue.push(message);
  }
  // Attempt to flush soon; fetch is available immediately in modern browsers.
  setTimeout(flush, 50);
}

let flushed = false;
function flush(): void {
  if (flushed) return;
  flushed = true;
  for (const msg of queue) {
    sendLog(msg);
  }
  queue = [];
}

/* ── error handlers ───────────────────────────────────────────── */

// Preserve any handler already registered (e.g. by a bundler dev overlay).
const _prevOnerror = window.onerror;
window.onerror = function (msg, source, lineno, colno, error) {
  const text = typeof msg === 'string' ? msg : 'unknown error';

  // Extension scripts fail on every page load of a mobile browser; reporting them would drown
  // the very errors this early capture exists to catch. See utils/errorNoise.
  if (isThirdPartyNoise(text, source ? String(source) : null)) {
    if (typeof _prevOnerror === 'function') {
      return _prevOnerror.call(window, msg, source, lineno, colno, error);
    }
    return false;
  }

  let stack = '';
  try {
    if (error?.stack) {
      stack = ' | Stack: ' + String(error.stack).slice(0, 600);
    }
  } catch (_e) {
    /* ignore */
  }
  enqueue(
    '[EARLY_ERROR] [' + (source ?? 'unknown') + ':' + (lineno ?? 0) + ':' + (colno ?? 0) + '] ' + text + stack + ' | UA: ' + formatUA(),
  );
  if (typeof _prevOnerror === 'function') {
    return _prevOnerror.call(window, msg, source, lineno, colno, error);
  }
  return false; // do NOT suppress – let the browser still report it
};

window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  const reason: unknown = event.reason;
  const msg = reason instanceof Error ? reason.message : String(reason);
  let stack = '';
  try {
    if (reason && typeof reason === 'object' && 'stack' in reason) {
      stack = ' | Stack: ' + String((reason as { stack: unknown }).stack).slice(0, 600);
    }
  } catch (_e) {
    /* ignore */
  }
  enqueue('[EARLY_REJECTION] ' + msg + stack + ' | UA: ' + formatUA());
});

// Final flush safety-net: once the DOM is fully parsed, wait 3 s to let
// React mount and attempt its own reporting, then send anything still queued.
function scheduleFinalFlush(): void {
  setTimeout(flush, 3000);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', scheduleFinalFlush);
} else {
  scheduleFinalFlush();
}
