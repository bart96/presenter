/**
 * Monitor-mixer rules test.
 *
 *   npm run test:mixer
 *
 * Covers the three pieces of the audio bridge that are pure functions, and that a mistake
 * in would be expensive and quiet:
 *
 *   1. The Behringer fader taper. Every level on the wire is a taper position, so an error
 *      here is wrong decibels on a musician's phone with nothing to compare against.
 *   2. `refuseCommand` — what a musician may and may not do. This is the whole reason the
 *      operator sits between the phone and the desk, so it is worth asserting rather than
 *      trusting a screen that happens not to draw a button.
 *   3. `filterAudioState` / `trimMeters` — what actually leaves the building. A leak here
 *      is a mix the operator deliberately withheld arriving anyway.
 *
 * No relay, no desk, no browser: these are the parts that can be checked without one. The
 * wiring around them is exercised against real hardware — see the module comment in
 * `src/renderer/src/hooks/useAudioMixerHost.ts`.
 */
import { build } from 'esbuild';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

/**
 * Both modules under test are deliberately dependency-free — no React, no store, no
 * imports at all — precisely so the operator, the musician page and the lazily-loaded
 * mixer chunk can share them. That is what makes them bundleable on their own here.
 */
const dir = mkdtempSync(join(tmpdir(), 'mixer-'));

await build({
  entryPoints: ['src/renderer/src/audio/fader.ts', 'src/renderer/src/audio/protocol.ts'],
  bundle: true,
  format: 'esm',
  outdir: dir,
  outbase: 'src/renderer/src',
  platform: 'node',
});

const fader = await import(pathToFileURL(join(dir, 'audio', 'fader.js')).href);
const protocol = await import(pathToFileURL(join(dir, 'audio', 'protocol.js')).href);

let passed = 0;
let failed = 0;

const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}\n          expected ${JSON.stringify(expected)}\n          got      ${JSON.stringify(actual)}`);
  }
};

const close = (label, actual, expected, epsilon = 1e-6) => {
  const ok = Math.abs(actual - expected) < epsilon;
  if (ok) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}\n          expected ${expected} (±${epsilon})\n          got      ${actual}`);
  }
};

// ── 1. The taper ────────────────────────────────────────────────────────────
console.log('\nFader taper');

// The anchors the desk itself uses. Getting these wrong is whole decibels of error.
for (const [level, db] of [
  [0.0625, -60],
  [0.25, -30],
  [0.5, -10],
  [0.75, 0],
  [1.0, 10],
]) {
  close(`faderToDb(${level}) = ${db}`, fader.faderToDb(level), db);
}

check('a closed fader is -Infinity, not -90', fader.faderToDb(0), null); // JSON turns -Infinity into null
close('unity as the hardware reports it reads 0 dB', fader.faderToDb(0.7497556209564209), 0, 0.01);

// The inverse has to be exact, or a typed value and the fader it moves disagree.
for (const db of [-60, -30, -10, -6, 0, 5, 10]) {
  close(`dbToFader(${db}) round-trips`, fader.faderToDb(fader.dbToFader(db)), db, 1e-9);
}
// Unity prints without a sign, as the desk itself does — the `+` is only for gain above
// it. Asserted because this file is a verbatim port of Streamer's, and the two showing a
// level differently is the single thing sharing the module exists to prevent.
check('formatDb(0.75) — unity, unsigned', fader.formatDb(0.75), '0.0 dB');
check('formatDb(1) — above unity, signed', fader.formatDb(1), '+10.0 dB');
check('formatDb(0.5)', fader.formatDb(0.5), '-10.0 dB');
check('formatDb(0) is a symbol, not a number to type back', fader.formatDb(0), '-∞');

// ── 2. What a musician may do ───────────────────────────────────────────────
console.log('\nCommand permissions');

const allowed = new Set(['bus1', 'bus2']);
const allowedWithMain = new Set(['bus1', 'bus2', 'main']);
const perms = (over = {}) => ({
  main: false,
  mainMute: false,
  mixMute: true,
  stripMutes: false,
  muteGroups: false,
  meters: true,
  ...over,
});
const refuse = (cmd, args, p = perms(), mixes = allowed) => protocol.refuseCommand(cmd, args, p, mixes);
const allow = (label, ...args) => check(label, refuse(...args), null);
const deny = (label, ...args) => check(label, typeof refuse(...args) === 'string', true);

allow('a send on an allowed bus', 'setSendLevel', { stripId: '3', mixId: 'bus1', level: 0.5 });
deny('a send on a bus that was not given', 'setSendLevel', { stripId: '3', mixId: 'bus5', level: 0.5 });
deny('anything on the main while the main is withheld', 'setSendLevel', { stripId: '3', mixId: 'main', level: 0.5 });
deny('muting the main while the main is withheld', 'setMixMute', { mixId: 'main', muted: true });

// The main can be offered to look at without being muteable — the two are separate
// switches because one changes a musician's own monitor and the other silences the room.
deny(
  'muting the main when it is shown but muting is not allowed',
  'setMixMute',
  { mixId: 'main', muted: true },
  perms({ main: true }),
  allowedWithMain,
);
allow(
  'muting the main once both switches are on',
  'setMixMute',
  { mixId: 'main', muted: true },
  perms({ main: true, mainMute: true }),
  allowedWithMain,
);

// This one is refused on every desk, permissions or not: `sends.main` has no mute, and
// dressing the global strip mute up as one is the mistake the contract's §5.3 forbids.
deny(
  'a per-send mute on the main, even with every permission granted',
  'setSendMute',
  { stripId: '3', mixId: 'main', muted: true },
  perms({ main: true, mainMute: true, stripMutes: true, muteGroups: true }),
  allowedWithMain,
);
allow('a per-send mute on an allowed bus', 'setSendMute', { stripId: '3', mixId: 'bus1', muted: true });

allow('muting an allowed bus master', 'setMixMute', { mixId: 'bus1', muted: true });
deny('muting a bus master when mix mutes are off', 'setMixMute', { mixId: 'bus1', muted: true }, perms({ mixMute: false }));

deny('mute-everywhere while the operator withholds it', 'setStripMute', { stripId: '3', muted: true });
allow('mute-everywhere once the operator allows it', 'setStripMute', { stripId: '3', muted: true }, perms({ stripMutes: true }));

deny('a mute group while they are off', 'setMuteGroup', { index: 1, active: true });
allow('a mute group once they are on', 'setMuteGroup', { index: 1, active: true }, perms({ muteGroups: true }));

deny('a command nobody has heard of', 'setPhantomPower', { stripId: '3' });

// ── 3. What leaves the building ─────────────────────────────────────────────
console.log('\nFiltering');

const state = {
  mixes: {
    list: [
      { id: 'bus1', name: 'Wedge Drums', kind: 'bus', muted: false, level: 0.75 },
      { id: 'bus2', name: 'IEM Vocals', kind: 'bus', muted: false, level: 0.75 },
      { id: 'bus9', name: 'Broadcast', kind: 'bus', muted: false, level: 0.6 },
      { id: 'main', name: 'Main', kind: 'main', muted: false, level: 0.77 },
    ],
  },
  strips: {
    list: [
      {
        id: '3',
        name: 'E-Git',
        kind: 'channel',
        icon: 21,
        color: '#FCF300',
        muted: false,
        muteGroups: [1],
        sends: { bus1: { level: 0.4 }, bus2: { level: 0.5 }, bus9: { level: 0.9 }, main: { level: 0.75 } },
      },
    ],
  },
  muteGroups: { list: [{ index: 1, name: 'Mute 1', active: false }] },
};

const filtered = protocol.filterAudioState(state, allowed);
check(
  'withheld mixes are gone',
  filtered.mixes.list.map((m) => m.id),
  ['bus1', 'bus2'],
);
check('and so are their sends inside every strip', Object.keys(filtered.strips.list[0].sends), ['bus1', 'bus2']);
check('mute groups pass through — they are not per-mix', filtered.muteGroups.list.length, 1);
check('the original document is untouched', state.mixes.list.length, 4);

const meters = { strips: { 1: 0.1, 3: 0.42, 7: 0.9 }, mixes: { bus1: 0.61, bus9: 0.8, main: 0.5 } };
const trimmed = protocol.trimMeters(meters, { mixId: 'bus1', stripIds: ['3'], meters: true }, allowed);
check('only the chosen strips are metered', trimmed.strips, { 3: 0.42 });
check('only the mix being watched is metered', trimmed.mixes, { bus1: 0.61 });

const trimmedAll = protocol.trimMeters(meters, { mixId: 'bus1', meters: true }, allowed);
check('no strip preference means every strip', Object.keys(trimmedAll.strips).length, 3);

// Hiding every channel is a real state on the way to picking a few, and it must not read
// as "no preference" — that would meter all forty-eight for someone looking at none.
const trimmedNone = protocol.trimMeters(meters, { mixId: 'bus1', stripIds: [], meters: true }, allowed);
check('hiding every strip meters none of them', trimmedNone.strips, {});
check('but the mix being watched is still metered', trimmedNone.mixes, { bus1: 0.61 });

const trimmedBad = protocol.trimMeters(meters, { mixId: 'bus9', stripIds: ['3'], meters: true }, allowed);
check('a mix this client may not see is never metered to it', trimmedBad.mixes, {});

// ── 4. Which announcement wins ──────────────────────────────────────────────
//
// More than one Presenter can be signed in to an account, and the relay hands
// `audio_hello` to every one of them. The instance with monitor mixing switched off used
// to answer too, and its "no mixer here" landed a few hundred milliseconds after the real
// desk's — so the musician was told the mixing desk was not responding while it was
// responding perfectly. Observed live on account 1215408.
console.log('\nAnnouncement precedence');

const ann = (over = {}) => ({
  enabled: true,
  link: 'connected',
  permissions: perms(),
  mixCount: 5,
  rev: 1,
  from: 'op-host',
  ...over,
});
const live = ann();
const dark = ann({ enabled: false, link: 'offline', mixCount: 0, from: 'op-other' });
const supersedes = protocol.supersedesAnnouncement;

check('the first answer is always taken', supersedes(null, dark), true);
check('a second operator with no mixer cannot take the desk away', supersedes(live, dark), false);
check('the hosting operator may retract its own mixer', supersedes(live, { ...dark, from: 'op-host' }), true);
check('the hosting operator may report its desk dropping', supersedes(live, ann({ link: 'offline', mixer: undefined })), true);
check('an operator that does offer a mixer is believed', supersedes(dark, live), true);
check('nothing is pinned when neither offers a mixer', supersedes(dark, { ...dark, from: 'op-third' }), true);
// Not naming yourself is an identity too, and it is not the same identity as a name. This
// is the case that was still live in the field: a Presenter left open through an update
// kept announcing "no mixer here" unstamped, and a version of this rule that treated a
// missing stamp as a wildcard let it go on taking the desk away from the updated one.
check('an unstamped downgrade cannot touch a stamped mixer', supersedes(live, { ...dark, from: undefined }), false);
check('nor can a stamped downgrade touch an unstamped mixer', supersedes({ ...live, from: undefined }, dark), false);
// On an all-old rig neither side can name itself, there is nothing to tell apart, and the
// single operator must still be able to switch the feature off.
check('two unstamped builds keep the old last-one-wins', supersedes({ ...live, from: undefined }, { ...dark, from: undefined }), true);

// ── 5. The two-operator sequence, as captured off a live rig ────────────────
//
// Replays exactly what account 1215408 put on the wire on 2026-09-08 in answer to one
// `audio_hello` and one `audio_subscribe`, with one Presenter updated and one left open
// from before. The client half is the same two rules `useMixerBridge` applies: pick a
// host with `supersedesAnnouncement`, then ignore anything not stamped by that host.
console.log('\nLive two-operator replay');

const client = () => {
  let ann = null;
  let hostId = '';
  const applied = [];
  return {
    feed(action, data) {
      const source = typeof data.from === 'string' ? data.from : '';
      if (action === 'announce') {
        if (!protocol.supersedesAnnouncement(ann, data)) return;
        ann = data;
        hostId = source;
        return;
      }
      if (hostId && source !== hostId) return;
      applied.push({ action, data });
    },
    get link() {
      return ann ? ann.link : null;
    },
    get available() {
      return !!ann && ann.enabled && ann.mixCount > 0;
    },
    get snapshots() {
      return applied.filter((f) => f.action === 'snapshot');
    },
    get errors() {
      return applied.filter((f) => f.action === 'ack' && f.data.ok === false);
    },
  };
};

// The real M32, and the stale instance that cannot name itself.
const good = { from: 'op-mtrtyh63-wo9ytv', enabled: true, link: 'connected', mixCount: 5, rev: 1, permissions: perms() };
const stale = { enabled: false, link: 'offline', mixCount: 0, rev: 1, permissions: perms() };
const goodSnapshot = { from: good.from, state: { mixes: { list: [{ id: 'bus8', name: 'Wedge', kind: 'bus' }] }, strips: { list: [] } } };
const staleSnapshot = { state: {} };

const c = client();
// audio_hello — both answer, the stale one last, which is what used to win.
c.feed('announce', good);
c.feed('announce', stale);
check('the live desk survives the stale answer', c.link, 'connected');
check('so the mixer stays on offer', c.available, true);

// audio_subscribe — both answer again, and the stale one sends an empty snapshot.
c.feed('announce', good);
c.feed('announce', stale);
c.feed('snapshot', goodSnapshot);
c.feed('snapshot', staleSnapshot);
check('only the host is allowed to fill the mixer in', c.snapshots.length, 1);
check('and it is the one with the channels in it', c.snapshots[0].data.state.mixes.list[0].id, 'bus8');

// audio_cmd — broadcast, so the stale instance refuses a mix it has never heard of while
// the real operator is busy applying it. That refusal must not reach the musician.
c.feed('ack', { id: 1, ok: false, error: 'mix bus8 is not available to you' });
c.feed('ack', { from: good.from, id: 1, ok: true });
check('a refusal from a non-host is not shown to the musician', c.errors.length, 0);

// ── Result ──────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
