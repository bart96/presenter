import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { BaseQueryFn, FetchArgs, FetchBaseQueryError } from '@reduxjs/toolkit/query';

import { getSetting } from '@/store/settingsSlice';
import { isElectronApp } from '@/utils';

/** Custom event dispatched when the session has expired (401 from backend) */
export const SESSION_EXPIRED_EVENT = 'presenter:session-expired';

/** Generic wrapper that preserves the response type. Used by all endpoint slices. */
export type ApiSuccess<T> = T;

// ─────────────────────────────────────────────
// Base API instance
// ─────────────────────────────────────────────

/**
 * Base URL for backend requests. Resolved per request so a changed setting applies at once.
 *
 * Only the desktop app uses the configured `backendUrl`: it loads its pages from file:// and
 * has no other way to know the server. The browser build is always served by the backend it
 * talks to, so it uses relative URLs and ignores the setting. A value left over from an older
 * version would otherwise send every request to an origin this page holds no session cookie
 * for — a device that logs in fine and then sees no data. In the Vite dev server, relative
 * URLs go through its proxy (see vite.shared.ts).
 */
export const getBackendBaseUrl = (): string => {
  if (!isElectronApp()) return '';
  try {
    const backendUrl = getSetting('backendUrl');

    if (backendUrl !== undefined && backendUrl !== null) {
      // Normalize: trim whitespace and trailing slashes
      return String(backendUrl).trim().replace(/\/+$/, '');
    }
  } catch {}
  // Default: same as settingsSlice so the displayed value matches actual requests
  return '';
};

/**
 * Dynamic base query — resolves the backend URL on every request so that
 * changes made by ConnectivityChecker or Settings take effect immediately.
 * In offline mode all backend requests are skipped and return empty data.
 */
const dynamicBaseQuery: BaseQueryFn<string | FetchArgs, unknown, FetchBaseQueryError> = async (args, api, extraOptions) => {
  // Offline mode: skip all backend API calls silently.
  try {
    if (getSetting('offlineMode')) {
      // Resolve as success-with-no-data rather than an error, so offline never paints
      // error states. `undefined` (not null) is deliberate: consumers overwhelmingly read
      // the result via a destructuring default — `const { data: styles = [] } = ...` — and
      // those only fire for undefined. Returning null left them holding null and crashed
      // on the first `.length`.
      return { data: undefined };
    }
  } catch {}

  const baseUrl = getBackendBaseUrl();
  const rawBaseQuery = fetchBaseQuery({
    baseUrl: baseUrl ? `${baseUrl}/` : '/',
    credentials: 'include',
    prepareHeaders: (headers) => {
      headers.set('Accept', 'application/json');
      return headers;
    },
  });

  const result = await rawBaseQuery(args, api, extraOptions);

  // Detect 401 and broadcast session-expired (except for Session endpoint itself)
  if (result.error && result.error.status === 401) {
    const url = typeof args === 'string' ? args : args.url;
    if (!url.includes('rest/Session')) {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
    }
  }

  return result;
};

/**
 * Base RTK Query API instance.
 * Endpoints are injected per domain in the sibling slice files.
 */
export const presenterApi = createApi({
  reducerPath: 'presenterApi',
  baseQuery: dynamicBaseQuery,
  tagTypes: [
    'AccountSettings',
    'AdminAccounts',
    'AdminConfig',
    'AdminMigrations',
    'AdminProviders',
    'AdminSongs',
    'Bands',
    'DbCopy',
    'Logs',
    'Metrics',
    'PdfAnnotations',
    'PdfIcons',
    'Pdfs',
    'Session',
    'SetLists',
    'ShowItemTypes',
    'Shows',
    'Song',
    'Songs',
    'StageLayers',
    'Styles',
    'ViewerToken',
  ],
  endpoints: () => ({}),
});
