/**
 * Build the web app for a dev subdomain.
 *
 *   npm run build:web:dev
 *   npm run build:web:dev -- --skip-build     # only refresh the dev-environment extras
 *
 * Output goes to `dist-dev/` — the same payload `build:web` puts in `dist/`, minus the
 * desktop installers, plus the contents of `dev-environment/` (see its README) and a
 * `robots.txt`, because a dev subdomain has no business being indexed.
 *
 * Nothing is configured at build time. The dev deployment is described entirely by the
 * `config.php` and `copy.config.php` that live on it, so this build carries no credentials
 * and no environment-specific URLs — and the copy endpoint stays inert until someone puts
 * a `copy.config.php` next to `config.php`.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outDirName = 'dist-dev';
const outDir = join(repoRoot, outDirName);

/**
 * What `dev-environment/` contributes, and where it lands. These files sit outside `api/`
 * so that no production build can reach them; this is the only thing that deploys them.
 */
const DEV_ENVIRONMENT = {
  'DbCopy.php': 'api/DbCopy.php',
  'copy.config-sample.php': 'copy.config-sample.php',
  'README.md': 'README.md',
};

const argv = process.argv.slice(2);
const skipBuild = argv.includes('--skip-build');

const step = (label) => console.log(`\n\x1b[1m━━ ${label} ━━\x1b[0m`);
const die = (message) => {
  console.error(`\n\x1b[31m${message}\x1b[0m`);
  process.exit(1);
};

// ── Vite build ──────────────────────────────────────────────────────────────

/** Run a command line through the shell — npm is a .cmd on Windows. */
function run(label, commandLine, env = {}) {
  step(label);
  const result = spawnSync(commandLine, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: true,
  });
  if (result.error) die(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) die(`${label} failed — dist-dev was not completed.`);
}

if (skipBuild) {
  if (!existsSync(outDir)) die('--skip-build was given but dist-dev does not exist yet.');
  console.log('Skipping the Vite build — refreshing the dev-environment extras.');
} else {
  // `build:web` runs typesafe-i18n itself; only the output location differs.
  run(`vite build → ${outDirName}/`, 'npm run build:web', {
    PRESENTER_WEB_OUT_DIR: outDirName,
    PRESENTER_SKIP_INSTALLERS: '1',
  });
}

mkdirSync(join(outDir, 'api'), { recursive: true });

// ── dev-environment/ ────────────────────────────────────────────────────────

step('dev-environment');

const written = [];

const copy = (from, to) => {
  copyFileSync(join(repoRoot, from), join(outDir, to));
  written.push(to);
};

for (const [file, destination] of Object.entries(DEV_ENVIRONMENT)) {
  copy(join('dev-environment', file), destination);
}

writeFileSync(join(outDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
written.push('robots.txt');

// .htaccess — the copied production rules plus the dev-only ones. Appended rather than
// templated so the production file stays the single source of truth for the rewrites.
const htaccessPath = join(outDir, '.htaccess');

if (existsSync(htaccessPath)) {
  const htaccess = readFileSync(htaccessPath, 'utf8');
  const marker = '# ── dev subdomain ──';

  if (!htaccess.includes(marker)) {
    const deny = (file) => `<Files "${file}">\n  Require all denied\n</Files>\n\n`;

    writeFileSync(
      htaccessPath,
      `${htaccess.trimEnd()}\n\n${marker}\n` +
        '# Added by scripts/build-dev-web.mjs — not present in the production dist.\n\n' +
        deny('copy.config.php') +
        deny('copy.config-sample.php') +
        deny('README.md') +
        '<IfModule mod_headers.c>\n  Header set X-Robots-Tag "noindex, nofollow"\n</IfModule>\n',
    );
    written.push('.htaccess (dev rules appended)');
  }
} else {
  console.warn('  \x1b[33m!\x1b[0m no .htaccess in dist-dev — run without --skip-build');
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log();
for (const name of written) console.log(`  \x1b[32m✓\x1b[0m ${name}`);

console.log(
  [
    '',
    `\x1b[1m${outDirName}/ is ready to upload\x1b[0m`,
    '',
    '  Setup and the copy workflow are described in the README.md it contains',
    '  (the same one as dev-environment/README.md).',
    '',
  ].join('\n'),
);
