import { presenterApi } from './base.api';
import type { ApiSuccess } from './base.api';

export type AdminAccount = {
  license: number;
  mail: string;
  name?: string | null;
  active: boolean;
  created_at: string;
  lastactivity: string;
  church_tools_url?: string | null;
  /** True if both URL and token are configured server-side. Token is never sent to the client. */
  church_tools_enabled: boolean;
  providers: Array<{
    provider_id: number;
    provider_name: string;
    is_default: boolean;
  }>;
};

export type OidcProvider = {
  id: number;
  name: string;
  discovery_url: string;
  client_id: string;
  client_secret: string;
  scopes: string;
  required_group?: string | null;
  enabled: boolean;
  created_at: string;
};

export type CreateAccountRequest = {
  license: number;
  mail: string;
  name?: string;
  active?: boolean;
};

export type UpdateAccountRequest = {
  license: number;
  mail?: string;
  name?: string;
  active?: boolean;
  /** ChurchTools instance URL, e.g. https://demo.church.tools/api/ */
  churchToolsUrl?: string | null;
  /** ChurchTools API login token. Pass empty string to clear. */
  churchToolsToken?: string | null;
};

export type CreateProviderRequest = {
  name: string;
  discovery_url: string;
  client_id: string;
  client_secret: string;
  scopes?: string;
  required_group?: string;
  enabled?: boolean;
};

export type UpdateProviderRequest = {
  id: number;
  name?: string;
  discovery_url?: string;
  client_id?: string;
  client_secret?: string;
  scopes?: string;
  required_group?: string;
  enabled?: boolean;
};

export type AssignProviderRequest = {
  license: number;
  provider_id: number;
  is_default?: boolean;
};

export type UnassignProviderRequest = {
  license: number;
  provider_id: number;
};

export type MigrationEntry = {
  version: number;
  description: string;
  applied: boolean;
  appliedAt: string | null;
};

export type MigrationStatus = {
  currentVersion: number;
  latestVersion: number;
  pendingCount: number;
  migrations: MigrationEntry[];
};

export type RunMigrationsResult = {
  message: string;
  currentVersion: number;
  applied: Array<{ version: number; description: string; output: string }>;
  errors: Array<{ version: number; description: string; error: string }>;
};

export type AdminConfigData = {
  server: {
    phpVersion: string | null;
    phpSapi: string | null;
    serverSoftware: string | null;
    mysqlVersion: string | null;
  };
  app: {
    domain: string | null;
    baseUrl: string | null;
    development: boolean;
    defaultLanguage: string | null;
    searchResultLimit: number | null;
    customNumberLimit: number | null;
  };
  database: {
    host: string | null;
    database: string | null;
    user: string | null;
  };
  cors: {
    allowedOrigins: string[];
  };
  oidc: {
    discoveryUrl: string | null;
    clientId: string | null;
    adminGroup: string | null;
    requiredGroup: string | null;
    redirectUri: string | null;
    scopes: string[];
  };
  bible: {
    enabled: boolean;
    name: string | null;
    baseUrl: string | null;
    translationsEndpoint: string | null;
    verseEndpoint: string | null;
  };
  wsHost: {
    wss?: boolean;
    host: string;
    port: number;
    path?: string;
  } | null;
  /** Endpoints that only exist on a dev deployment — see api/DbCopy.php. */
  devTools: {
    /** True when both the endpoint and its copy.config.php are present. */
    dbCopy: boolean;
  };
};

/** One table in a database-copy plan. */
export type DbCopyTable = {
  name: string;
  /** Source row count. Zero for anything not copied with its data. */
  rows: number;
  mode: 'data' | 'structure' | 'excluded';
};

export type DbCopyReplacement = { from: string; to: string };

export type DbCopyDataDir = {
  configured: boolean;
  readable: boolean;
  source: string;
  target: string;
};

export type DbCopyStatus = {
  source: { url: string; host: string; database: string; schemaVersion: number | null };
  target: { url: string; host: string; database: string; schemaVersion: number | null };
  replacements: DbCopyReplacement[];
  tables: DbCopyTable[];
  dataDir: DbCopyDataDir;
};

export type DbCopyResult = {
  dryRun: boolean;
  tables: DbCopyTable[];
  rowsCopied: number;
  replacements: DbCopyReplacement[];
  /** Columns the URL rewrite actually changed. */
  rewrites: Array<{ column: string; rows: number }>;
  rowsRewritten: number;
  /** Number of uploaded files copied, or null when file copying is not configured. */
  dataFiles: number | null;
  dataDir: DbCopyDataDir;
  schemaVersion: number | null;
  durationMs: number;
};

export type RunDbCopyRequest = {
  dryRun?: boolean;
  /** Restrict the copy to these tables. Empty or omitted means all of them. */
  tables?: string[];
};

/** One row of an account's song library, as seen by the admin panel. */
export type AdminSong = {
  songNumber: number;
  title: string;
  authors: string;
  copyright: string;
  ccliNumber: string | null;
  key: string | null;
  updatedAt: string | null;
  /** Number of named block orders. */
  orderCount: number;
  blockCount: number;
  /** Number of PDFs with stored area mappings. */
  pdfCount: number;
  annotationCount: number;
  /** Titles of the shows referencing this song. */
  shows: string[];
  /** Names of the set lists referencing this song. */
  setLists: string[];
};

/** Songs that look like duplicates of each other (shared CCLI number or normalized title). */
export type AdminSongDuplicateGroup = {
  id: number;
  reasons: Array<'ccli' | 'title'>;
  songNumbers: number[];
};

export type AdminSongLibrary = {
  license: number;
  songs: AdminSong[];
  groups: AdminSongDuplicateGroup[];
};

export type MergeSongsRequest = {
  license: number;
  /** The song that gets replaced and deleted. */
  sourceNumber: number;
  /** The song that survives and inherits every reference. */
  targetNumber: number;
  /** Run the merge in a rolled-back transaction to preview its effect. */
  dryRun?: boolean;
};

export type MergeSongsResult = {
  message: string;
  dryRun: boolean;
  license: number;
  sourceNumber: number;
  targetNumber: number;
  sourceTitle: string;
  targetTitle: string;
  /** Set lists whose entry was repointed, and those where the source entry was dropped as a duplicate. */
  setLists: { repointed: string[]; dropped: string[] };
  shows: { repointed: string[]; dropped: string[] };
  /** References to a named order the target song does not have; those were cleared. */
  clearedOrderNames: number;
  deleted: { blocks: number; pdfMappings: number; pdfAnnotations: number; pdfFiles: number };
};

/**
 * A one-shot ticket for attaching to the WebSocket relay as a message monitor.
 * Short-lived by design — request a fresh one for every connection attempt.
 */
export type WsMonitorTicket = {
  token: string;
  /** Seconds the token stays valid. */
  expiresIn: number;
  /** Relay URL derived from WS_HOST, e.g. wss://presenter.example.com:443/ws */
  url: string;
};

const adminApi = presenterApi.injectEndpoints({
  endpoints: (build) => ({
    // ──────── Admin: Accounts ────────
    getAdminAccounts: build.query<ApiSuccess<AdminAccount[]>, void>({
      query: () => 'rest/AdminAccounts',
      providesTags: [{ type: 'AdminAccounts', id: 'LIST' }],
    }),
    createAdminAccount: build.mutation<ApiSuccess<{ message: string; license: number }>, CreateAccountRequest>({
      query: (body) => ({ url: 'rest/AdminAccounts', method: 'POST', body }),
      invalidatesTags: [{ type: 'AdminAccounts', id: 'LIST' }],
    }),
    updateAdminAccount: build.mutation<ApiSuccess<{ message: string }>, UpdateAccountRequest>({
      query: (body) => ({ url: 'rest/AdminAccounts', method: 'PUT', body }),
      invalidatesTags: [{ type: 'AdminAccounts', id: 'LIST' }],
    }),
    deleteAdminAccount: build.mutation<ApiSuccess<{ message: string }>, { license: number }>({
      query: (body) => ({ url: 'rest/AdminAccounts', method: 'DELETE', body }),
      invalidatesTags: [{ type: 'AdminAccounts', id: 'LIST' }],
    }),

    // ──────── Admin: Providers ────────
    getAdminProviders: build.query<ApiSuccess<OidcProvider[]>, void>({
      query: () => 'rest/AdminProviders',
      providesTags: [{ type: 'AdminProviders', id: 'LIST' }],
    }),
    createAdminProvider: build.mutation<ApiSuccess<{ message: string; id: number }>, CreateProviderRequest>({
      query: (body) => ({ url: 'rest/AdminProviders', method: 'POST', body }),
      invalidatesTags: [{ type: 'AdminProviders', id: 'LIST' }],
    }),
    updateAdminProvider: build.mutation<ApiSuccess<{ message: string }>, UpdateProviderRequest>({
      query: (body) => ({ url: 'rest/AdminProviders', method: 'PUT', body }),
      invalidatesTags: (_res, _err, arg) => [
        { type: 'AdminProviders', id: 'LIST' },
        { type: 'AdminAccounts', id: arg.id },
      ],
    }),
    deleteAdminProvider: build.mutation<ApiSuccess<{ message: string }>, { id: number }>({
      query: (body) => ({ url: 'rest/AdminProviders', method: 'DELETE', body }),
      invalidatesTags: [
        { type: 'AdminProviders', id: 'LIST' },
        { type: 'AdminAccounts', id: 'LIST' },
      ],
    }),
    assignProviderToAccount: build.mutation<ApiSuccess<{ message: string }>, AssignProviderRequest>({
      query: (body) => ({ url: 'rest/AdminAccountProviders', method: 'POST', body }),
      invalidatesTags: [{ type: 'AdminAccounts', id: 'LIST' }],
    }),
    unassignProviderFromAccount: build.mutation<ApiSuccess<{ message: string }>, UnassignProviderRequest>({
      query: (body) => ({ url: 'rest/AdminAccountProviders', method: 'DELETE', body }),
      invalidatesTags: [{ type: 'AdminAccounts', id: 'LIST' }],
    }),

    // ──────── Admin: Migrations ────────
    getAdminMigrations: build.query<ApiSuccess<MigrationStatus>, void>({
      query: () => 'rest/AdminMigrations',
      providesTags: ['AdminMigrations'],
    }),
    runAdminMigrations: build.mutation<ApiSuccess<RunMigrationsResult>, void>({
      query: () => ({ url: 'rest/AdminMigrations', method: 'POST' }),
      invalidatesTags: ['AdminMigrations'],
    }),

    // ──────── Admin: Songs ────────
    getAdminSongs: build.query<ApiSuccess<AdminSongLibrary>, { license: number }>({
      query: ({ license }) => `rest/AdminSongs/${license}`,
      providesTags: (_res, _err, arg) => [{ type: 'AdminSongs', id: arg.license }],
    }),
    mergeAdminSongs: build.mutation<ApiSuccess<MergeSongsResult>, MergeSongsRequest>({
      query: (body) => ({ url: 'rest/AdminSongs', method: 'POST', body }),
      // A dry run changes nothing — invalidating would refetch the library on every preview.
      invalidatesTags: (_res, _err, arg) => (arg.dryRun ? [] : [{ type: 'AdminSongs', id: arg.license }]),
    }),

    // ──────── Admin: Database copy (dev deployments only) ────────
    getDbCopyStatus: build.query<ApiSuccess<DbCopyStatus>, void>({
      query: () => 'rest/DbCopy',
      providesTags: ['DbCopy'],
    }),
    runDbCopy: build.mutation<ApiSuccess<DbCopyResult>, RunDbCopyRequest>({
      query: (body) => ({ url: 'rest/DbCopy', method: 'POST', body }),
      // A real copy replaces the schema wholesale, so the migration list is stale
      // afterwards — that is where the user goes next. A dry run changes nothing.
      invalidatesTags: (_res, _err, arg) => (arg.dryRun ? [] : ['DbCopy', 'AdminMigrations']),
    }),

    // ──────── Admin: Config ────────
    getAdminConfig: build.query<ApiSuccess<AdminConfigData>, void>({
      query: () => 'rest/AdminConfig',
      providesTags: ['AdminConfig'],
    }),

    // ──────── Admin: WebSocket monitor ────────
    // A mutation rather than a query: it mints a credential with a side effect (a new
    // token each time), so it must never be served from a cache.
    createWsMonitorTicket: build.mutation<ApiSuccess<WsMonitorTicket>, void>({
      query: () => ({ url: 'rest/AdminWsMonitor', method: 'POST' }),
    }),
  }),
  overrideExisting: false,
});

export const {
  useGetAdminAccountsQuery,
  useCreateAdminAccountMutation,
  useUpdateAdminAccountMutation,
  useDeleteAdminAccountMutation,
  useGetAdminProvidersQuery,
  useCreateAdminProviderMutation,
  useUpdateAdminProviderMutation,
  useDeleteAdminProviderMutation,
  useAssignProviderToAccountMutation,
  useUnassignProviderFromAccountMutation,
  useGetAdminSongsQuery,
  useMergeAdminSongsMutation,
  useGetAdminMigrationsQuery,
  useRunAdminMigrationsMutation,
  useGetAdminConfigQuery,
  useGetDbCopyStatusQuery,
  useRunDbCopyMutation,
  useCreateWsMonitorTicketMutation,
} = adminApi;
