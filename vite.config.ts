/**
 * Standalone Vite config for browser-only (PHP deployment) builds.
 * Used by `build:deploy` script. Outputs to `dist/` for Apache/Nginx hosting.
 *
 * For Electron builds, `electron.vite.config.ts` is used instead.
 */
import { resolve } from 'path';
import { readdirSync, existsSync, readFileSync } from 'fs';
import { extname, basename } from 'path';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import react from '@vitejs/plugin-react';
import { rendererAliases, rendererInputs, sharedServerConfig } from './vite.shared';
import { errorFallbackPlugin } from './vite.plugin.error-fallback';
const root = resolve(__dirname, 'src/renderer');
/**
 * Output folder. Overridable so the dev-subdomain build (`build:web:dev`) can write to
 * `dist-dev` without clobbering the production `dist`.
 */
const dist = process.env.PRESENTER_WEB_OUT_DIR || 'dist';
const distApp = 'dist-app';
const outDir = resolve(__dirname, dist);
const INSTALLER_EXTS = new Set(['.exe', '.dmg', '.AppImage', '.deb', '.snap', '.rpm', '.pkg']);
/** The release being built — only its installers are published. See the copy targets below. */
const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string };
const src = (path: string) => `../../${path}`;
export default defineConfig({
  root,
  resolve: {
    alias: rendererAliases,
  },
  build: {
    outDir,
    emptyOutDir: true,
    target: ['es2020', 'chrome87', 'safari14', 'firefox78', 'edge88'],
    rollupOptions: {
      input: rendererInputs,
    },
  },
  server: sharedServerConfig,
  plugins: [
    react(),
    errorFallbackPlugin(),
    viteStaticCopy({
      targets: [
        { src: src('api/*'), dest: outDir },
        { src: src('classes/*'), dest: outDir },
        { src: src('src/renderer/src/assets/icon.ico'), dest: outDir, rename: { name: 'favicon.ico', stripBase: 2 } },
        { src: src('src/renderer/src/assets/icon.svg'), dest: outDir, rename: { name: 'favicon.svg', stripBase: 2 } },
        {
          // install.sql ships too — the deployment steps in the README tell the operator to
          // import it, and a fresh database has no other source for the schema.
          src: [src('.htaccess'), src('config-sample.php'), src('install.sql'), src('oidc.php'), src('rest.php')],
          dest: dist,
        },
        ...(() => {
          // The dev subdomain serves the app, not the desktop installers.
          if (process.env.PRESENTER_SKIP_INSTALLERS === '1') return [];
          const srcDir = resolve(__dirname, distApp);
          if (!existsSync(srcDir)) return [];

          // Only this release's installers. The version is stripped from the published
          // name (`presenter-2.0.5-setup.exe` → `presenter-setup.exe`) so the download
          // link is stable, which means every version left lying in dist-app/ would land
          // on the same name and the last one written would win — alphabetically, not by
          // recency. At 2.0.10 that ordering puts 2.0.9 last and would publish it.
          const installers = readdirSync(srcDir).filter((f) => INSTALLER_EXTS.has(extname(f)) && f.includes(`-${version}-`));

          if (installers.length === 0) {
            console.warn(`[build:web] no ${version} installer in ${distApp}/ — dist/app will be empty`);
          }

          return installers.map((file) => {
            const ext = extname(file);
            const stripped = basename(file, ext).replace(`-${version}-`, '-');
            return {
              src: src(`${distApp}/${file}`),
              dest: `${outDir}/app`,
              rename: { name: stripped + ext, stripBase: 1 },
            };
          });
        })(),
      ],
    }),
  ],
});
