# Dev environment

Everything in this folder exists for a **dev deployment only** — a second copy of Presenter
on its own subdomain, with its own database, fed with a copy of the production data.

Nothing here is part of a production build. `npm run build:web` cannot pick these files up:
they sit outside `api/`, so the `api/*` copy never sees them. Only `npm run build:web:dev`
copies them, into `dist-dev/`.

| File                     | Where it lands in `dist-dev/` | What it is                                    |
| ------------------------ | ----------------------------- | --------------------------------------------- |
| `DbCopy.php`             | `api/DbCopy.php`              | Admin endpoint: copy another database in here |
| `copy.config-sample.php` | `copy.config-sample.php`      | Its configuration, filled in on the server    |
| `README.md`              | `README.md`                   | This file                                     |

---

## Setting up the dev subdomain

```bash
npm run build:web:dev
```

Upload `dist-dev/` to the subdomain, then, **once**:

1. `config-sample.php` → `config.php`, and fill in the dev database and OIDC. The dev
   database is configured here and nowhere else.
2. Import `install.sql` if that database is empty.
3. Make `data/` writable by PHP.

At this point you have a working, empty dev deployment. Copying is still switched off.

## Switching the copy on

Rename `copy.config-sample.php` to `copy.config.php` and fill in the source — the
production URL and **read-only** credentials for the production database. Then reload
Admin → Database: a **Copy from another database** card appears above the migrations.

Two separate things have to be true for the endpoint to answer, which is the point:

- `api/DbCopy.php` exists — only ever true for a `dist-dev` build
- `copy.config.php` exists — only ever true because you put it there

Without both, `/rest/DbCopy` is simply not there, and the admin panel shows nothing.

Note what is **not** in `copy.config.php`: the target. The copy always writes into the
database from this deployment's own `config.php`, so no edit to this file can turn it into
a write against production.

## What a copy does

- Drops and recreates every source table here, then copies the rows in batches. Tables that
  exist only here are left alone; `exclude_tables` and `structure_only_tables` narrow it.
- Rewrites `source_url` → `target_url` in every text and JSON column afterwards, so media
  links and style backgrounds point at the dev host. `skip_columns` protects the columns
  that hold other systems' addresses.
- Copies `data/` (uploaded PDFs and icons) if `data_dir.source` is set and readable from
  this server — normally only when both deployments share a hosting account.
- Refuses outright if source and target turn out to be the same database.

It brings the source's `schema_version` along with it, so anything the dev build has added
since is pending afterwards — run it from the migrations list on the same page.

**Preview** does all of the above as a dry run: it reports the plan and the rewrites and
writes nothing.

## Large databases

A copy that outruns the web server's timeout is better done over SSH. The same file is a
CLI script:

```bash
php api/DbCopy.php --dry-run
php api/DbCopy.php --yes
```

`--tables=songs,blocks` restricts it, `--no-data` copies structure only.

## Working on it locally

`api/` is where the router looks, so to exercise the endpoint against the repo's own PHP
dev server, copy it there:

```bash
cp dev-environment/DbCopy.php api/
```

`api/DbCopy.php` is gitignored precisely so this copy cannot be committed back — edit the
file in `dev-environment/`, and re-copy.
