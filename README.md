# Presenter

A worship-lyrics presentation tool. Display song lyrics on one or more screens during church services or worship events. Supports songs, bible verses, media items, and PDF sheet music for musicians.

**Demo:** https://presenter.efsh.de

---

## Quick Start

### Prerequisites

- **Node.js** 20+
- **Yarn** 4 (`corepack enable && corepack prepare yarn@4.13.0 --activate`)
- **PHP** 8.2+ (for backend dev server)
- **MySQL** 9+ / MariaDB 11+ (for database)

### Install Dependencies

```bash
yarn install
```

### Development

#### Browser-Only (Frontend + PHP Backend)

```bash
# Start both frontend dev server and PHP backend
yarn dev

# Or start them separately:
yarn dev:frontend    # Electron + Vite dev server (port 5173)
yarn dev:backend     # PHP built-in server (port 8000)
yarn dev:web         # Browser-only Vite dev server (no Electron)
```

#### Electron Desktop App

```bash
yarn dev:frontend    # Starts Electron app with HMR
```

### Build

#### For PHP Web Server Deployment

```bash
yarn build:web
```

This produces a self-contained `dist/` folder ready for Apache/Nginx + PHP:

- Frontend assets (HTML, JS, CSS)
- PHP backend (api/, classes/, rest.php, oidc.php)
- Database schema (install.sql)
- Configuration template (config-sample.php)

**Deployment steps:**

1. Copy `dist/` contents to your web server
2. Copy `config-sample.php` to `config.php` and configure database + OIDC
3. Import `install.sql` into your MySQL database
4. Ensure `data/` directory is writable by PHP

#### For a Dev Subdomain

```bash
yarn build:web:dev
```

Produces `dist-dev/` — the same payload as `dist/` minus the desktop installers, plus the
contents of [`dev-environment/`](dev-environment/README.md). Nothing is
configured at build time: the dev deployment is described entirely by the `config.php` on
it, exactly like production.

`dev-environment/` holds the pieces that must never reach production — today, an admin
endpoint that copies another deployment's database into this one. They sit outside `api/`,
so the production build cannot pick them up; `build:web:dev` is the only thing that deploys
them.

**Deployment steps:**

1. Upload `dist-dev/` to the dev subdomain
2. First time only: `config-sample.php` → `config.php`, fill in the dev database and OIDC,
   and import `install.sql` if the database is empty
3. To pull production data in: `copy.config-sample.php` → `copy.config.php`, filled in with
   the production URL and read-only production database credentials

Admin → Database then offers **Copy from another database**, which drops and recreates every
source table locally, rewrites the production URL to the dev URL across every text and JSON
column, and leaves any pending migrations to the list right below it. The card only appears
when both `api/DbCopy.php` and `copy.config.php` are present, so it can never show up on a
production install — and the copy always writes into this deployment's own database, with no
setting that could reverse the direction.

The full workflow, the configuration options and the CLI form (better for a large database,
which tends to outlast a web request) are documented in
[dev-environment/README.md](dev-environment/README.md).

#### For Electron Desktop App

```bash
yarn build:win       # Windows
yarn build:mac       # macOS
yarn build:linux     # Linux
```

#### Stopping it from a supervisor

Presenter is built to be started and stopped by a supervisor such as Startup Manager, which
stops an app by posting `WM_CLOSE` (`taskkill` without `/F`) and force-kills it if it is still
there ~15s later. Three things follow from that:

- **Closing the window quits the app.** It never hides, so a plain `taskkill /PID <pid>` is
  enough. Note that `taskkill /T` is _not_ — Chromium refuses a tree close, so a supervisor
  must target the process that owns the window.
- **A loopback stop command**, for stopping it before a window exists or from a script:

  ```bash
  curl -X POST http://127.0.0.1:9120/shutdown
  ```

  It answers before tearing down, and refuses anything that is not from localhost.

- **The teardown is bounded** to 8s overall and 2s per step (stop the servers, persist window
  bounds and session cookies), so the app always exits on its own inside the grace period.
  It writes what it did to `shutdown.log` in the user-data directory
  (`%APPDATA%/presenter` on Windows).

`npm run test:shutdown` checks those guarantees. See `src/main/shutdown.ts`.

### Type Checking

```bash
yarn typecheck       # Check both web and node configs
yarn typecheck:web   # Frontend only
yarn typecheck:node  # Electron/Node only
```

### Linting & Formatting

```bash
yarn lint            # ESLint
yarn format          # Prettier
```

---

## Project Structure

```
presenter/
├── api/                    # PHP REST controllers
├── classes/                # PHP utility classes
├── src/
│   ├── main/               # Electron main process
│   ├── preload/            # Electron preload scripts
│   ├── renderer/           # React SPA (Vite)
│   │   ├── src/
│   │   │   ├── api/        # RTK Query API
│   │   │   ├── components/ # React components
│   │   │   ├── hooks/      # Custom hooks
│   │   │   ├── i18n/       # Internationalization (EN/DE)
│   │   │   ├── pages/      # Route pages
│   │   │   ├── presentation/ # Presentation window renderer
│   │   │   ├── routes/     # Auth guards
│   │   │   ├── song/       # Song model & parser
│   │   │   ├── store/      # Redux slices
│   │   │   └── utils/      # Utilities
│   │   ├── index.html      # Main SPA entry
│   │   ├── presentation.html # Presentation window
│   │   └── musician.html   # Musician PDF view
│   └── shared/             # Shared types (main + renderer)
├── viewer/                 # Standalone text viewer (own deployment)
├── ws-server/              # WebSocket relay (own deployment)
├── dev-environment/        # Dev-only extras, never in a production build
├── test/                   # Test suites (node, no runner dependency)
├── scripts/                # Build & deploy scripts
├── config-sample.php       # PHP config template
├── rest.php                # REST API router
├── oidc.php                # OIDC callback handler
├── install.sql             # Database schema (migrations run from the admin panel)
├── electron.vite.config.ts # Electron + Vite config
├── vite.config.ts          # Browser-only Vite config
└── package.json
```

---

## Tech Stack

| Layer    | Technology                                                |
| -------- | --------------------------------------------------------- |
| Frontend | React 19, TypeScript 6, MUI 7, Redux Toolkit 2, RTK Query |
| Build    | Vite 8, electron-vite 5                                   |
| i18n     | typesafe-i18n (EN + DE)                                   |
| Backend  | PHP 8.5+, MySQL 9+                                        |
| Auth     | OIDC (OpenID Connect)                                     |
| Desktop  | Electron 38+                                              |
| PDF      | react-pdf, pdfjs-dist                                     |
| Charts   | Recharts 3                                                |

---

## Features

- **Song management** — Create, edit, import (CCLI SongSelect .txt), organize songs
- **Set-list management** — Drag-and-drop show builder with songs, media, and bible verses
- **Presentation windows** — Multiple simultaneous windows with Normal and Stream modes
- **Style system** — Three-level cascade (Global → Show → Item) with per-window overrides
- **Bible verse integration** — Configurable Bible API with translation selection
- **Musician PDF view** — Server-side PDF storage, band-specific variants, auto-sync
- **Media support** — Images, videos, and solid colors
- **Dark/Light mode** — OS-aware theme with manual toggle
- **Keyboard shortcuts** — Fully configurable keyboard mapping
- **Admin dashboard** — Account/provider management, metrics, logs
- **Internationalization** — English and German
- **OBS integration** — Transparent background for Browser Source
- **WebSocket** — Bitfocus Companion support, musician sync (Electron only)

---

## License

© Marcel Birkholz
