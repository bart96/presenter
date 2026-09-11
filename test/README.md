# test/

Tooling for running and inspecting the app without a real backend.

- `mock-backend/` — fixture HTTP server standing in for the PHP API (below).
- `ws-sync/` — integration test for the WebSocket relay and the sync protocol, run with
  `npm run test:ws`. See [ws-sync/README.md](ws-sync/README.md).
- `lyrics/` — parse/serialise round-trip test for the song editor's lyric-line model, run with
  `npm run test:lyrics`. Pure node, no server needed.
- `styles/` — unit tests for the style editor's pure helpers (CSS box shorthand, the custom-CSS
  tokeniser), run with `npm run test:styles`. Pure node, no server needed.
- `shutdown/` — checks that the app stops itself within its budget when asked (window close,
  signal, or the loopback stop command), run with `npm run test:shutdown`. Pure node; takes ~11s
  because two checks wait out the real timeouts.
- `viewport/` — small-screen layout test: drives the app in a headless browser at phone size
  and fails on anything that does not fit, run with `npm run test:screens`. See
  [viewport/README.md](viewport/README.md).

## Mock backend

`mock-backend/` is a small Node HTTP server that answers `/rest/*` with fixture JSON in the same
shapes as the PHP API. It exists so the frontend can be opened, clicked through and screenshotted
on a machine with no PHP/MySQL — for layout work, responsive checks, and reproducing UI bugs.

```bash
npm run dev:web:mock
```

That starts the mock backend on `:8000` and the Vite dev server on `:5173` together (the dev
proxy in `vite.shared.ts` already forwards `/rest` and `/oidc` to `:8000`, so nothing else is
configured). Open http://localhost:5173 and you are logged in as account 1.

Run the pieces separately if you prefer:

```bash
npm run dev:mock
```

### Options

| Env var           | Effect                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------- |
| `MOCK_PORT`       | Port to listen on (default `8000`, which is what the Vite proxy expects)               |
| `MOCK_ADMIN`      | `1` returns an `oidc_admin` session, unlocking `/admin`                                |
| `MOCK_VIEWER_URL` | Sets `settings.viewerUrl` (i.e. `VIEWER_URL` in config.php), for the Viewer Token link |

```bash
MOCK_ADMIN=1 npm run dev:mock
```

### What it does and does not do

- **Reads** return data from `mock-backend/fixtures.mjs`.
- **Writes** (POST/PUT/DELETE) are acknowledged and kept in memory for the life of the process,
  so a rename or delete sticks until you restart. Nothing is persisted or validated.
- **Unmapped endpoints** answer `{}` rather than 404, so a screen that polls something the mock
  does not know about still renders. Watch the request log — unmapped paths are flagged there.

It is a fixture server, not a simulator. Do not use it to verify backend behaviour; use it to
verify what the UI does with a given payload.

### Fixtures

`mock-backend/fixtures.mjs` holds the data. It is deliberately awkward — long German titles with
umlauts, 7-digit CCLI numbers, multi-author credits, a set list entry carrying both a custom key
and a long block-order name, and a duplicate song pair for the admin merge screen. Layout bugs
surface on strings like these and hide behind `Song 1`.

Song blocks contain placeholders (`[verse line 1]`), never real lyrics.

Add a case by editing that file; add an endpoint by extending `handlers` in `server.mjs`.

## Checking a viewport

The mobile layouts assume MUI's `sm` breakpoint (< 600px) via `useIsMobile()`. When checking a
change, look at 375×812 (phone) and something ≥ 900px (desktop) — several components swap their
structure rather than just reflowing, so a change that looks right on one can regress the other.

`npm run test:screens` automates the phone half of that: it walks the login and operator
screens at 375×667 and reports anything past the edge of the screen or cut off by a container,
with an annotated screenshot per failure.
