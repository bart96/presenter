/**
 * Graceful shutdown — Electron main process.
 *
 * Startup Manager stops us by posting WM_CLOSE to the window (`taskkill`
 * without /F) and waits ~15s before escalating to `taskkill /T /F`. Whatever
 * has not been persisted by then is lost, so the teardown has to be bounded:
 * every step gets its own timeout and the run as a whole gets a budget well
 * under that grace period.
 *
 * The same run is reused no matter how the stop arrives — window close,
 * console signal, or the loopback stop command in `startControlServer`.
 */
import { createServer, type Server } from 'http';
import { appendFileSync, writeFileSync } from 'fs';

/** Whole-run budget. Startup Manager's default grace period is 15s. */
const TOTAL_BUDGET_MS = 8000;
/** Per-step cap, so one unresponsive resource cannot spend the whole budget. */
const STEP_TIMEOUT_MS = 2000;
/** Loopback port for the stop command (outside the media server's 9100–9110 fallback range). */
export const CONTROL_PORT = 9120;

// A packaged Windows app has no console, and a teardown you cannot see in a log is one
// you cannot debug when it eventually hangs. Mirror the timeline to a file — synchronous
// writes, so nothing is left buffered when the process ends.
let logFile: string | null = null;

/** Point the shutdown log at a file, truncating it so it covers this run only. */
export const setShutdownLogFile = (path: string): void => {
  try {
    writeFileSync(path, `[${new Date().toISOString()}] [Shutdown] Log opened\n`, 'utf-8');
    logFile = path;
  } catch {
    /* not being able to log is not a reason to fail the run */
  }
};

const log = (message: string, level: 'log' | 'warn' | 'error' = 'log', err?: unknown): void => {
  if (err === undefined) console[level](message);
  else console[level](message, err);
  if (!logFile) return;
  try {
    const detail = err === undefined ? '' : ` ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
    appendFileSync(logFile, `[${new Date().toISOString()}] ${message}${detail}\n`, 'utf-8');
  } catch {
    /* ignore */
  }
};

export interface ShutdownStep {
  name: string;
  run: () => void | Promise<void>;
  /** Override the default per-step cap. */
  timeoutMs?: number;
}

const withTimeout = async (step: ShutdownStep): Promise<void> => {
  const limit = step.timeoutMs ?? STEP_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(step.run),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          log(`[Shutdown] Step "${step.name}" timed out after ${limit}ms — continuing`, 'warn');
          resolve();
        }, limit);
      }),
    ]);
  } catch (err) {
    log(`[Shutdown] Step "${step.name}" failed:`, 'error', err);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Flush anything still buffered on stdout/stderr. `app.exit()` (like
 * `process.exit()`) drops pending writes to pipes and files, which is reliably
 * the last few log lines — the ones saying why we went away.
 */
const flushStdio = (): Promise<void> => {
  const drain = (stream: NodeJS.WriteStream): Promise<void> =>
    new Promise((resolve) => {
      if (!stream.writableLength) {
        resolve();
        return;
      }
      const done = (): void => resolve();
      stream.once('drain', done);
      setTimeout(done, 250);
    });
  return Promise.all([drain(process.stdout), drain(process.stderr)]).then(() => undefined);
};

export class ShutdownCoordinator {
  private steps: ShutdownStep[] = [];
  private running: Promise<void> | null = null;

  /** True once a teardown is under way — later stop requests join it instead of starting a second one. */
  get inProgress(): boolean {
    return this.running !== null;
  }

  /** Steps run in registration order: stop accepting work, close connections, then persist. */
  register(step: ShutdownStep): void {
    this.steps.push(step);
  }

  /**
   * Run the teardown once. Concurrent callers join the run already in flight.
   * Never rejects: a failing step is logged and the run continues.
   */
  run(reason: string): Promise<void> {
    if (this.running) return this.running;

    log(`[Shutdown] Starting (${reason})`);
    const started = Date.now();

    const sequence = (async () => {
      for (const step of this.steps) {
        if (Date.now() - started >= TOTAL_BUDGET_MS) {
          log(`[Shutdown] Budget of ${TOTAL_BUDGET_MS}ms spent — skipping "${step.name}"`, 'warn');
          continue;
        }
        await withTimeout(step);
      }
    })();

    // Cap the run as a whole as well, so a step that ignores its own timeout
    // (synchronous work, an unsettled promise chain) cannot outlast the budget.
    const budget = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        log(`[Shutdown] Budget of ${TOTAL_BUDGET_MS}ms exhausted — exiting anyway`, 'warn');
        resolve();
      }, TOTAL_BUDGET_MS);
      void sequence.finally(() => clearTimeout(timer));
    });

    this.running = Promise.race([sequence, budget])
      .then(() => {
        log(`[Shutdown] Complete in ${Date.now() - started}ms`);
      })
      .then(flushStdio);

    return this.running;
  }
}

/**
 * Loopback HTTP stop command:
 *
 *   POST http://127.0.0.1:9120/shutdown
 *
 * This is the only way to stop us in the seconds before a window exists, so it
 * is what belongs in Startup Manager's stop command field:
 *
 *   curl -X POST http://127.0.0.1:9120/shutdown
 *
 * Resolves to a stopper for the server itself (part of the teardown), or null
 * when the port could not be bound — an app that is already running owns it,
 * and losing the stop command is not a reason to refuse to start.
 */
export const startControlServer = (port: number, onStop: (reason: string) => void): Promise<(() => Promise<void>) | null> => {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      // Loopback only. Nobody on the LAN gets to switch the presentation off.
      const remote = req.socket.remoteAddress ?? '';
      if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
        res.writeHead(403).end();
        return;
      }

      if (req.method === 'POST' && req.url === '/shutdown') {
        // Answer before tearing down: teardown first and the caller reads a
        // dropped connection and reports a failed stop for a stop that worked.
        // Connection: close — we are about to go away, so the caller must not be
        // left holding a keep-alive socket that resets under it a moment later.
        res.writeHead(200, { 'Content-Type': 'text/plain', Connection: 'close' });
        res.end('shutting down\n');
        res.on('finish', () => {
          log('[Control] Stop command received');
          onStop('stop command');
        });
        return;
      }

      res.writeHead(404).end();
    });

    server.once('error', (err: NodeJS.ErrnoException) => {
      log(`[Control] Stop command unavailable on port ${port}: ${err.message}`, 'warn');
      resolve(null);
    });

    server.listen(port, '127.0.0.1', () => {
      log(`[Control] Stop command listening on http://127.0.0.1:${port}/shutdown`);
      resolve(
        () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      );
    });
  });
};
