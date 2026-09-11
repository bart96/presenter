import { presenterApi } from './base.api';
import type { ApiSuccess } from './base.api';

export type WsHost = {
  host: string;
  port: number;
  path?: string;
  wss?: boolean;
};

export type SessionInfo = {
  account: number;
  /** Display name of the account (the one picked on the login page). Empty when unset. */
  name?: string;
  mail: string;
  isAuthenticated?: boolean;
  authType?: 'oidc' | 'oidc_admin' | null;
  settings?: {
    /** `DEVELOPMENT` in the backend's config.php. Drives the dev banner — see devBanner.ts. */
    development?: boolean;
    bibleEnabled: boolean;
    churchToolsEnabled?: boolean;
    wsHost?: WsHost;
    /**
     * Base URL of the deployed text viewer (`VIEWER_URL` in config.php), without a
     * trailing slash. Null when unset — the viewer is then assumed to sit under this
     * app's own origin.
     */
    viewerUrl?: string | null;
  };
};

export type OidcAuthUrlResponse = {
  url: string;
};

export type AccountListItem = {
  license: number;
  name?: string | null;
};

export type AccountSettingsData = {
  defaultStyleId: number | null;
  showTitleTemplate: string | null;
  /**
   * The pool of language codes songs may be written in, shared by everyone on the account.
   * Ordered: the first entry is the default offered to a new song. Always at least one entry.
   */
  languages: string[];
};

const sessionApi = presenterApi.injectEndpoints({
  endpoints: (build) => ({
    // ──────── Session ────────
    getSession: build.query<ApiSuccess<SessionInfo>, void>({
      query: () => 'rest/Session',
      providesTags: ['Session'],
    }),
    logout: build.mutation<ApiSuccess<{ message: string }>, void>({
      query: () => ({ url: 'rest/Session', method: 'DELETE' }),
      invalidatesTags: ['Session'],
    }),
    getOidcAuthUrl: build.query<ApiSuccess<OidcAuthUrlResponse>, { redirect?: string; license?: number } | void>({
      query: (arg) => ({
        url: 'rest/Session/oidc-auth-url',
        params: {
          ...(arg && 'redirect' in arg ? { redirect: arg.redirect } : {}),
          ...(arg && 'license' in arg ? { license: arg.license } : {}),
        },
      }),
    }),
    getAdminOidcAuthUrl: build.query<ApiSuccess<OidcAuthUrlResponse>, { redirect?: string } | void>({
      query: (arg) => ({
        url: 'rest/Session/oidc-auth-url',
        params: { ...(arg && 'redirect' in arg ? { redirect: arg.redirect } : {}), admin: 1 },
      }),
    }),

    // ──────── Accounts (public) ────────
    getAccounts: build.query<ApiSuccess<AccountListItem[]>, void>({
      query: () => 'rest/Accounts',
    }),

    // ──────── Account Settings (server-side, per-account) ────────
    getAccountSettings: build.query<ApiSuccess<AccountSettingsData>, void>({
      query: () => 'rest/AccountSettings',
      providesTags: ['AccountSettings'],
    }),
    updateAccountSettings: build.mutation<ApiSuccess<AccountSettingsData & { message: string }>, Partial<AccountSettingsData>>({
      query: (body) => ({ url: 'rest/AccountSettings', method: 'PUT', body }),
      invalidatesTags: ['AccountSettings'],
    }),
  }),
  overrideExisting: false,
});

export const {
  useGetSessionQuery,
  useLazyGetSessionQuery,
  useLogoutMutation,
  useGetOidcAuthUrlQuery,
  useGetAdminOidcAuthUrlQuery,
  useGetAccountsQuery,
  useGetAccountSettingsQuery,
  useUpdateAccountSettingsMutation,
} = sessionApi;
