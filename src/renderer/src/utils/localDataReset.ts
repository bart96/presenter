/**
 * "Log out and reset" — wiping what this device has stored for the app.
 *
 * Deliberately free of anything that loads the store: `applyPendingReset` imports this
 * before the slices, and a slice reads localStorage the moment its module is evaluated.
 */
import { SETTINGS_KEY } from '@/store/persist';

/** `state` the provider echoes back after a plain logout. See oidc.php. */
export const LOGOUT_STATE = 'logged_out';
/** `state` after a logout that also asked for this device's local data to be wiped. */
export const LOGOUT_RESET_STATE = 'logged_out_reset';

/** What "Log out and reset" removes besides the session — two independent choices. */
export type ResetOptions = { cookies: boolean; storage: boolean };

/**
 * Removes everything this origin keeps in localStorage and sessionStorage.
 *
 * The desktop app keeps its backend address: it loads its pages from file:// and knows the
 * server only through that setting, so wiping it would leave the app unable to reach the
 * server even to log back in. The browser build never reads it (see getBackendBaseUrl).
 */
export const clearLocalData = (): void => {
  let backendUrl: unknown;
  if ((window as { api?: unknown }).api) {
    try {
      backendUrl = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')?.backendUrl;
    } catch {
      // Unreadable settings — nothing in there worth keeping.
    }
  }
  try {
    localStorage.clear();
  } catch {
    // Storage blocked — nothing stored that could be stale either.
  }
  try {
    sessionStorage.clear();
  } catch {
    // Same as above.
  }
  if (typeof backendUrl === 'string' && backendUrl.trim() !== '') {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ backendUrl }));
    } catch {
      // The desktop app then asks for the backend again, like on a first start.
    }
  }
};

/**
 * True when this page is the end of a logout that asked for local data to be wiped.
 *
 * The marker is rewritten to a plain post-logout `state` on the way, so a reload does not
 * wipe again whatever was set since — while the login page still sees it came from a logout.
 */
export const takeStorageResetMarker = (): boolean => {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get('state') !== LOGOUT_RESET_STATE) return false;
    url.searchParams.set('state', LOGOUT_STATE);
    window.history.replaceState(window.history.state, '', url.toString());
    return true;
  } catch {
    return false;
  }
};
