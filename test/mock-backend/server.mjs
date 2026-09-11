/**
 * Mock backend — stands in for the PHP API so the frontend can be run and inspected without
 * PHP, MySQL or a real account. Speaks the same shapes as `api/*.php` (plain JSON, no envelope)
 * on the same paths, so the Vite dev proxy forwards to it unchanged.
 *
 *   node test/mock-backend/server.mjs         # this alone, on :8000
 *   npm run dev:mock                          # same thing
 *   npm run dev:web:mock                      # mock backend + Vite dev server together
 *
 * It is a fixture server, not a simulator: reads return data from `fixtures.mjs`, writes are
 * acknowledged and kept in memory for the lifetime of the process (so a rename or delete
 * sticks until restart) but nothing is persisted or validated. Anything it does not know
 * answers `{}` — enough to keep the UI from erroring on endpoints a given screen ignores.
 *
 * Add an endpoint by extending `handlers` below; add data by editing `fixtures.mjs`.
 */
import { createServer } from 'node:http';
import * as fixtures from './fixtures.mjs';

const PORT = Number(process.env.MOCK_PORT ?? 8000);

/** Mutable copies, so writes within one run are visible to later reads. */
const state = {
  songs: structuredClone(fixtures.songs),
  songDetails: structuredClone(fixtures.songDetails),
  shows: structuredClone(fixtures.shows),
  setLists: structuredClone(fixtures.setLists),
  bands: structuredClone(fixtures.bands),
  /** Viewer token, minted on POST /rest/AccountTokens. Null until one is generated. */
  viewerToken: null,
  /** Stage-monitor layers. Stateful so cue editing can actually be tried out locally. */
  stageLayers: [],
};

let nextStageLayerId = 1;
let nextBandId = 3;

/** GET /rest/Session — an authenticated, non-admin session for account 1. */
const session = () => ({
  account: fixtures.account.license,
  // The account's display name — what the app labels the current session with.
  name: fixtures.account.name,
  mail: fixtures.account.mail,
  isAuthenticated: true,
  authType: 'oidc',
  // `viewerUrl` mirrors VIEWER_URL in config.php — a viewer deployed on its own
  // subdomain, which is the case the fallback (<app>/viewer/) gets wrong.
  // `viewerUrl` mirrors VIEWER_URL in config.php. Null by default (the viewer is then
  // assumed to sit under this app's origin); set MOCK_VIEWER_URL to exercise the common
  // real-world case of the viewer living on its own subdomain.
  settings: {
    // `DEVELOPMENT` in config.php, which raises the dev banner on every page. On by
    // default here — running against the mock backend is about as dev as it gets. Set
    // MOCK_DEVELOPMENT=0 to see the pages without it.
    development: process.env.MOCK_DEVELOPMENT !== '0',
    bibleEnabled: true,
    churchToolsEnabled: true,
    // Null unless MOCK_WS_HOST is set, which points the app at a locally running relay
    // (`node ws-server/dist/server.js`). Needed to try anything that talks between the
    // operator and the musician page — sync, the mobile remote, monitor mixing.
    wsHost: process.env.MOCK_WS_HOST
      ? { host: process.env.MOCK_WS_HOST, port: Number(process.env.MOCK_WS_PORT ?? 9001), wss: false }
      : null,
    viewerUrl: process.env.MOCK_VIEWER_URL ?? null,
  },
});

/** Admin session variant: run with MOCK_ADMIN=1 to reach the /admin routes. */
const isAdmin = process.env.MOCK_ADMIN === '1';

/**
 * Route table. Keys are matched as prefixes against the path, longest key first, so
 * `/rest/SongsAll` wins over `/rest/Song`. Each handler gets { path, method, body, query }.
 */
const handlers = {
  '/rest/Session': (req) =>
    req.method === 'DELETE' ? { message: 'logged out' } : { ...session(), authType: isAdmin ? 'oidc_admin' : 'oidc' },
  '/rest/Accounts': () => [{ license: fixtures.account.license, name: fixtures.account.name }],
  '/rest/AccountSettings': () => ({ defaultStyleId: null, showTitleTemplate: 'Show {dd}.{MM}.{yyyy}', languages: ['EN', 'DE'] }),
  // Viewer token. GET reports whether one exists; POST mints one and returns it in full
  // (the only time the server ever does), DELETE revokes. Kept in `state` so the reveal
  // dialog and the "token exists" chip behave like the real thing for the life of the run.
  '/rest/AccountTokens': (req) => {
    if (req.method === 'POST') {
      state.viewerToken = Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
      return { token: state.viewerToken, message: 'Token generated' };
    }
    if (req.method === 'DELETE') {
      state.viewerToken = null;
      return { message: 'Token revoked' };
    }
    return state.viewerToken
      ? { hasToken: true, tokenPrefix: `${state.viewerToken.slice(0, 8)}...` }
      : { hasToken: false, tokenPrefix: null };
  },

  '/rest/SongsAll': () => state.songs,
  '/rest/SongsSearch': (req) => filterSongs(req.query.q),
  '/rest/SongsRevision': () => ({
    songs: state.songs.map((s) => ({ songNumber: s.songNumber, updatedAt: '2026-08-01 10:00:00' })),
    count: state.songs.length,
  }),
  '/rest/SongExists': () => ({ exists: false }),
  '/rest/SongRenumber': () => ({ message: 'renumbered (mock)', showsUpdated: 0 }),
  '/rest/Song': (req) => {
    const number = Number(req.path.split('/')[3]);
    if (req.method === 'DELETE') return { message: 'deleted (mock)' };
    if (req.method === 'POST' || req.method === 'PUT') return { ...req.body, songNumber: req.body?.songNumber || 999999 };
    return state.songDetails[number] ?? fallbackSong(number);
  },

  '/rest/ShowsRevision': () => ({ shows: state.shows.map((s) => ({ title: s.title, date: s.date })), count: state.shows.length }),
  '/rest/Shows': (req) => {
    if (req.method === 'DELETE') {
      state.shows = state.shows.filter((s) => s.title !== req.body?.title);
      return { message: 'deleted (mock)' };
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      const incoming = { ...req.body, date: new Date().toISOString().slice(0, 19).replace('T', ' ') };
      const index = state.shows.findIndex((s) => s.title === incoming.title);
      if (index >= 0) state.shows[index] = { ...state.shows[index], ...incoming };
      else state.shows.unshift(incoming);
      return { message: 'saved (mock)' };
    }
    // GET /rest/Shows/{limit}/{page}, optionally ?title=
    const [, , , limitRaw = '10', pageRaw = '0'] = req.path.split('/');
    const limit = Number(limitRaw) || 10;
    const page = Number(pageRaw) || 0;
    const matching = req.query.title ? state.shows.filter((s) => s.title === req.query.title) : state.shows;
    return { limit, offset: page * limit, shows: matching.slice(page * limit, page * limit + limit) };
  },

  '/rest/SetListEntries': (req) => (req.method === 'DELETE' ? { message: 'deleted (mock)' } : { message: 'saved (mock)' }),
  '/rest/SetLists': (req) => {
    if (req.method === 'GET') return state.setLists;
    if (req.method === 'DELETE') {
      state.setLists = state.setLists.filter((l) => l.id !== req.body?.id);
      return { message: 'deleted (mock)' };
    }
    if (req.method === 'POST') {
      const created = {
        id: Date.now() % 100000,
        name: req.body?.name ?? 'Neu',
        bandIds: req.body?.bandIds ?? [],
        sortOrder: state.setLists.length,
        entries: [],
      };
      state.setLists.push(created);
      return created;
    }
    // PUT /rest/SetLists/{id} — partial: name, bands, or both.
    const idFromPath = Number(req.path.split('/')[3]);
    const target = state.setLists.find((l) => l.id === (Number.isFinite(idFromPath) ? idFromPath : req.body?.id));
    if (target) {
      if (req.body?.name) target.name = req.body.name;
      if (req.body?.bandIds !== undefined) target.bandIds = req.body.bandIds;
    }
    return { message: 'saved (mock)' };
  },

  /** Bands, with real CRUD — the settings editor round-trips every edit through here. */
  '/rest/Bands': (req) => {
    const idFromPath = Number(req.path.split('/')[3]);

    if (req.method === 'POST') {
      const band = {
        id: nextBandId++,
        name: req.body?.name ?? 'Band',
        color: req.body?.color ?? null,
        members: req.body?.members ?? [],
        sortOrder: state.bands.length,
      };
      state.bands.push(band);
      return band;
    }

    if (req.method === 'PUT') {
      if (req.path.endsWith('/reorder')) {
        const order = req.body?.order ?? [];
        state.bands.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        state.bands.forEach((band, index) => (band.sortOrder = index));
        return { message: 'Bands reordered', order };
      }
      const band = state.bands.find((b) => b.id === idFromPath);
      // Partial update, exactly like the real endpoint: only the keys that were sent.
      if (band) {
        for (const key of ['name', 'color', 'members']) {
          if (req.body?.[key] !== undefined) band[key] = req.body[key];
        }
      }
      return band ?? { message: 'Band updated' };
    }

    if (req.method === 'DELETE') {
      state.bands = state.bands.filter((b) => b.id !== idFromPath);
      // The real backend cascades the assignments; mirror that so the chips disappear too.
      for (const show of state.shows) show.bandIds = (show.bandIds ?? []).filter((id) => id !== idFromPath);
      for (const list of state.setLists) list.bandIds = (list.bandIds ?? []).filter((id) => id !== idFromPath);
      return { message: 'Band deleted' };
    }

    return state.bands;
  },

  '/rest/ShowItemTypes': () => [],

  /**
   * Stage-monitor layers, with real CRUD — a stub returning `[]` would make the panel look
   * broken, since every edit round-trips through here.
   */
  '/rest/StageLayers': (req) => {
    const idFromPath = Number(req.path.split('/')[3]);

    if (req.method === 'POST') {
      const layer = {
        id: nextStageLayerId++,
        name: req.body?.name ?? 'Stage layer',
        enabled: req.body?.enabled ?? true,
        sort_order: req.body?.sort_order ?? state.stageLayers.length,
        data: req.body?.data ?? { placement: {}, style: {}, cues: [] },
      };
      state.stageLayers.push(layer);
      return { id: layer.id, name: layer.name, enabled: layer.enabled, message: 'Stage layer created' };
    }

    if (req.method === 'PUT') {
      const layer = state.stageLayers.find((l) => l.id === idFromPath);
      // Partial update, exactly like the real endpoint: only the keys that were sent.
      if (layer) {
        for (const key of ['name', 'enabled', 'sort_order', 'data']) {
          if (req.body?.[key] !== undefined) layer[key] = req.body[key];
        }
      }
      return { message: 'Stage layer updated', id: idFromPath };
    }

    if (req.method === 'DELETE') {
      state.stageLayers = state.stageLayers.filter((l) => l.id !== idFromPath);
      return { message: 'Stage layer deleted' };
    }

    if (Number.isFinite(idFromPath)) {
      return state.stageLayers.find((l) => l.id === idFromPath) ?? {};
    }
    return state.stageLayers;
  },
  '/rest/Styles': () => [],
  '/rest/PdfAnnotations': () => [],
  '/rest/PdfIcons': () => [],
  '/rest/Pdfs': () => [],
  '/rest/BibleTranslations': () => [],
  '/rest/BibleVerses': () => ({ verses: [] }),
  '/rest/LanguageTags': () => ['DE', 'EN'],
  '/rest/Search': (req) => filterSongs(req.query.q ?? req.query.search),
  '/rest/Metrics': () => ({ message: 'recorded (mock)' }),
  '/rest/Log': () => ({ message: 'logged (mock)' }),
  '/rest/ValidateToken': () => ({ valid: true }),
  // The event picker reads `events` off the answer, so a bare [] makes it throw
  // ("incoming is not iterable") before the new-show dialog can even paint.
  '/rest/ChurchToolsEvents': () => ({ events: [] }),
  '/rest/ChurchToolsSongs': () => [],

  '/rest/AdminAccounts': () => fixtures.adminAccounts,

  /**
   * Monitor ticket for the admin WebSocket tab. Needs a relay to point at, so it only
   * answers when MOCK_WS_URL is set — e.g.
   *   MOCK_WS_URL=ws://127.0.0.1:9001 MOCK_ADMIN=1 npm run dev:mock
   * Run that relay with BACKEND_URL pointing back here so it can validate the token below.
   */
  '/rest/AdminWsMonitor': () =>
    process.env.MOCK_WS_URL
      ? { token: 'mock-admin-monitor', expiresIn: 120, url: process.env.MOCK_WS_URL }
      : { error: 'Set MOCK_WS_URL to use the WebSocket monitor against the mock backend.' },

  /** Called by the relay, not the browser. Accepts only the fixed mock token above. */
  '/rest/ValidateMonitorToken': (req) =>
    (req.query?.token ?? '') === 'mock-admin-monitor' ? { scope: 'admin', account: null } : { error: 'Invalid monitor token.' },
  '/rest/AdminProviders': () => [],
  '/rest/AdminMigrations': () => ({ currentVersion: 19, latestVersion: 19, pendingCount: 0, migrations: [] }),
  '/rest/AdminConfig': () => ({
    server: {},
    app: {},
    database: {},
    cors: { allowedOrigins: [] },
    oidc: { scopes: [] },
    bible: {},
    wsHost: null,
    // Mirrors a dev deployment carrying dev-environment/DbCopy.php plus a copy.config.php,
    // which is what makes the "copy from another database" card appear.
    devTools: { dbCopy: process.env.MOCK_DB_COPY !== '0' },
  }),
  '/rest/DbCopy': (req) => {
    const tables = [
      { name: 'account', rows: 3, mode: 'data' },
      { name: 'songs', rows: 412, mode: 'data' },
      { name: 'blocks', rows: 2874, mode: 'data' },
      { name: 'metrics', rows: 0, mode: 'structure' },
      { name: 'logs_archive', rows: 0, mode: 'excluded' },
    ];
    const replacements = [
      { from: 'https://presenter.example.com', to: 'https://dev.presenter.example.com' },
      { from: 'http://presenter.example.com', to: 'https://dev.presenter.example.com' },
    ];
    const dataDir = { configured: true, readable: true, source: '/srv/presenter/data', target: '/srv/dev/data' };

    if (req.method !== 'POST') {
      return {
        source: { url: 'https://presenter.example.com', host: 'prod-sql', database: 'presenter_prod', schemaVersion: 17 },
        target: { url: 'https://dev.presenter.example.com', host: 'localhost', database: 'presenter_dev', schemaVersion: 19 },
        replacements,
        tables,
        dataDir,
      };
    }

    const dryRun = !!req.body?.dryRun;
    const copied = tables.filter((t) => t.mode !== 'excluded');
    return {
      dryRun,
      tables: copied,
      rowsCopied: 3289,
      replacements,
      rewrites: dryRun ? [] : [{ column: 'songs.background', rows: 46 }],
      rowsRewritten: dryRun ? 0 : 46,
      dataFiles: dryRun ? null : 128,
      dataDir,
      schemaVersion: 17,
      durationMs: 4200,
    };
  },
  '/rest/AdminSongs': (req) => {
    if (req.method !== 'POST') return fixtures.adminSongs;
    const { sourceNumber, targetNumber, dryRun } = req.body ?? {};
    return {
      message: dryRun
        ? `Preview of merging #${sourceNumber} into #${targetNumber}`
        : `Song #${sourceNumber} was replaced by #${targetNumber}`,
      dryRun: !!dryRun,
      license: req.body?.license ?? 1,
      sourceNumber,
      targetNumber,
      sourceTitle: 'Way  Maker!',
      targetTitle: 'Way Maker',
      setLists: { repointed: [], dropped: ['Sonntagsband'] },
      shows: { repointed: ['Probe 12.08.2026'], dropped: [] },
      clearedOrderNames: 1,
      deleted: { blocks: 4, pdfMappings: 0, pdfAnnotations: 0, pdfFiles: 0 },
    };
  },
};

const filterSongs = (query) => {
  const needle = String(query ?? '').toLowerCase();
  if (!needle) return state.songs;
  return state.songs.filter((s) => s.title.toLowerCase().includes(needle) || String(s.songNumber).includes(needle));
};

/** Any song number the fixtures do not cover still resolves, so the UI never dead-ends. */
const fallbackSong = (number) => ({
  account: 1,
  songNumber: number,
  title: state.songs.find((s) => s.songNumber === number)?.title ?? `Song #${number}`,
  authors: state.songs.find((s) => s.songNumber === number)?.authors ?? '',
  copyright: '',
  initialOrder: ['Verse 1'],
  order: { Default: ['Verse 1'] },
  blocks: { 'Verse 1': ['[placeholder]'] },
  styleId: null,
  ccliNumber: null,
  key: null,
  updatedAt: '2026-01-01 00:00:00',
});

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
  });

// Longest prefix first: '/rest/SongsAll' must be tested before '/rest/Song'.
const routes = Object.keys(handlers).sort((a, b) => b.length - a.length);

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const body = req.method === 'GET' ? null : await readBody(req);
  const query = Object.fromEntries(url.searchParams);

  const route = routes.find((prefix) => path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + '?'));
  const handler = route ? handlers[route] : null;

  let payload = {};
  let status = 200;
  try {
    payload = handler ? handler({ path, method: req.method, body, query }) : {};
    if (!handler) status = 200; // unknown endpoints answer {} rather than 404 — see the header comment
  } catch (error) {
    status = 500;
    payload = { error: String(error) };
  }

  console.log(`${req.method} ${path} → ${status}${handler ? '' : ' (unmapped)'}`);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=UTF-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(payload));
}).listen(PORT, () => {
  console.log(`Mock backend listening on http://localhost:${PORT}${isAdmin ? ' (admin session)' : ''}`);
});
