import { MEDIA_SERVER_BASE } from '@/utils/mediaUrl';
import { getSetting } from '@/store/settingsSlice';
import { LOGOUT_RESET_STATE, LOGOUT_STATE, type ResetOptions } from '@/utils/localDataReset';

/** Returns true when running inside the Electron shell (window.api is injected by the preload). */
export const isElectronApp = (): boolean => typeof window !== 'undefined' && !!(window as { api?: unknown }).api;

/**
 * Mapping between logical URL paths and Electron HTML filenames.
 * Single source of truth used by redirectToLogin, getOidcRedirectUrl, and LoginPage.
 */
export const PATH_TO_HTML: Record<string, string> = {
  '/': 'index.html',
  '/notes': 'musician.html',
  '/admin': 'admin.html',
  '/login': 'login.html',
};

const HTML_TO_PATH: Record<string, string> = Object.fromEntries(Object.entries(PATH_TO_HTML).map(([path, html]) => [html, path]));

/**
 * Returns the OIDC redirect URL for a given logical path (e.g. '/notes', '/admin').
 * - Web:      uses window.location.origin  (e.g. https://example.com/notes)
 * - Electron: uses the configured backendUrl, because window.location.origin
 *             is "null" for file:// pages and the OIDC provider needs a real HTTPS URL.
 */
export const getOidcRedirectUrl = (logicalPath: string): string => {
  const origin = isElectronApp()
    ? String(getSetting('backendUrl') ?? '')
        .trim()
        .replace(/\/+$/, '')
    : window.location.origin;
  // Guard: ensure the path always starts with '/' so concatenation is safe.
  // Without this, `origin + 'notes'` would produce `.de/notes` → `.denotes`.
  const safePath = logicalPath.startsWith('/') ? logicalPath : '/' + logicalPath;
  return origin + safePath;
};

/** Returns the configured backend origin (scheme + host), used by the main process to identify OIDC callbacks. */
export const getBackendOrigin = (): string => {
  return String(getSetting('backendUrl') ?? '')
    .trim()
    .replace(/\/+$/, '');
};

/**
 * Converts the `next` query parameter back to a logical path.
 * In Electron, `next` is an HTML filename (e.g. "musician.html").
 * On the web, it's already a path (e.g. "/notes").
 */
export const nextParamToPath = (next: string): string => {
  if (isElectronApp()) {
    return HTML_TO_PATH[next] ?? '/';
  }
  return next;
};

/**
 * In Electron, build a correct absolute file:// URL for a renderer HTML file.
 * Uses window.api.rendererDir (a file:// URL injected by the preload via pathToFileURL)
 * which is always correct even inside asar bundles.
 */
export const electronFileUrl = (filename: string): string => {
  const rendererDir: string | undefined = (window as { api?: { rendererDir?: string } }).api?.rendererDir;
  if (rendererDir) {
    return `${rendererDir}${filename}`;
  }
  // Fallback for dev (window.location.href is correct in dev mode)
  const currentHref = window.location.href.split('?')[0];
  const dir = currentHref.substring(0, currentHref.lastIndexOf('/') + 1);
  return `${dir}${filename}`;
};

export const redirectToLogin = (next?: string) => {
  const target = next ?? '/';
  if (isElectronApp()) {
    const nextFile = PATH_TO_HTML[target] ?? 'index.html';
    window.location.replace(electronFileUrl(`login.html?next=${nextFile}`));
  } else {
    window.location.replace('/login?next=' + encodeURIComponent(target));
  }
};

/**
 * Full sign-out: ends the OIDC provider's session as well as ours.
 *
 * `DELETE /rest/Session` alone only drops the local PHP session — the identity provider
 * still holds an SSO session, so the very next login is silently re-authenticated as the
 * same user and the account can never be switched. The backend `oidc?logout=1` handler
 * destroys the local session AND redirects to the provider's end-session endpoint.
 *
 * The return URL is deliberately bare: a `post_logout_redirect_uri` must match one of the
 * URIs registered for the OIDC client EXACTLY, query string included, so appending flags
 * here is what makes providers answer the logout with `400 invalid_request —
 * post_logout_redirect_uri not registered`. The backend instead sends `state=logged_out`,
 * which the provider echoes back onto this URL, and {@link isPostLogoutReturn} reads it.
 *
 * With `reset` it is also the recovery link for a device stuck in a stale state: `cookies`
 * has the backend expire every cookie the device sends, `storage` has the login page wipe
 * localStorage before the app reads it (see utils/localDataReset). Opened by hand it works
 * without a session too.
 */
export const oidcLogoutUrl = (reset?: Partial<ResetOptions>): string => {
  const origin = isElectronApp() ? getBackendOrigin() : window.location.origin;
  const back = `${origin}/login`;
  const parts = (['cookies', 'storage'] as const).filter((part) => reset?.[part]);
  const resetParam = parts.length > 0 ? `&reset=${parts.join(',')}` : '';
  return `${origin}/oidc?logout=1${resetParam}&redirect=${encodeURIComponent(back)}`;
};

/**
 * Does this URL mark the end of the logout round-trip? `state=logged_out` is what the
 * provider returns today (`logged_out_reset` when local data was to be wiped as well);
 * `logged_out=1` is the older form, still accepted so a client built before this change
 * keeps working against a newer backend and vice versa.
 */
export const isPostLogoutReturn = (params: URLSearchParams): boolean => {
  const state = params.get('state');
  return state === LOGOUT_STATE || state === LOGOUT_RESET_STATE || params.get('logged_out') === '1';
};

/**
 * sessionStorage key holding when the desktop login page last signed in automatically. Cleared as
 * soon as a session exists; see the auto-proceed in LoginPage for why it is needed.
 */
export const AUTO_LOGIN_STARTED_KEY = 'presenter_auto_login_started';
/** Back on the login page sooner than this after an automatic sign-in means it did not work. */
export const AUTO_LOGIN_RETRY_MS = 60_000;

export type DetectedOs = 'windows' | 'macos' | 'linux' | 'unknown';

/** Detect the user's OS to offer the right installer. */
export const detectOs = (): DetectedOs => {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('windows') || ua.includes('win32') || ua.includes('win64')) return 'windows';
  if (ua.includes('mac os') || ua.includes('macintosh')) return 'macos';
  if (ua.includes('linux')) return 'linux';
  return 'unknown';
};

export const getMediaBaseUrl = (mediaPath: string): string | null => {
  if (isElectronApp()) {
    return MEDIA_SERVER_BASE;
  }
  if (mediaPath) {
    return mediaPath.replace(/\/+$/, '');
  }

  return null;
};

export const clamp = (val: number, min: number, max: number) => Math.max(min, Math.min(max, val));

/** Format seconds as mm:ss */
export const formatTime = (seconds: number): string => {
  if (!isFinite(seconds) || seconds < 0) {
    return '0:00';
  }

  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

export const formatDateTime = (ts: number): string => {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const normalizeHex = (s: string): string => {
  if (!s) return '#000000';
  const v = s.trim().toUpperCase();
  if (/^#[0-9A-F]{6}$/.test(v)) return v;
  if (/^[0-9A-F]{6}$/.test(v)) return `#${v}`;
  return s;
};
