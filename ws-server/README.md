# Presenter WebSocket Relay Server

A small, standalone WebSocket relay server that routes real-time messages
between Presenter clients (operator + musician views) that belong to the
**same account**.

## Why a separate server?

The built-in WebSocket server in the Presenter Electron app runs over plain
`ws://` and cannot be wrapped with a valid TLS certificate. Modern browsers
block mixed-content connections (insecure `ws://` from an `https://` page).
Running this relay on a publicly reachable server behind a reverse proxy
solves the problem: clients connect via `wss://` with a real certificate.

---

## Authentication

Every client **must** send an auth message as the **very first** message after
the WebSocket connection is opened:

```json
{ "action": "auth", "account": 12345 }
```

- `account` is the integer account/license number the user is logged in with.
- The server confirms authentication with `{ "type": "auth_ok", "account": 12345 }`.
- Clients that do not authenticate within 5 seconds are disconnected.
- All subsequent messages from a client are relayed verbatim to every other
  client with the **same account number**.

---

## Setup

### Getting the server

The easiest route is the **GitHub release**: every Presenter release carries
`ws-server-<version>.zip` and `redeploy.sh` as assets, built from that same commit.
(They are published by `npm run publish` / `npm run publish:artifacts` in the app repo —
the relay can be re-released on its own, without rebuilding the desktop app.)
Download both, skip to _2b. Updating an existing deployment_ (or _2. Run with Docker
Compose_ for a fresh host), and ignore the build step below.

### 1. Build it yourself

Only needed when running from a checkout rather than a release. `ws-server` is a yarn
workspace of the repo root, so its dependencies come from the root install — there is no
separate `node_modules` here:

```bash
yarn install       # in the repo ROOT, once
cd ws-server
yarn deploy        # type-checks, bundles, and writes ws-server-deploy.zip
```

The relay is **bundled into a single file** with esbuild — its one runtime dependency
(`ws`) is inlined. There is no `node_modules` to ship, nothing to install on the target,
and no dependency resolution inside Docker. That last part is what used to fail on Synology
NAS boxes and other hosts with restricted Docker bridge networking.

The zip contains exactly:

```
dist/server.js   the bundled relay (~150 KB)
package.json     name and version only — the relay prints the version at startup
Dockerfile       copies the two files above; no build step
redeploy.sh      the upgrade script, so an upgrade carries its own deploy logic
```

### 2. Run with Docker Compose

```bash
sudo docker-compose up -d
```

By default the server listens on port **9001** inside the container.

> **Synology note:** if you still encounter `EAI_AGAIN` DNS errors, the
> `docker-compose.yml` already adds `dns: [1.1.1.1, 8.8.8.8]` as a fallback.
> Make sure the Synology firewall allows outbound UDP/TCP on port 53 from the
> Docker bridge network, or use the pre-built approach above.

For rebuilding the image after changes run:

```bash
sudo docker-compose down
sudo docker-compose build --no-cache
```

The relay prints its version on the first log line, so `docker-compose logs` tells you
which build is actually running:

```
[WS Relay] Presenter WebSocket relay v1.1.0 (node v22.19.0)
```

### 2b. Updating an existing deployment

Take `ws-server-<version>.zip` from the GitHub release, or run `npm run deploy` from
`ws-server/` to build `ws-server-deploy.zip` yourself. Upload it into the folder that holds
the running deployment — the one with `docker-compose.yml` — and run:

```bash
sudo ./redeploy.sh
```

`redeploy.sh` ships **inside** the zip as well, so it only has to be uploaded separately
the first time — after that every upgrade brings the current version of the script with it.
It re-execs itself from a temporary copy before unpacking, which is what makes replacing
itself mid-run safe.

It stops the stack, removes `dist/`, `node_modules/`, `Dockerfile` and `package.json`,
unpacks the zip in their place, then rebuilds with `--no-cache` and starts again,
finishing by printing the startup log so you can confirm the version. (`node_modules/` is
still cleared even though the zip no longer ships one — an older deployment has one, and it
must not be left behind.)

The script finds the zip either way: it prefers `ws-server-deploy.zip` (a local build) and
otherwise takes the single `ws-server-*.zip` in the folder (a release download). With
several to choose from it stops rather than guessing.

`docker-compose.yml` is never touched, and the zip does not contain one by default —
it holds this host's `BACKEND_URL`, published port and `SYNC_TTL_SECONDS`, which must
survive a redeploy. Build with `node scripts/deploy.js --with-compose` only when
bootstrapping a host that has no compose file yet.

The script verifies the zip, the compose file and `unzip` are all present _before_ it
deletes anything, so a bad upload cannot leave you with a half-emptied folder. Pass
`-y` to skip the confirmation prompt.

### 3. Configure a reverse proxy (TLS termination)

Clients need `wss://`. The WS relay can share the **same hostname** as your PHP
app — just route it on a sub-path (e.g. `/ws`). This is the most common setup and
requires no extra domain or certificate.

#### nginx — same host, sub-path (recommended)

Add a `location /ws` block to your existing server block. The critical part is
the `Upgrade` / `Connection` headers that turn the HTTP request into a WebSocket
tunnel:

```nginx
# Inside your existing server { listen 443 ssl; server_name presenter.example.com; ... }

location /ws {
    proxy_pass         http://127.0.0.1:9001;   # ws-relay container port
    proxy_http_version 1.1;
    proxy_set_header   Upgrade    $http_upgrade;
    proxy_set_header   Connection "upgrade";
    proxy_set_header   Host       $host;
    proxy_read_timeout 3600s;   # keep long-lived WS connections alive
}
```

Then configure `config.php`:

```php
const WS_HOST = [
    'host' => 'presenter.example.com',  // same as your app
    'port' => 443,
    'path' => '/ws',                    // matches the nginx location above
    'wss'  => true,
];
```

> **Synology DSM reverse proxy**: in DSM → Application Portal → Reverse Proxy,
> add a rule for the `/ws` path on the same hostname, pointing to
> `http://localhost:9001`. Make sure "WebSocket" is enabled (DSM has a checkbox
> for upgrade headers).

#### nginx — separate sub-domain

If you prefer a dedicated domain (`ws.example.com`), omit `path` from `WS_HOST`:

```nginx
server {
    listen 443 ssl;
    server_name ws.example.com;

    ssl_certificate     /etc/letsencrypt/live/ws.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ws.example.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:9001;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       $host;
        proxy_read_timeout 3600s;
    }
}
```

```php
const WS_HOST = [
    'wss'  => true,
    'host' => 'ws.example.com',
    'port' => 443,
];
```

#### Caddy — automatic HTTPS

```
presenter.example.com {
    # PHP app
    root * /var/www/presenter
    php_fastcgi unix//run/php/php-fpm.sock

    # WebSocket relay on /ws path
    reverse_proxy /ws localhost:9001
}
```

### 4. Configure Presenter

In `config.php` on your Presenter server, set:

```php
const WS_HOST = [
    'host' => 'ws.example.com',
    'port' => 443,
    'wss'  => true,
];
```

All accounts that use the same Presenter backend will connect to this relay.
Messages are automatically isolated per account — operator and musician clients
belonging to account `12345` will never receive messages from account `67890`.

---

## Environment variables

| Variable            | Default | Description                                                 |
| ------------------- | ------- | ----------------------------------------------------------- |
| `PORT`              | `9001`  | TCP port the server listens on                              |
| `BACKEND_URL`       | –       | Base URL of the PHP backend; required for viewer-token auth |
| `SYNC_TTL_SECONDS`  | `3600`  | How long the last selection stays current (`0` = forever)   |
| `TRACE_BUFFER_SIZE` | `500`   | Messages kept per account for the admin monitor (50–5000)   |

### Selection TTL

The relay caches the last `musician_sync` per account so a client connecting mid-service
sees the current position immediately. `SYNC_TTL_SECONDS` bounds how long that cache counts
as **current** — one hour by default.

- Every new selection restarts the clock, so an active service never expires.
- When the TTL lapses the relay drops the cached selection and sends
  `{ type: "sync_expired" }` to every client of that account. The live viewer clears its
  text and shows that nothing is being presented.
- Clients connecting after expiry get no replay, so they start empty rather than showing a
  selection from days ago.
- Note that this measures time since the last **change**. A single block left up longer
  than the TTL expires too, even with the operator still connected — raise the value (or
  set `0`) if you intentionally hold one text for hours.

`auth_ok` carries `syncTtlSeconds` so clients can run the same countdown locally and still
clear their display if the relay restarts while they are watching.

---

## Protocol reference

### Client → Server

| Message                                               | When          | Description                                        |
| ----------------------------------------------------- | ------------- | -------------------------------------------------- |
| `{ action: "auth", account: <number>, client?: {} }`  | First message | Authenticate with an account number                |
| `{ action: "client_info", client: {} }`               | After auth    | Update this client's descriptor (no reconnect)     |
| `{ action: "disconnect_peers" }`                      | After auth    | Close every other client of the account (op. only) |
| `{ action: "auth", role: "monitor", token, account }` | First message | Attach as an admin message monitor (see below)     |
| Any JSON                                              | After auth    | Relayed to all peers with the same account         |
| Any JSON with `to`                                    | After auth    | Relayed only to the named peers — see below        |

The optional `client` descriptor is `{ role, mode?, name? }` with `role` one of
`operator`, `musician`, `remote`, `viewer` (anything else becomes `unknown`),
`mode` a musician's sync mode (`midi`, `operator`, `off`) and `name` an optional
display name. It is never used for routing — the relay only mirrors it back to
the account's peers so the operator can see **what** is connected, not just how
many. Clients that omit it keep working and appear as `unknown`.

#### Addressed delivery (`to`)

A relayed message may name its recipients: `to` is a client id, or an array of them, and
only those peers receive it. Everything without a `to` still goes to every peer of the
account, exactly as before — this is additive, and a client that never sets it cannot tell
the difference.

Client ids come from `auth_ok` (`clientId`), which is the socket's own id.

It exists for the monitor mixer, which forwards a mixing desk's meters at 10 Hz. Fanning
that out to the whole account would push audio levels at presentation windows and text
viewers that have no use for them and pay for every byte.

An **older relay ignores `to` and broadcasts anyway**, so senders set it regardless and
receivers check it themselves. That keeps a mixed deployment correct — just chattier — but
it is why monitor mixing wants relay ≥ 1.3.0 in front of it.

### Server → Client

| Message                                                                            | Description                                         |
| ---------------------------------------------------------------------------------- | --------------------------------------------------- |
| `{ type: "auth_ok", account, count, others, peers: [], clientId, syncTtlSeconds }` | Authentication successful                           |
| `{ type: "peer_count", count, others, peers: [] }`                                 | Peer count + descriptors changed (also every 30 s)  |
| `{ type: "peers_disconnected", count }`                                            | Answer to `disconnect_peers`                        |
| `{ type: "sync_expired", ttlSeconds }`                                             | The cached selection went stale — clear the display |
| `{ type: "error", error: "..." }`                                                  | Protocol error                                      |

A replayed selection additionally carries `replay: true` and `ageMs` (how long ago it was
set), so a client can start its local expiry countdown from the right moment.

`clientId` is this socket's own id, for addressing a reply back to a peer with `to`.

`peers` lists the descriptors of the recipient's **other** clients, so
`peers.length === others`. Attached monitors are included in it, deliberately: an operator
should be able to see that support is watching rather than being observed silently.

---

## Message monitoring (admin)

The relay records every message it sees into a bounded, **in-memory** ring buffer per
account and streams it live to attached monitors. This is what backs the admin panel's
**WebSocket** tab.

Nothing is persisted. Traces carry full payloads — including lyrics and musician names —
so they are never written to disk or sent to the backend. A relay restart discards
everything, and so does closing the admin tab.

### Attaching

A monitor authenticates like any other client, but with `role: "monitor"` and a token
minted by the backend:

```json
{ "action": "auth", "role": "monitor", "token": "<payload.signature>", "account": 12345 }
```

- `account` is the account to watch; `null` watches every account.
- The token is resolved against `BACKEND_URL/rest/ValidateMonitorToken`, which answers
  `{ "scope": "admin" }` (may watch anything) or `{ "scope": "account", "account": n }`
  (bound to one account, and cannot re-scope itself).
- This is deliberately **not** the viewer-token endpoint. A viewer token authenticates a
  display and must never be upgradeable into a subscription to an account's full traffic.
- Monitor tokens are short-lived (see `classes/MonitorToken.php`), so mint a fresh one for
  every connection attempt rather than caching one.

A monitor is kept out of the relay's client registry entirely: it is never a relay target,
never receives another client's messages as a peer, and never triggers the cached-selection
replay.

### Monitor protocol

| Client → Server                            | Description                                            |
| ------------------------------------------ | ------------------------------------------------------ |
| `{ action: "monitor_subscribe", account }` | Switch watched account (`null` = all); replays backlog |
| `{ action: "monitor_config", bufferSize }` | Resize the ring buffer at runtime (50–5000)            |
| `{ action: "monitor_clear" }`              | Drop the buffer for the watched scope                  |

| Server → Client                                                                   | Description                             |
| --------------------------------------------------------------------------------- | --------------------------------------- |
| `{ type: "monitor_ok", account, bufferSize, limits, version, accounts, entries }` | Attached; `entries` is the backlog      |
| `{ type: "trace", entry }`                                                        | One live event                          |
| `{ type: "monitor_peers", accounts, bufferSize }`                                 | Live connection census, per account     |
| `{ type: "monitor_config", bufferSize }`                                          | Buffer size changed (by any monitor)    |
| `{ type: "monitor_cleared", account }`                                            | Buffer dropped                          |
| `{ type: "auth_error", error }`                                                   | Token rejected; socket closes with 4004 |

### Trace entry

```ts
{
  seq: number;       // relay-wide counter — the only reliable ordering across accounts
  ts: number;        // epoch ms
  account: number;   // -1 for a socket that never authenticated
  dir: 'in' | 'out' | 'sys';
  clientId: string;  // relay-assigned socket id, groups rows by connection
  role: 'operator' | 'musician' | 'remote' | 'viewer' | 'monitor' | 'unknown';
  name?: string;
  event: string;     // the message's action/type, or 'connect' | 'auth' | 'close' | 'error'
  peers?: number;    // how many peers a relayed message actually reached
  bytes: number;
  payload?: string;  // the verbatim JSON, untruncated
}
```

`peers` is the field most support cases turn on: it distinguishes "the operator never sent
it" from "the operator sent it and nobody was listening".

### Testing

```bash
npm run test:ws-monitor
```

Boots the real relay against a stand-in backend and asserts account separation, token
rejection, live tracing, runtime buffer resizing, and that a monitor is never relayed to.

Both WebSocket suites normally run `src/server.ts` through ts-node. To run them against the
**bundle that actually ships** instead — worth doing before a release, since esbuild inlining
`ws` is not something the source-level tests would catch:

```bash
npm run test:ws:bundle
```

(Or set `WS_RELAY_ENTRY=deploy/dist/server.js` for a single suite.)
