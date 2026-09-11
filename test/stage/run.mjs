/**
 * Stage-monitor resolver and window-configuration model.
 *
 *   node test/stage/run.mjs
 *
 * Two things are pinned down here, both of which fail silently if they break.
 *
 * **The stage payload must be time-invariant.** The whole design rests on the operator
 * sending a window absolute timestamps when a *cue* changes, never a value when the clock
 * ticks — a per-second payload would defeat the content pipeline's dedupe and re-serialise
 * every slide once a second for every open window. Nothing enforces that at the type level,
 * so it is asserted directly: resolving the same state at two instants a minute apart has to
 * produce byte-identical output.
 *
 * **Closing a window must not delete it.** Configs used to be filtered out of storage on
 * close, which is why a rig could not be set up once and opened per service. The migration
 * that introduced stable ids has to leave existing configs intact while dropping the runtime
 * handle, which names a window in a process that has already exited.
 */
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { resolve } from 'path';

const dir = mkdtempSync(join(tmpdir(), 'stage-'));

// The slice reaches for localStorage at module load and inside every reducer. Give it a real
// one rather than a no-op, so the persistence path is actually exercised.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = { addEventListener() {}, dispatchEvent() {} };

/** react-redux hooks the slice exports but this test never calls. */
const hooksShim = join(dir, 'hooks-shim.ts');
writeFileSync(hooksShim, 'export const useAppSelector = () => undefined;\nexport const useAppDispatch = () => () => undefined;\n');

const bundle = async (entry, out) => {
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    outfile: join(dir, out),
    platform: 'node',
    external: ['react', 'react-redux'],
    // The renderer's own alias, which vite provides and esbuild does not know about.
    alias: { '@': resolve('src/renderer/src') },
    plugins: [
      {
        name: 'hooks-stub',
        setup(b) {
          b.onResolve({ filter: /store\/hooks$|^\.\/hooks$/ }, () => ({ path: hooksShim }));
        },
      },
    ],
  });
  return import(pathToFileURL(join(dir, out)).href);
};

const S = await bundle('src/renderer/src/stage/types.ts', 'stage.js');
const W = await bundle('src/renderer/src/store/windowSlice.ts', 'window.js');

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
const ok = (name, cond) => eq(name, !!cond, true);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const T0 = 1_800_000_000_000; // a fixed epoch instant, so nothing here depends on "now"

const layer = (id, cues, over = {}) => ({
  id,
  name: `Layer ${id}`,
  enabled: true,
  sort_order: 0,
  data: { placement: { anchor: 'bottom center', widthPct: 60, marginPct: 6 }, style: { fontSizePct: 12, color: '#fff' }, cues },
  ...over,
});

const countdown = (over = {}) => ({
  id: 'cd',
  kind: 'countdown',
  source: 'duration',
  durationSec: 300,
  onZero: 'hold',
  format: { preset: 'auto' },
  ...over,
});

const clockCue = { id: 'cl', kind: 'clock', format: { preset: 'time24', seconds: true } };
const runtime = (over = {}) => ({ cueIndex: 0, startedAt: T0, hidden: false, ...over });

// ── The payload must not depend on the current time ───────────────────────────

const layers = [layer(1, [countdown()]), layer(2, [clockCue])];
const runtimes = { 1: runtime(), 2: runtime() };

const at = (now) => {
  const realNow = Date.now;
  Date.now = () => now;
  try {
    return S.resolveStagePayload(layers, runtimes, false, 'en');
  } finally {
    Date.now = realNow;
  }
};

// The single most important property in the feature: same state, different instants, one
// identical payload. If this ever fails, a running countdown has started producing traffic.
eq('payload is identical a minute later', at(T0 + 1_000), at(T0 + 61_000));
eq('and an hour later', at(T0 + 1_000), at(T0 + 3_600_000));

// What travels is an anchor, never a rendered value.
const cd = at(T0).layers.find((l) => l.id === 1).cue;
eq('a countdown travels as a timer', cd.kind, 'timer');
eq('anchored to the instant it hits zero', cd.anchor, T0 + 300_000);
eq('counting down', cd.direction, 'down');
ok('carries no rendered text', !('text' in cd));
const cl = at(T0).layers.find((l) => l.id === 2).cue;
eq('a clock travels as a pattern', cl.pattern, 'HH:mm:ss');
eq('with the locale to render it in', cl.locale, 'en');

// ── What a layer contributes ──────────────────────────────────────────────────

eq('two layers, two entries', at(T0).layers.length, 2);
eq(
  'a hidden layer contributes nothing',
  S.resolveStagePayload(layers, { 1: runtime({ hidden: true }), 2: runtime() }, false, 'en').layers.length,
  1,
);
eq(
  'a disabled layer contributes nothing',
  S.resolveStagePayload([layer(1, [countdown()], { enabled: false })], { 1: runtime() }, false, 'en').layers.length,
  0,
);
eq('the global switch blanks everything', S.resolveStagePayload(layers, runtimes, true, 'en').layers.length, 0);
// Parking past the last cue is the natural "sequence finished" state — it shows nothing.
eq(
  'a finished sequence shows nothing',
  S.resolveStagePayload([layer(1, [countdown()])], { 1: runtime({ cueIndex: 1 }) }, false, 'en').layers.length,
  0,
);
// A layer nothing has started yet has no runtime entry at all.
eq('an unstarted layer shows nothing', S.resolveStagePayload(layers, {}, false, 'en').layers.length, 0);
// A blank cue, and a message with nothing in it, are positions in a sequence rather than
// something to draw.
eq(
  'a blank cue shows nothing',
  S.resolveStagePayload([layer(1, [{ id: 'b', kind: 'blank' }])], { 1: runtime() }, false, 'en').layers.length,
  0,
);
eq(
  'an empty message shows nothing',
  S.resolveStagePayload([layer(1, [{ id: 'm', kind: 'message', text: '  ' }])], { 1: runtime() }, false, 'en').layers.length,
  0,
);
eq(
  'a real message does show',
  S.resolveStagePayload([layer(1, [{ id: 'm', kind: 'message', text: 'Welcome' }])], { 1: runtime() }, false, 'en').layers[0].cue.text,
  'Welcome',
);

// ── Pausing ───────────────────────────────────────────────────────────────────

const paused = S.resolveStagePayload([layer(1, [countdown()])], { 1: runtime({ pausedAt: T0 + 60_000 }) }, false, 'en').layers[0].cue;
eq('a pause travels as a frozen instant', paused.frozenAt, T0 + 60_000);
// The window renders `frozenAt` instead of its own clock, so the digits hold wherever the
// operator stopped them however long the pause lasts.
eq('and holds the value', S.renderStageCue(paused, T0 + 999_999).text, '4:00');

// ── Rendering ─────────────────────────────────────────────────────────────────

eq('a countdown at the start', S.renderStageCue(cd, T0).text, '5:00');
eq('part way through', S.renderStageCue(cd, T0 + 28_000).text, '4:32');
eq('at zero', S.renderStageCue(cd, T0 + 300_000).text, '0:00');
// `onZero: 'hold'` clamps, so it can never go negative however long it sits there.
eq('held past zero', S.renderStageCue(cd, T0 + 400_000).text, '0:00');

const overtime = S.resolveStagePayload([layer(1, [countdown({ onZero: 'countUp' })])], { 1: runtime() }, false, 'en').layers[0].cue;
ok('overtime does not clamp', overtime.clampAtZero === false);
eq('and counts into the negative', S.renderStageCue(overtime, T0 + 310_000).text, '-0:10');

const up = S.resolveStagePayload([layer(1, [{ id: 'u', kind: 'countup', format: { preset: 'auto' } }])], { 1: runtime() }, false, 'en')
  .layers[0].cue;
eq('a count-up is anchored to its start', up.anchor, T0);
eq('and counts forward', S.renderStageCue(up, T0 + 65_000).text, '1:05');

// Thresholds, with danger winning where both are met.
const warned = S.resolveStagePayload([layer(1, [countdown({ warnSec: 60, dangerSec: 10 })])], { 1: runtime() }, false, 'en').layers[0].cue;
const urgencyAt = (elapsed) => S.stageUrgency(warned, S.renderStageCue(warned, T0 + elapsed).remainingSec);
eq('normal early on', urgencyAt(0), 'normal');
eq('warn inside a minute', urgencyAt(250_000), 'warn');
eq('danger inside ten seconds', urgencyAt(295_000), 'danger');
eq('still danger at zero', urgencyAt(300_000), 'danger');

// ── When a cue hands over ─────────────────────────────────────────────────────

eq('a clock never ends', S.cueEndsAt(clockCue, T0), null);
eq('a held countdown never ends', S.cueEndsAt(countdown({ onZero: 'hold' }), T0), null);
eq('an overtime countdown never ends', S.cueEndsAt(countdown({ onZero: 'countUp' }), T0), null);
eq('one that advances ends at zero', S.cueEndsAt(countdown({ onZero: 'next' }), T0), T0 + 300_000);
eq('one that hides ends at zero too', S.cueEndsAt(countdown({ onZero: 'hide' }), T0), T0 + 300_000);
eq('a message with a delay ends', S.cueEndsAt({ id: 'm', kind: 'message', text: 'x', autoNextSec: 8 }, T0), T0 + 8_000);
eq('a message without one waits for Go', S.cueEndsAt({ id: 'm', kind: 'message', text: 'x' }, T0), null);
eq('cueAutoAdvances agrees', S.cueAutoAdvances(countdown({ onZero: 'next' })), true);
eq('and for a clock', S.cueAutoAdvances(clockCue), false);

// A time-of-day target resolves against the moment the cue STARTED, not "now" — otherwise a
// target could slide forward a day while its own countdown was already running.
const tod = countdown({ source: 'timeOfDay', atTime: '10:00', onZero: 'next' });
const startedAt = new Date(2028, 2, 4, 9, 0, 0).getTime();
eq('time-of-day target is the next occurrence', S.cueEndsAt(tod, startedAt), new Date(2028, 2, 4, 10, 0, 0).getTime());
eq('resolved from the start, not from now', S.cueEndsAt(tod, startedAt), S.countdownTarget(tod, startedAt));

// ── Window configuration model ────────────────────────────────────────────────

const reducer = W.default;
const cfgs = (state) => state.windowConfigs;

let state = reducer(undefined, { type: '@@init' });
state = reducer(state, W.upsertWindowConfig({ id: 'a', name: 'Beamer', _runtimeId: 'pres-1' }));
state = reducer(state, W.upsertWindowConfig({ id: 'b', name: 'Stage' }));
eq('two windows configured', cfgs(state).length, 2);

// The change the whole rework rests on: closing detaches the runtime handle and keeps
// everything else, so the window can be reopened next service.
state = reducer(state, W.setWindowRuntimeId({ id: 'a', runtimeId: null }));
eq('closing keeps the config', cfgs(state).length, 2);
eq('and its name', cfgs(state)[0].name, 'Beamer');
ok('but drops the runtime handle', cfgs(state)[0]._runtimeId === undefined);

state = reducer(state, W.upsertWindowConfig({ id: 'a', styleId: 7 }));
eq('a patch merges rather than replaces', cfgs(state)[0].name, 'Beamer');
eq('and applies the change', cfgs(state)[0].styleId, 7);

state = reducer(state, W.reorderWindowConfigs(['b', 'a']));
eq(
  'reorder follows the given order',
  cfgs(state).map((c) => c.id),
  ['b', 'a'],
);
// A stale id list must never lose a window.
state = reducer(state, W.reorderWindowConfigs(['a']));
eq(
  'an incomplete order keeps everyone',
  cfgs(state)
    .map((c) => c.id)
    .sort(),
  ['a', 'b'],
);

state = reducer(state, W.removeWindowConfig('a'));
eq(
  'deleting does remove it',
  cfgs(state).map((c) => c.id),
  ['b'],
);

state = reducer(state, W.upsertWindowConfig({ id: 'b', _runtimeId: 'pres-9' }));
state = reducer(state, W.clearWindowRuntimeIds());
ok('clearing runtime ids keeps the configs', cfgs(state).length === 1 && cfgs(state)[0]._runtimeId === undefined);

// Every write reaches storage — a config that only lives in memory is gone at the next start.
ok('state is persisted', JSON.parse(store.get('presenter_windows')).windowConfigs.length === 1);

console.log(failed ? `\n${failed} failing` : '\nall passing');
process.exit(failed ? 1 : 0);
