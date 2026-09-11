/**
 * A stand-in for Streamer's audio bridge.
 *
 *   node test/mixer/fake-bridge.mjs            # X32-shaped: per-send mutes, meters
 *   node test/mixer/fake-bridge.mjs --xair     # X-Air-shaped: no per-send mutes
 *   node test/mixer/fake-bridge.mjs --no-desk  # bridge up, but no desk answering
 *   node test/mixer/fake-bridge.mjs --port 5003
 *
 * Monitor mixing needs a mixing desk at the other end, which makes the whole feature
 * untestable on any machine that has not got one — including CI, and including whoever
 * picks this up next. This speaks enough of the contract
 * (`Streamer/docs/audio-bridge-contract.md`) to drive the real UI: hello, a snapshot,
 * commands with acks, and the desk echoing changes back as patches.
 *
 * Two details are deliberately faithful rather than convenient, because a fake that
 * smooths them over would hide the bugs they cause:
 *
 *   - **A snapshot carries its document under `state`; a patch carries it under
 *     `changed`.** Undocumented, and reading the wrong one is a mixer that silently stops
 *     updating. See `bridgeDocument` in `@/audio/protocol`.
 *   - **An ack is not a confirmation.** `ok: true` means the command was accepted; the
 *     value only really moves when the patch arrives, which it does a beat later.
 *
 * The X-Air shape matters too: it has no per-send mute at all, so `setSendMute` is
 * refused rather than quietly falling back to muting the strip everywhere.
 */
import { WebSocketServer } from 'ws';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const portArg = argv.indexOf('--port');
const PORT = portArg >= 0 ? Number(argv[portArg + 1]) : 5003;

const XAIR = has('--xair');
const NO_DESK = has('--no-desk');
/** Coalescing window, as the real bridge uses — one patch per sweep, not one per move. */
const PATCH_MS = 100;
const METER_HZ = 10;

const UNITY = 0.7497556209564209;

/** Names and colours in the shape a real desk reports them. */
const STRIP_SEED = [
  ['1', 'Funk 1', '#CCC'],
  ['2', 'Funk 2', '#CCC'],
  ['3', 'M1', '#00FFFF'],
  ['4', 'M2', '#00FFFF'],
  ['5', 'M3', '#00FFFF'],
  ['6', 'Cajon', '#FFF'],
  ['7', 'E-Git 1', '#FCF300'],
  ['8', 'E-Git 2', '#FCF300'],
  ['9', 'Keys L', '#FCF300'],
  ['10', 'Keys R', '#FCF300'],
  ['11', 'Bass', '#00FF00'],
  ['12', 'Click', '#FF00FF'],
];

const busCount = XAIR ? 6 : 16;

const state = {
  mixes: {
    list: [
      ...Array.from({ length: busCount }, (_, i) => ({
        id: `bus${i + 1}`,
        // An X32's last four buses are its FX sends in most rigs — the case the operator's
        // allow-list exists for, so the fake reproduces it.
        name: !XAIR && i >= 12 ? `Fx ${Math.floor((i - 12) / 2) + 1} (${(i - 12) % 2 ? 'R' : 'L'})` : `Bus ${i + 1}`,
        kind: 'bus',
        muted: !XAIR && i >= 12,
        level: UNITY,
      })),
      { id: 'main', name: 'Main', kind: 'main', muted: false, level: 0.772 },
    ],
  },
  strips: {
    list: STRIP_SEED.map(([id, name, color], index) => ({
      id,
      name,
      kind: 'channel',
      icon: 1,
      color,
      muted: false,
      muteGroups: index % 5 === 0 ? [1] : [],
      sends: Object.fromEntries([
        ...Array.from({ length: busCount }, (_, i) => [
          `bus${i + 1}`,
          // `muted` only exists where the hardware has it — see contract §5.3.
          XAIR ? { level: index < 6 ? 0.5 : 0 } : { level: index < 6 ? 0.5 : 0, muted: false },
        ]),
        ['main', { level: UNITY }],
      ]),
    })),
  },
  muteGroups: {
    list: Array.from({ length: XAIR ? 4 : 6 }, (_, i) => ({ index: i + 1, name: `Mute ${i + 1}`, active: false })),
  },
};

const findMix = (id) => state.mixes.list.find((mix) => mix.id === id);
const findStrip = (id) => state.strips.list.find((strip) => strip.id === id);
const clamp01 = (value) => Math.max(0, Math.min(1, value));

const clients = new Set();

/** What changed since the last flush, coalesced into one patch per window. */
let dirty = new Set();
let flushTimer = null;

const markDirty = (feed) => {
  dirty.add(feed);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const changed = {};
    for (const feed of dirty) changed[feed] = state[feed];
    dirty = new Set();
    // `changed`, not `state` — see the header.
    broadcast({ v: 1, t: 'patch', changed });
  }, PATCH_MS);
};

const send = (ws, frame) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(frame));
};

const broadcast = (frame) => {
  for (const client of clients) if (client.subscribed) send(client.ws, frame);
};

/** Every argument is checked and a bad one refused, never rounded off (contract §5). */
const runCommand = (cmd, args = {}) => {
  if (NO_DESK) return 'mixer is not connected';

  const level = args.level;
  const muted = args.muted;

  switch (cmd) {
    case 'setSendLevel': {
      const strip = findStrip(args.stripId);
      if (!strip) return `unknown strip "${args.stripId}"`;
      if (!findMix(args.mixId)) return `unknown mix "${args.mixId}"`;
      if (typeof level !== 'number' || Number.isNaN(level)) return 'level must be a number';
      const sendEntry = strip.sends[args.mixId];
      if (!sendEntry) return `strip "${args.stripId}" has no send to "${args.mixId}"`;
      sendEntry.level = clamp01(level);
      markDirty('strips');
      return null;
    }
    case 'setSendMute': {
      if (XAIR) return 'this desk has no per-send mutes';
      if (args.mixId === 'main') return 'the main mix has no per-send mute';
      const strip = findStrip(args.stripId);
      if (!strip) return `unknown strip "${args.stripId}"`;
      const sendEntry = strip.sends[args.mixId];
      if (!sendEntry) return `unknown mix "${args.mixId}"`;
      if (typeof muted !== 'boolean') return 'muted must be a boolean';
      sendEntry.muted = muted;
      markDirty('strips');
      return null;
    }
    case 'setStripMute': {
      const strip = findStrip(args.stripId);
      if (!strip) return `unknown strip "${args.stripId}"`;
      if (typeof muted !== 'boolean') return 'muted must be a boolean';
      strip.muted = muted;
      markDirty('strips');
      return null;
    }
    case 'setMixLevel': {
      const mix = findMix(args.mixId);
      if (!mix) return `unknown mix "${args.mixId}"`;
      if (typeof level !== 'number' || Number.isNaN(level)) return 'level must be a number';
      mix.level = clamp01(level);
      markDirty('mixes');
      return null;
    }
    case 'setMixMute': {
      const mix = findMix(args.mixId);
      if (!mix) return `unknown mix "${args.mixId}"`;
      if (typeof muted !== 'boolean') return 'muted must be a boolean';
      mix.muted = muted;
      markDirty('mixes');
      return null;
    }
    case 'setMuteGroup': {
      const group = state.muteGroups.list.find((g) => g.index === args.index);
      if (!group) return `unknown mute group ${args.index}`;
      if (typeof args.active !== 'boolean') return 'active must be a boolean';
      group.active = args.active;
      markDirty('muteGroups');
      return null;
    }
    default:
      return `unknown command "${cmd}"`;
  }
};

// ── Meters ──────────────────────────────────────────────────────────────────
// Plausible movement rather than noise: a couple of channels loud, a couple idle, so a
// meter that is wired to the wrong id is obvious on screen instead of looking alive.
let phase = 0;
setInterval(() => {
  const wanted = [...clients].filter((c) => c.meters);
  if (!wanted.length) return;
  phase += 0.35;

  const strips = {};
  state.strips.list.forEach((strip, i) => {
    const base = i < 6 ? 0.55 + 0.35 * Math.sin(phase + i) : i < 9 ? 0.2 + 0.15 * Math.sin(phase * 1.7 + i) : 0;
    strips[strip.id] = Math.max(0, Math.min(1, base));
  });

  const mixes = {};
  for (const mix of state.mixes.list) mixes[mix.id] = Math.max(0, Math.min(1, 0.45 + 0.3 * Math.sin(phase * 0.8)));

  const frame = JSON.stringify({ v: 1, t: 'meters', ts: Date.now(), strips, mixes });
  for (const client of wanted) if (client.ws.readyState === 1) client.ws.send(frame);
}, 1000 / METER_HZ);

// ── Server ──────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws, req) => {
  // The real bridge serves /audio; anything else is a client pointed at the wrong place.
  if (req.url && !req.url.startsWith('/audio')) {
    ws.close(4404, 'Unknown path');
    return;
  }

  const client = { ws, subscribed: false, meters: false };
  clients.add(client);

  send(ws, {
    v: 1,
    t: 'hello',
    schema: 1,
    appVersion: 'fake-1.0.0',
    ts: Date.now(),
    mixer: {
      type: XAIR ? 'xair' : 'x32',
      // Empty model is the honest way to say "no desk answered" — `connected` alone is
      // weaker than it looks, because a UDP socket opens either way (contract §3.3).
      model: NO_DESK ? '' : XAIR ? 'XR16' : 'X32RACK',
      firmware: NO_DESK ? '' : XAIR ? '1.22' : '4.15',
      connected: !NO_DESK,
    },
    capabilities: { sendMutes: !XAIR, sendLevels: true, meters: true, muteGroups: XAIR ? 4 : 6 },
    feeds: ['mixes', 'strips', 'meters', 'muteGroups'],
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.t === 'subscribe') {
      const feeds = Array.isArray(msg.feeds) && msg.feeds.length ? msg.feeds : ['mixes', 'strips', 'meters', 'muteGroups'];
      client.subscribed = true;
      client.meters = feeds.includes('meters');
      // `state`, not `changed` — the other half of the envelope quirk.
      send(ws, { v: 1, t: 'snapshot', state });
      return;
    }

    if (msg.t === 'resync') {
      send(ws, { v: 1, t: 'snapshot', state });
      return;
    }

    if (msg.t === 'cmd') {
      const error = runCommand(msg.cmd, msg.args);
      send(ws, error ? { v: 1, t: 'ack', id: msg.id, ok: false, error } : { v: 1, t: 'ack', id: msg.id, ok: true });
      return;
    }
    // Unknown frame types are ignored rather than refused, so either side can add one.
  });

  ws.on('close', () => clients.delete(client));
  ws.on('error', () => clients.delete(client));
});

console.log(
  `[fake-bridge] ws://localhost:${PORT}/audio — ${XAIR ? 'X-Air (no per-send mutes)' : 'X32'}${NO_DESK ? ', no desk connected' : ''}`,
);
console.log(`[fake-bridge] ${state.mixes.list.length} mixes, ${state.strips.list.length} strips, meters at ${METER_HZ} Hz`);
