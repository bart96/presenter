/**
 * Bounded shutdown — the teardown Startup Manager depends on.
 *
 *   node test/shutdown/run.mjs
 *
 * Startup Manager asks us to stop with WM_CLOSE and force-kills the process about 15
 * seconds later. Everything that makes that survivable lives in `src/main/shutdown.ts`:
 * one run no matter how many stop requests arrive, a cap on each step so a device that
 * stopped answering cannot spend the whole grace period, a cap on the run as a whole, and
 * a stop command that answers *before* it tears down (answer last and the caller reads a
 * dropped connection and reports a failed stop for a stop that worked).
 *
 * The failure mode is invisible in normal use — the app still closes when you click the X.
 * It only shows up as a hard kill on a machine nobody is watching, with the last log lines
 * missing. So the guarantees are pinned here instead.
 *
 * The module imports nothing but `http`, so it bundles straight to plain node.
 * Runtime is ~11s: two of the checks deliberately wait out the real timeouts.
 */
import { build } from 'esbuild';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { request } from 'http';

const dir = mkdtempSync(join(tmpdir(), 'shutdown-'));

await build({
  entryPoints: ['src/main/shutdown.ts'],
  bundle: true,
  format: 'esm',
  outdir: dir,
  platform: 'node',
  external: ['http'],
});

const S = await import(pathToFileURL(join(dir, 'shutdown.js')).href);

let failed = 0;
const eq = (name, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    failed++;
    console.log(`FAIL ${name}\n  got  ${a}\n  want ${b}`);
  } else {
    console.log(`ok   ${name}`);
  }
};
const ok = (name, cond) => eq(name, cond === true, true);

const never = () => new Promise(() => {});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The run ───────────────────────────────────────────────────────────────────

{
  const order = [];
  const c = new S.ShutdownCoordinator();
  c.register({ name: 'a', run: () => order.push('a') });
  c.register({
    name: 'b',
    run: async () => {
      await wait(5);
      order.push('b');
    },
  });
  c.register({ name: 'c', run: () => order.push('c') });

  ok('idle before the first stop request', c.inProgress === false);
  const run = c.run('test');
  ok('in progress once asked', c.inProgress === true);
  await run;
  eq('steps run in registration order', order, ['a', 'b', 'c']);
}

{
  // A step that throws is the one most likely to be reached during a real teardown —
  // half-closed sockets, a file that moved. It must not cost the steps behind it.
  const reached = [];
  const c = new S.ShutdownCoordinator();
  c.register({
    name: 'throws',
    run: () => {
      throw new Error('boom');
    },
  });
  c.register({ name: 'rejects', run: () => Promise.reject(new Error('boom')) });
  c.register({ name: 'persist', run: () => reached.push('persist') });
  await c.run('test');
  eq('a failing step does not abort the run', reached, ['persist']);
}

{
  // The window that matters: one unresponsive resource must not eat the grace period.
  const reached = [];
  const c = new S.ShutdownCoordinator();
  c.register({ name: 'hangs', run: never });
  c.register({ name: 'persist', run: () => reached.push('persist') });
  const started = Date.now();
  await c.run('test');
  const elapsed = Date.now() - started;
  eq('a hung step is capped, later steps still run', reached, ['persist']);
  ok(`hung step released near its 2s cap (${elapsed}ms)`, elapsed >= 1900 && elapsed < 3500);
}

{
  // Every step hanging is the worst case. The whole run still has to end well inside
  // the 15s stop timeout, or Startup Manager kills us mid-write.
  const c = new S.ShutdownCoordinator();
  for (let i = 0; i < 10; i++) c.register({ name: `hangs-${i}`, run: never });
  const started = Date.now();
  await c.run('test');
  const elapsed = Date.now() - started;
  ok(`all-hung run ends on the 8s budget (${elapsed}ms)`, elapsed >= 7900 && elapsed < 10000);
  ok('and stays inside the 15s stop timeout', elapsed < 15000);
}

{
  // WM_CLOSE, a signal and the stop command can all arrive. Later ones join the run
  // already in flight rather than tearing down a second time.
  let runs = 0;
  const c = new S.ShutdownCoordinator();
  c.register({
    name: 'once',
    run: async () => {
      runs++;
      await wait(20);
    },
  });
  const [a, b] = [c.run('first'), c.run('second')];
  await Promise.all([a, b]);
  eq('concurrent stop requests share one run', runs, 1);
  await c.run('third');
  eq('a later stop request does not re-run the teardown', runs, 1);
}

// ── The stop command ──────────────────────────────────────────────────────────

const PORT = 9121; // not CONTROL_PORT: a running Presenter owns that one

const post = (path, method = 'POST') =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, path, method }, (res) => {
      let body = '';
      res.on('data', (d) => {
        body += d;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });

{
  const events = [];
  // The callback tears the server down the moment it is called — the same thing the real
  // one does a few steps in. The response has to survive that, or a stop that worked is
  // reported as a failed stop because the caller read a dropped connection.
  let stopServer;
  stopServer = await S.startControlServer(PORT, (reason) => {
    events.push(reason);
    void stopServer();
  });
  ok('stop command server bound', typeof stopServer === 'function');

  const res = await post('/shutdown');
  eq('POST /shutdown is answered', [res.status, res.body.trim()], [200, 'shutting down']);
  eq('the teardown ran', events, ['stop command']);

  stopServer = await S.startControlServer(PORT, () => {});

  eq('GET /shutdown is not a stop', (await post('/shutdown', 'GET')).status, 404);
  eq('another path is not a stop', (await post('/quit')).status, 404);

  const second = await S.startControlServer(PORT, () => {});
  eq('a taken port yields no stopper instead of failing to start', second, null);

  await stopServer();
  let refused = false;
  await post('/shutdown').catch(() => {
    refused = true;
  });
  ok('stopping the server releases the port', refused);
}

// ── The log ───────────────────────────────────────────────────────────────────

{
  // A packaged app has no console. If the teardown is not in a file, a hang in the field
  // is undebuggable — which is the case this whole module exists for.
  const logPath = join(dir, 'shutdown.log');
  S.setShutdownLogFile(logPath);
  const c = new S.ShutdownCoordinator();
  c.register({ name: 'hangs', run: never });
  c.register({ name: 'persist', run: () => {} });
  await c.run('log check');
  const written = readFileSync(logPath, 'utf-8');
  ok('the log records the stop and its reason', written.includes('[Shutdown] Starting (log check)'));
  ok('the log records a step that had to be cut off', written.includes(String.raw`Step "hangs" timed out`));
  ok('the log records the run finishing', written.includes('[Shutdown] Complete in'));
}

console.log(failed === 0 ? '\nAll checks passed' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
