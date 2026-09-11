/**
 * Presenter WebSocket Relay Server
 *
 * Each client must send an auth message as the first message after connecting.
 * Two auth modes are supported:
 *
 *   { "action": "auth", "account": <number> }          — direct account number
 *   { "action": "auth", "token":   "<hex64>" }         — viewer token (resolved
 *                                                          via BACKEND_URL)
 *
 * The auth message may carry an optional `client` descriptor
 * ({ role, mode, name }) describing what kind of client this is. It is relayed
 * back to every peer of the account in `peer_count`, so the operator can show
 * WHO is connected instead of just how many. Clients whose kind changes at
 * runtime (a musician switching sync mode) send { "action": "client_info",
 * "client": {…} } instead of reconnecting.
 *
 * Only authenticated clients are kept. Messages are relayed only to other
 * clients that share the same account number.
 *
 * Environment variables:
 *   PORT              — WebSocket listen port (default: 9001)
 *   BACKEND_URL       — Base URL of the PHP backend, e.g. https://presenter.example.com
 *                       Required for token-based auth.
 *   SYNC_TTL_SECONDS  — How long the cached selection stays current (default: 3600 = 1 h,
 *                       0 = never expire). See "Selection TTL" below.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Read the version out of package.json at startup and print it, so the container log
 * says which build is actually running — the relay is deployed as a pre-built zip and
 * there is otherwise no way to tell one image from another after the fact.
 *
 * `package.json` sits one level above both `src/` (ts-node) and `dist/` (the container's
 * `/app/dist/server.js`), and the Dockerfile copies it into the image for exactly this.
 * A missing or unreadable file must never stop the relay from starting.
 */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

const VERSION = readVersion();

const PORT = Number(process.env.PORT ?? 9001);
const BACKEND_URL = (process.env.BACKEND_URL ?? '').replace(/\/$/, '');

/**
 * Selection TTL.
 *
 * The relay caches the last musician_sync per account so a client that connects mid-service
 * immediately sees the current position. Without an expiry that cache is effectively
 * permanent: a viewer screen left running would still show last Sunday's verse days later.
 *
 * So the cached selection is treated as CURRENT only for this long after the last update.
 * When it lapses the cache is dropped and every client of the account is told, which is the
 * viewer's cue to clear the text and say nothing is being presented. Any new sync restarts
 * the clock, so an active service never expires.
 *
 * A non-numeric or negative value falls back to the default; 0 disables expiry entirely.
 */
const DEFAULT_SYNC_TTL_SECONDS = 3600;
const rawTtl = Number(process.env.SYNC_TTL_SECONDS);
const SYNC_TTL_SECONDS = Number.isFinite(rawTtl) && rawTtl >= 0 ? rawTtl : DEFAULT_SYNC_TTL_SECONDS;
const SYNC_TTL_MS = SYNC_TTL_SECONDS * 1000;

/**
 * What a connected client is, as reported by the client itself. Purely descriptive —
 * the relay never routes on it, it only mirrors it back to the account's peers so the
 * operator footer can break the connection count down by kind.
 */
interface ClientInfo {
  /** 'unknown' covers clients from before this handshake existed. */
  role: 'operator' | 'musician' | 'remote' | 'viewer' | 'monitor' | 'unknown';
  /** Musicians only: their current sync mode ('midi' | 'operator' | 'off'). */
  mode?: string;
  /** Optional display name (musician name), shown in the operator tooltip. */
  name?: string;
}

interface AuthedClient {
  ws: WebSocket;
  account: number;
  authTimer: ReturnType<typeof setTimeout> | null;
  info: ClientInfo;
  /** This socket's relay id, handed back in `auth_ok` so peers can address it in `to`. */
  id: string;
}

const KNOWN_ROLES = new Set(['operator', 'musician', 'remote', 'viewer', 'monitor']);

/**
 * Normalize a client-supplied descriptor. Everything here comes off the wire, so an
 * unknown role, an over-long name or a non-object are all reduced to something safe
 * rather than rejected — the descriptor is cosmetic and must never fail a connection.
 */
function parseClientInfo(raw: unknown): ClientInfo {
  if (!raw || typeof raw !== 'object') return { role: 'unknown' };
  const obj = raw as Record<string, unknown>;
  const role = typeof obj.role === 'string' && KNOWN_ROLES.has(obj.role) ? (obj.role as ClientInfo['role']) : 'unknown';
  const info: ClientInfo = { role };
  if (typeof obj.mode === 'string' && obj.mode) info.mode = obj.mode.slice(0, 32);
  if (typeof obj.name === 'string' && obj.name.trim()) info.name = obj.name.trim().slice(0, 64);
  return info;
}

const clients = new Set<AuthedClient>();

/**
 * Read a frame's optional `to` field: one client id, or several.
 *
 * Returns null when the field is absent or unusable, which means "everyone" — the
 * behaviour every message had before addressing existed. An *empty* list is not the same
 * thing and is honoured as written: a sender that addressed nobody meant nobody, and
 * silently promoting that to a broadcast is how a targeted meter feed ends up on every
 * screen in the building.
 */
function normaliseTo(raw: unknown): Set<string> | null {
  if (typeof raw === 'string') return new Set([raw]);
  if (Array.isArray(raw)) return new Set(raw.filter((id): id is string => typeof id === 'string'));
  return null;
}

/** Relay-assigned socket id, so every trace row can be grouped back to its connection. */
let socketSeq = 0;

/**
 * ── Live message tracing ───────────────────────────────────────────────────
 *
 * The relay is the only place that sees an account's whole conversation, so it is also
 * the only place a support case can be traced from. Every message in and out is filed
 * into a bounded per-account ring buffer and streamed live to connected monitors (the
 * admin panel's WebSocket tab).
 *
 * Deliberately in-memory only. Traces carry full payloads — lyrics, block text, musician
 * names — so nothing here is written to disk or handed to the backend: the data lives
 * exactly as long as the relay process does, and a restart drops all of it.
 */
interface TraceEntry {
  seq: number;
  /** Epoch ms. */
  ts: number;
  /** -1 for events from a socket that was never attributed to an account. */
  account: number;
  /** 'in' = client → relay, 'out' = relay → clients, 'sys' = connection lifecycle. */
  dir: 'in' | 'out' | 'sys';
  clientId: string;
  role: ClientInfo['role'];
  name?: string;
  /** The message's `action`/`type`, or the lifecycle event name. */
  event: string;
  /** How many peers a relayed message actually reached. */
  peers?: number;
  bytes: number;
  /** The verbatim JSON payload — never truncated, see the note above. */
  payload?: string;
}

const DEFAULT_TRACE_BUFFER_SIZE = 500;
const MIN_TRACE_BUFFER_SIZE = 50;
const MAX_TRACE_BUFFER_SIZE = 5000;

/** Clamp a client-supplied buffer size into the allowed range; null when not a number. */
function clampBufferSize(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_TRACE_BUFFER_SIZE, Math.max(MIN_TRACE_BUFFER_SIZE, Math.round(n)));
}

let traceBufferSize = clampBufferSize(process.env.TRACE_BUFFER_SIZE) ?? DEFAULT_TRACE_BUFFER_SIZE;

/** account → ring buffer, oldest first. */
const traceBuffers = new Map<number, TraceEntry[]>();
let traceSeq = 0;

/**
 * A connected admin monitor.
 *
 * Kept in its own set rather than in `clients`, so no relay path can treat it as a message
 * target: the only things that write to a monitor socket are recordTrace and the monitor
 * command handlers. That separation is also what stops the tracer feeding on its own output.
 */
interface Monitor {
  ws: WebSocket;
  /** Subscribed account, or null for every account (server admin). */
  account: number | null;
  /** null when the token is unrestricted; otherwise the only account this may ever watch. */
  boundAccount: number | null;
  id: string;
  info: ClientInfo;
}

const monitors = new Set<Monitor>();

function trimBuffer(buffer: TraceEntry[]): TraceEntry[] {
  if (buffer.length > traceBufferSize) buffer.splice(0, buffer.length - traceBufferSize);
  return buffer;
}

/** True when this monitor wants to see events of `account`. */
function monitorWants(monitor: Monitor, account: number): boolean {
  return monitor.account === null || monitor.account === account;
}

function sendJson(ws: WebSocket, message: Record<string, unknown>) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(message));
  } catch {
    /* ignore — the close handler cleans this socket up */
  }
}

/** File one event into its account's buffer and push it to every interested monitor. */
function recordTrace(entry: Omit<TraceEntry, 'seq' | 'ts'>) {
  const full: TraceEntry = { ...entry, seq: ++traceSeq, ts: Date.now() };
  const buffer = traceBuffers.get(full.account) ?? [];
  buffer.push(full);
  traceBuffers.set(full.account, trimBuffer(buffer));
  for (const monitor of monitors) {
    if (monitorWants(monitor, full.account)) sendJson(monitor.ws, { type: 'trace', entry: full });
  }
}

/** Who is connected right now, per account — the monitor's live client list. */
function peerSnapshot() {
  const rows = new Map<number, { account: number; clients: ClientInfo[]; monitors: number }>();
  const row = (account: number) => {
    const existing = rows.get(account) ?? { account, clients: [], monitors: 0 };
    rows.set(account, existing);
    return existing;
  };
  for (const client of clients) row(client.account).clients.push(client.info);
  for (const monitor of monitors) {
    if (monitor.account !== null) row(monitor.account).monitors++;
  }
  return [...rows.values()].sort((a, b) => a.account - b.account);
}

function broadcastMonitorPeers() {
  if (monitors.size === 0) return;
  const accounts = peerSnapshot();
  for (const monitor of monitors) {
    sendJson(monitor.ws, { type: 'monitor_peers', accounts, bufferSize: traceBufferSize });
  }
}

/** Send a freshly subscribed monitor everything already buffered for its scope. */
function sendMonitorBacklog(monitor: Monitor) {
  const entries: TraceEntry[] = [];
  for (const [account, buffer] of traceBuffers) {
    if (monitorWants(monitor, account)) entries.push(...buffer);
  }
  // Buffers are per account; the monitor wants one chronological stream across them.
  entries.sort((a, b) => a.seq - b.seq);
  sendJson(monitor.ws, {
    type: 'monitor_ok',
    account: monitor.account,
    boundAccount: monitor.boundAccount,
    bufferSize: traceBufferSize,
    limits: { min: MIN_TRACE_BUFFER_SIZE, max: MAX_TRACE_BUFFER_SIZE },
    version: VERSION,
    syncTtlSeconds: SYNC_TTL_SECONDS,
    accounts: peerSnapshot(),
    entries,
  });
}

/**
 * Scope a monitor token resolves to. `account: null` means the server admin, who may watch
 * any account and switch between them at will.
 */
interface MonitorScope {
  account: number | null;
}

/**
 * Resolve a monitor token against the PHP backend.
 *
 * Deliberately a *different* endpoint from ValidateToken: a viewer token authenticates a
 * display, and must never be upgradeable into a subscription to an account's full traffic.
 */
async function resolveMonitorToken(token: string): Promise<MonitorScope | null> {
  if (!BACKEND_URL) {
    console.warn('[WS Relay] BACKEND_URL not set — monitor auth unavailable');
    return null;
  }
  if (!token) return null;
  const url = `${BACKEND_URL}/rest/ValidateMonitorToken?token=${encodeURIComponent(token)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const body = await res.text();
    if (!res.ok) {
      console.warn(`[WS Relay] ValidateMonitorToken HTTP ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const json = JSON.parse(body) as Record<string, unknown>;
    if (json.scope === 'admin') return { account: null };
    if (json.scope === 'account' && typeof json.account === 'number') return { account: json.account };
    console.warn('[WS Relay] ValidateMonitorToken unexpected response:', JSON.stringify(json).slice(0, 200));
    return null;
  } catch (err) {
    console.error('[WS Relay] Monitor token validation failed:', (err as Error).message);
    return null;
  }
}

/**
 * Handle a command from an authenticated monitor. Monitors never participate in relaying,
 * so this is a closed command set rather than a fall-through to the relay path.
 */
function handleMonitorMessage(monitor: Monitor, msg: Record<string, unknown>) {
  switch (msg.action) {
    case 'monitor_subscribe': {
      const requested = typeof msg.account === 'number' ? msg.account : null;
      // An account-bound token stays on its own account whatever it asks for.
      if (monitor.boundAccount !== null && requested !== monitor.boundAccount) {
        sendJson(monitor.ws, { type: 'error', error: 'This monitor token is bound to a single account.' });
        return;
      }
      const previous = monitor.account;
      monitor.account = requested;
      sendMonitorBacklog(monitor);
      // Both the account it left and the one it joined change their visible watcher count.
      if (previous !== null && previous !== requested) broadcastPeerCount(previous);
      if (requested !== null) broadcastPeerCount(requested);
      broadcastMonitorPeers();
      return;
    }

    case 'monitor_config': {
      const size = clampBufferSize(msg.bufferSize);
      if (size === null) {
        sendJson(monitor.ws, { type: 'error', error: 'bufferSize must be a number.' });
        return;
      }
      traceBufferSize = size;
      // Shrinking has to take effect on what is already buffered, not just on new entries.
      for (const buffer of traceBuffers.values()) trimBuffer(buffer);
      console.log(`[WS Relay] trace buffer resized to ${traceBufferSize} entries/account`);
      for (const peer of monitors) sendJson(peer.ws, { type: 'monitor_config', bufferSize: traceBufferSize });
      return;
    }

    case 'monitor_clear': {
      if (monitor.account === null) traceBuffers.clear();
      else traceBuffers.delete(monitor.account);
      for (const peer of monitors) sendJson(peer.ws, { type: 'monitor_cleared', account: monitor.account });
      return;
    }

    default:
      sendJson(monitor.ws, { type: 'error', error: `Unknown monitor action: ${String(msg.action)}` });
  }
}

/**
 * Close code sent to peers the operator kicked. In the application range (4000-4999) so
 * clients can tell it apart from a network drop: this one must NOT auto-reconnect.
 */
const WS_CLOSE_OPERATOR_DISCONNECT = 4010;

/**
 * Resolve a viewer token to an account number by calling the PHP backend.
 * Returns the account number on success, or null if the token is invalid.
 */
async function resolveToken(token: string): Promise<number | null> {
  if (!BACKEND_URL) {
    console.warn('[WS Relay] BACKEND_URL not set — token auth unavailable');
    return null;
  }
  const url = `${BACKEND_URL}/rest/ValidateToken?token=${encodeURIComponent(token)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const body = await res.text();
    if (!res.ok) {
      console.warn(`[WS Relay] ValidateToken HTTP ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(body) as Record<string, unknown>;
    } catch {
      console.warn('[WS Relay] ValidateToken response is not JSON:', body.slice(0, 200));
      return null;
    }
    // Response::success() returns the array directly: { "account": 123 }
    const account = json?.account;
    if (typeof account !== 'number') {
      console.warn('[WS Relay] ValidateToken unexpected response shape:', JSON.stringify(json).slice(0, 200));
      return null;
    }
    console.log(`[WS Relay] Token resolved to account ${account}`);
    return account;
  } catch (err) {
    console.error('[WS Relay] Token validation request failed:', (err as Error).message, 'URL:', url);
    return null;
  }
}

/**
 * Last known musician_sync state per account.
 *
 * Replayed to new clients on auth so they immediately see the current position. The replay
 * is tagged `replay: true` because it is a CACHE, not a live broadcast: an operator that
 * reconnects would otherwise treat its own stale cached state as a musician telling it
 * where to go, and jump. Only clients that are meant to adopt a starting position act on it.
 *
 * Entries expire after SYNC_TTL_MS — see "Selection TTL" above.
 */
interface CachedSync {
  payload: string;
  /** When the operator last updated this selection. */
  at: number;
  /** Fires SYNC_TTL_MS after `at`; null when expiry is disabled. */
  timer: ReturnType<typeof setTimeout> | null;
}

const lastSyncPerAccount = new Map<number, CachedSync>();

/**
 * Re-serialize a cached sync payload with the replay marker and its age, so a client can
 * run its own expiry countdown from when the selection was made rather than from now.
 * Returns null if unusable.
 */
function taggedReplay(cached: CachedSync): string | null {
  try {
    const parsed = JSON.parse(cached.payload) as Record<string, unknown>;
    return JSON.stringify({ ...parsed, replay: true, ageMs: Date.now() - cached.at });
  } catch {
    return null;
  }
}

/** Send a message to every authenticated client of an account. */
function sendToAccount(account: number, message: Record<string, unknown>) {
  if (account === -1) return;
  const payload = JSON.stringify(message);
  recordTrace({
    account,
    dir: 'out',
    clientId: 'relay',
    role: 'unknown',
    event: String(message.type ?? 'message'),
    bytes: payload.length,
    payload,
  });
  for (const peer of clients) {
    if (peer.account !== account) continue;
    if (peer.ws.readyState !== WebSocket.OPEN) continue;
    try {
      peer.ws.send(payload);
    } catch {
      /* ignore — the close handler will clean this peer up */
    }
  }
}

/**
 * Drop an account's cached selection and tell its clients. Viewers clear their text;
 * every other client type ignores the message (they render from their own state).
 */
function expireSync(account: number) {
  const entry = lastSyncPerAccount.get(account);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  lastSyncPerAccount.delete(account);
  console.log(`[WS Relay] account=${account} selection expired after ${SYNC_TTL_SECONDS}s of no updates`);
  sendToAccount(account, { type: 'sync_expired', ttlSeconds: SYNC_TTL_SECONDS });
}

/**
 * Cache a fresh selection and restart its expiry countdown.
 *
 * `replacePayload` is false for a bare position report — see the relay branch below.
 * Such a message still proves the account is live, so it restarts the countdown, but it
 * must not become what the next client is replayed.
 */
function cacheSync(account: number, payload: string, replacePayload = true) {
  const previous = lastSyncPerAccount.get(account);
  if (previous?.timer) clearTimeout(previous.timer);
  if (!replacePayload && !previous) return; // nothing worth keeping yet
  const entry: CachedSync = {
    payload: replacePayload ? payload : previous!.payload,
    at: Date.now(),
    timer: null,
  };
  if (SYNC_TTL_MS > 0) {
    entry.timer = setTimeout(() => expireSync(account), SYNC_TTL_MS);
    // Never hold the process open just to expire a cache entry.
    entry.timer.unref?.();
  }
  lastSyncPerAccount.set(account, entry);
}

/**
 * Send the current peer count for an account to all its authenticated clients.
 * `peers` lists the OTHER clients of the recipient, so it is built per recipient.
 */
function broadcastPeerCount(account: number) {
  if (account === -1) return;
  const peers = [...clients].filter((c) => c.account === account);
  // Monitors are listed to the account's own clients on purpose: an operator should be
  // able to see that support is watching their traffic rather than being observed silently.
  const watching = [...monitors].filter((m) => monitorWants(m, account)).map((m) => m.info);
  const total = peers.length + watching.length;
  for (const peer of peers) {
    if (peer.ws.readyState === 1 /* OPEN */) {
      peer.ws.send(
        JSON.stringify({
          type: 'peer_count',
          count: total,
          others: Math.max(0, total - 1),
          peers: [...peers.filter((p) => p !== peer).map((p) => p.info), ...watching],
        }),
      );
    }
  }
  recordTrace({
    account,
    dir: 'out',
    clientId: 'relay',
    role: 'unknown',
    event: 'peer_count',
    peers: peers.length,
    bytes: 0,
    payload: JSON.stringify({ count: total, peers: [...peers.map((p) => p.info), ...watching] }),
  });
  broadcastMonitorPeers();
}

const wss = new WebSocketServer({ port: PORT });

// Periodic ping — broadcast peer counts every 30 s so the operator footer stays current
const pingInterval = setInterval(() => {
  const accounts = new Set([...clients].map((c) => c.account));
  for (const account of accounts) {
    broadcastPeerCount(account);
  }
}, 30_000);

wss.on('listening', () => {
  console.log(`[WS Relay] Presenter WebSocket relay v${VERSION} (node ${process.version})`);
  console.log(`[WS Relay] Listening on port ${PORT}`);
  console.log(
    SYNC_TTL_SECONDS > 0 ? `[WS Relay] Selection TTL: ${SYNC_TTL_SECONDS}s` : '[WS Relay] Selection TTL: disabled (SYNC_TTL_SECONDS=0)',
  );
  console.log(BACKEND_URL ? `[WS Relay] Backend: ${BACKEND_URL}` : '[WS Relay] Backend: not configured — viewer token auth unavailable');
  console.log(`[WS Relay] Trace buffer: ${traceBufferSize} entries/account (in memory only)`);
});

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const ip = req.socket.remoteAddress ?? 'unknown';
  const clientId = `c${++socketSeq}`;
  console.log(`[WS Relay] New connection from ${ip} (${clientId})`);

  /**
   * Set once this socket authenticates as a monitor. A monitor is never added to
   * `clients`, so this reference is the only handle the message and close paths have on it.
   */
  let monitor: Monitor | null = null;

  // Filed under -1: the socket has no account yet, so only an all-accounts monitor sees it.
  recordTrace({ account: -1, dir: 'sys', clientId, role: 'unknown', event: 'connect', bytes: 0, payload: JSON.stringify({ ip }) });

  const client: AuthedClient = {
    ws,
    account: -1, // not yet authenticated
    authTimer: null,
    info: { role: 'unknown' },
    id: clientId,
  };

  // Give the client 10 seconds to authenticate (token validation involves an HTTP call)
  client.authTimer = setTimeout(() => {
    if (client.account === -1) {
      console.warn(`[WS Relay] Closing unauthenticated connection from ${ip}`);
      ws.close(4001, 'Authentication timeout');
    }
  }, 10000);

  ws.on('message', (data) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
      return;
    }

    // A monitor has its own closed command set and never reaches the relay path below.
    if (monitor) {
      handleMonitorMessage(monitor, msg);
      return;
    }

    // ── Auth handshake ──────────────────────────────────────────────────────
    if (client.account === -1) {
      if (msg.action !== 'auth') {
        ws.send(JSON.stringify({ type: 'error', error: 'First message must be an auth message.' }));
        ws.close(4002, 'Authentication required');
        return;
      }

      client.info = parseClientInfo(msg.client);

      // ── Monitor auth (admin message tracing) ──────────────────────────────
      // Checked before the viewer-token branch below: a monitor also authenticates with a
      // token, and the two must not be confused — see resolveMonitorToken.
      if (msg.role === 'monitor') {
        const token = typeof msg.token === 'string' ? msg.token : '';
        const requested = typeof msg.account === 'number' ? msg.account : null;
        void resolveMonitorToken(token).then((scope) => {
          if (!scope) {
            sendJson(ws, { type: 'auth_error', error: 'Invalid or expired monitor token.' });
            ws.close(4004, 'Invalid monitor token');
            return;
          }
          if (scope.account !== null && requested !== null && requested !== scope.account) {
            sendJson(ws, { type: 'auth_error', error: 'Token is not valid for this account.' });
            ws.close(4004, 'Account not permitted');
            return;
          }
          if (client.authTimer) {
            clearTimeout(client.authTimer);
            client.authTimer = null;
          }
          monitor = {
            ws,
            account: scope.account !== null ? scope.account : requested,
            boundAccount: scope.account,
            id: clientId,
            info: { role: 'monitor', ...(client.info.name ? { name: client.info.name } : {}) },
          };
          monitors.add(monitor);
          console.log(`[WS Relay] Monitor attached (account=${monitor.account ?? 'all'}, ip=${ip})`);
          sendMonitorBacklog(monitor);
          // Make the watcher visible to the account it is watching.
          if (monitor.account !== null) broadcastPeerCount(monitor.account);
          else for (const account of new Set([...clients].map((c) => c.account))) broadcastPeerCount(account);
          broadcastMonitorPeers();
        });
        return;
      }

      const finishAuth = (account: number) => {
        if (client.authTimer) {
          clearTimeout(client.authTimer);
          client.authTimer = null;
        }
        client.account = account;
        clients.add(client);

        recordTrace({
          account,
          dir: 'sys',
          clientId,
          role: client.info.role,
          ...(client.info.name ? { name: client.info.name } : {}),
          event: 'auth',
          bytes: 0,
          payload: JSON.stringify({ ip, client: client.info, via: typeof msg.token === 'string' ? 'token' : 'account' }),
        });

        const accountPeers = [...clients].filter((c) => c.account === client.account);
        const watchers = [...monitors].filter((m) => monitorWants(m, client.account)).map((m) => m.info);
        ws.send(
          JSON.stringify({
            type: 'auth_ok',
            account: client.account,
            count: accountPeers.length + watchers.length,
            others: Math.max(0, accountPeers.length + watchers.length - 1),
            peers: [...accountPeers.filter((p) => p !== client).map((p) => p.info), ...watchers],
            // This socket's own id, so a client can ask a peer to answer it directly
            // rather than broadcasting the reply to the whole account. See the `to`
            // handling in the fan-out below.
            clientId,
            // Lets a client run the same expiry countdown locally, so it still clears its
            // display if this relay restarts (or never sends sync_expired) while it watches.
            syncTtlSeconds: SYNC_TTL_SECONDS,
          }),
        );
        broadcastPeerCount(client.account);

        const cached = lastSyncPerAccount.get(client.account);
        if (cached) {
          // Belt and braces next to the expiry timer: a suspended host (laptop lid, VM
          // snapshot) fires its timers late, so re-check the age before replaying.
          if (SYNC_TTL_MS > 0 && Date.now() - cached.at >= SYNC_TTL_MS) {
            expireSync(client.account);
          } else {
            const replay = taggedReplay(cached);
            if (replay) {
              try {
                ws.send(replay);
                recordTrace({
                  account: client.account,
                  dir: 'out',
                  clientId,
                  role: client.info.role,
                  event: 'musician_sync (replay)',
                  bytes: replay.length,
                  payload: replay,
                });
              } catch {
                /* ignore */
              }
            }
          }
        }
      };

      // ── Token auth ────────────────────────────────────────────────────────
      if (typeof msg.token === 'string') {
        resolveToken(msg.token as string).then((account) => {
          if (account === null) {
            ws.send(JSON.stringify({ type: 'auth_error', error: 'Invalid or inactive viewer token.' }));
            ws.close(4003, 'Invalid token');
          } else {
            finishAuth(account);
          }
        });
        return;
      }

      // ── Direct account number auth ────────────────────────────────────────
      if (typeof msg.account !== 'number') {
        ws.send(
          JSON.stringify({
            type: 'error',
            error: 'Provide account number or viewer token: { action: "auth", account: <number> } or { action: "auth", token: "<hex>" }',
          }),
        );
        ws.close(4002, 'Authentication required');
        return;
      }

      finishAuth(msg.account as number);
      return;
    }

    // ── Client describes itself again (e.g. musician switched sync mode) ─────
    // Cheaper and less disruptive than reconnecting just to change the descriptor.
    if (msg.action === 'client_info') {
      client.info = parseClientInfo(msg.client);
      recordTrace({
        account: client.account,
        dir: 'in',
        clientId,
        role: client.info.role,
        ...(client.info.name ? { name: client.info.name } : {}),
        event: 'client_info',
        bytes: data.toString().length,
        payload: data.toString(),
      });
      broadcastPeerCount(client.account);
      return;
    }

    // ── Operator: drop every other client of this account ────────────────────
    // Stale sockets accumulate (sleeping tablets, reloaded pages, dropped mobiles) and
    // there is no way to tell them apart from the server side. This lets the operator
    // clear the slate; peers see close code 4010, stop auto-reconnecting and offer a
    // manual reconnect instead, so nobody is silently cut off or instantly back.
    if (msg.action === 'disconnect_peers') {
      let closed = 0;
      for (const peer of [...clients]) {
        if (peer === client) continue;
        if (peer.account !== client.account) continue;
        peer.ws.close(WS_CLOSE_OPERATOR_DISCONNECT, 'Disconnected by operator');
        closed++;
      }
      console.log(`[WS Relay] account=${client.account} disconnected ${closed} peer(s) on operator request`);
      recordTrace({
        account: client.account,
        dir: 'in',
        clientId,
        role: client.info.role,
        ...(client.info.name ? { name: client.info.name } : {}),
        event: 'disconnect_peers',
        peers: closed,
        bytes: 0,
        payload: JSON.stringify({ closed }),
      });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'peers_disconnected', count: closed }));
      }
      return;
    }

    // ── Relay to same-account peers ─────────────────────────────────────────
    const payload = data.toString();
    let relayed = 0;

    // Cache musician_sync so new clients can be replayed on auth. This also restarts the
    // selection's TTL, so an account that keeps presenting never expires.
    //
    // Two kinds of message share the `musician_sync` action: the operator's full
    // presentation state (song, block name, lyrics, black flag — what a display needs),
    // and a MIDI musician's bare position report (item/block/line/songNumber), which is
    // addressed at the operator. Only the first is worth replaying: caching a position
    // report meant the next viewer to connect was handed a state with no song and no
    // lyrics, and showed an empty screen until the operator next happened to broadcast.
    // A position report still restarts the TTL — it proves the account is live.
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const data = parsed.data as Record<string, unknown> | undefined;
      if (parsed.action === 'musician_sync' && data) {
        cacheSync(client.account, payload, typeof data.contentType === 'string');
      }
    } catch {
      /* ignore */
    }

    // ── Addressed delivery ──────────────────────────────────────────────────
    // A frame may name its recipients in `to` (one client id, or several). Without it
    // everything still goes to every peer of the account, exactly as before — this is
    // additive, and a client that never sets `to` cannot tell the difference.
    //
    // It exists for the audio mixer, which forwards the desk's meters at 10 Hz. Fanning
    // that out to the whole account would push audio levels at the presentation windows
    // and the text viewers, which have no use for them and pay for every byte.
    //
    // Senders address their replies whether or not the relay in front of them understands
    // this, and clients drop frames not meant for them, so an older relay stays correct —
    // just chattier.
    const addressed = normaliseTo(msg.to);

    for (const peer of clients) {
      if (peer === client) continue;
      if (peer.account !== client.account) continue;
      if (peer.ws.readyState !== WebSocket.OPEN) continue;
      if (addressed && !addressed.has(peer.id)) continue;
      peer.ws.send(payload);
      relayed++;
    }

    // Recorded after the fan-out so the trace carries how many peers actually got it —
    // "the operator sent it but nobody was listening" is the most common support case.
    recordTrace({
      account: client.account,
      dir: 'in',
      clientId,
      role: client.info.role,
      ...(client.info.name ? { name: client.info.name } : {}),
      event: typeof msg.action === 'string' ? msg.action : typeof msg.type === 'string' ? msg.type : 'message',
      peers: relayed,
      bytes: payload.length,
      payload,
    });

    // Optional: acknowledge relay
    // ws.send(JSON.stringify({ type: 'relayed', count: relayed }));
  });

  ws.on('close', (code: number) => {
    if (client.authTimer) clearTimeout(client.authTimer);

    if (monitor) {
      const watched = monitor.account;
      monitors.delete(monitor);
      monitor = null;
      console.log(`[WS Relay] Monitor detached (account=${watched ?? 'all'}, remaining=${monitors.size})`);
      // The watched account's clients must stop showing a watcher that has gone.
      if (watched !== null) broadcastPeerCount(watched);
      else for (const account of new Set([...clients].map((c) => c.account))) broadcastPeerCount(account);
      broadcastMonitorPeers();
      return;
    }

    clients.delete(client);
    console.log(`[WS Relay] Disconnected: account=${client.account} role=${client.info.role} ip=${ip} (total=${clients.size})`);
    recordTrace({
      account: client.account,
      dir: 'sys',
      clientId,
      role: client.info.role,
      ...(client.info.name ? { name: client.info.name } : {}),
      event: 'close',
      bytes: 0,
      payload: JSON.stringify({ ip, code }),
    });
    // Notify remaining peers in the same account of the new count
    broadcastPeerCount(client.account);
  });

  ws.on('error', (err) => {
    console.error(`[WS Relay] Socket error (account=${client.account} ip=${ip}):`, err.message);
    if (client.authTimer) clearTimeout(client.authTimer);
    recordTrace({
      account: client.account,
      dir: 'sys',
      clientId,
      role: client.info.role,
      event: 'error',
      bytes: 0,
      payload: JSON.stringify({ ip, error: err.message }),
    });
    if (monitor) {
      monitors.delete(monitor);
      monitor = null;
      broadcastMonitorPeers();
      return;
    }
    clients.delete(client);
  });
});

wss.on('error', (err) => {
  console.error('[WS Relay] Server error:', err);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[WS Relay] SIGTERM received — shutting down');
  clearInterval(pingInterval);
  wss.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('[WS Relay] SIGINT received — shutting down');
  clearInterval(pingInterval);
  wss.close(() => process.exit(0));
});
