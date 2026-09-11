/**
 * useMixerSession — the live desk, as one musician sees it.
 *
 * Everything here is inside the lazily-loaded mixer chunk, so none of it is downloaded
 * by a musician who never opens the mixer.
 *
 * Two things in it are less obvious than they look:
 *
 * **Meters bypass React entirely.** They arrive at 10 Hz, and re-rendering a column of
 * strips ten times a second to animate a bar is a waste of a phone's battery during a
 * service. They are published through a subscription instead, and the bars write their
 * own height — see `MixerMeter`.
 *
 * **Faders are optimistic.** The bridge's `ack` only means the command was sent; the desk
 * confirms separately by echoing the change back as a patch, over UDP, after up to 100 ms
 * of coalescing. Waiting for that would make every fader lag behind the finger. So a
 * moved fader is applied locally straight away and the local value is dropped as soon as
 * the desk's own answer arrives — or, if it never does, after {@link OPTIMISTIC_TTL_MS},
 * which is how a refused command visibly springs back instead of lying.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MixerBridge } from '@/hooks/useMixerBridge';
import {
  AUDIO_ACTIONS,
  AUDIO_KEEPALIVE_MS,
  bridgeDocument,
  mergeAudioState,
  type AudioCommand,
  type AudioMeters,
  type AudioState,
  type IMix,
  type IStrip,
} from '@/audio/protocol';

/**
 * How long a locally-applied value outranks the desk.
 *
 * Long enough to cover a coalesced patch (100 ms) plus a round trip over the relay and
 * the venue's wifi; short enough that a command the operator refused snaps back while
 * the finger is still near the fader, rather than looking like it worked.
 */
const OPTIMISTIC_TTL_MS = 1200;

/** How often a fader being dragged is sent. Last write wins, so this is not a queue. */
export const DRAG_SEND_INTERVAL_MS = 50;

export type MetersHandler = (meters: AudioMeters) => void;

/** A local value waiting to be confirmed (or contradicted) by the desk. */
interface Optimistic {
  value: number | boolean;
  at: number;
}

export interface MixerSession {
  /** True once the operator's snapshot has arrived. */
  ready: boolean;
  mixes: IMix[];
  strips: IStrip[];
  muteGroups: { index: number; name: string; active: boolean }[];
  /** The last command the operator refused, for the one place that should say so. */
  lastError: { message: string; at: number } | null;
  send: (command: AudioCommand) => void;
  /** Subscribe to meter frames. Returns its own unsubscribe. */
  onMeters: (handler: MetersHandler) => () => void;
  /** Level of one send, with any un-confirmed local move applied. */
  sendLevel: (strip: IStrip, mixId: string) => number;
  sendMuted: (strip: IStrip, mixId: string) => boolean;
  stripMuted: (strip: IStrip) => boolean;
  mixLevel: (mix: IMix) => number;
  mixMuted: (mix: IMix) => boolean;
}

interface UseMixerSessionOptions {
  bridge: MixerBridge;
  /** The mix being watched, so the operator can trim meters to it. */
  mixId: string | undefined;
  /** Strips this device shows; empty means all. Also trims meters. */
  stripIds: string[];
  meters: boolean;
}

export const useMixerSession = ({ bridge, mixId, stripIds, meters }: UseMixerSessionOptions): MixerSession => {
  const [state, setState] = useState<AudioState>({});
  const [ready, setReady] = useState(false);
  const [lastError, setLastError] = useState<{ message: string; at: number } | null>(null);

  /** Key → local value. Keys are `send:<strip>:<mix>`, `mix:<id>`, `strip:<id>`, … */
  const optimisticRef = useRef(new Map<string, Optimistic>());
  /** Bumped when the overlay changes, purely to make React re-read it. */
  const [, setOverlayTick] = useState(0);
  const metersHandlersRef = useRef(new Set<MetersHandler>());

  const { send: sendFrame, subscribe } = bridge;

  // ── Frames from the operator ───────────────────────────────────────────────
  useEffect(
    () =>
      subscribe((action, data) => {
        switch (action) {
          case AUDIO_ACTIONS.snapshot: {
            // A snapshot is the desk's own truth for everything at once, so nothing local
            // may survive it. This is also the recovery path after a gap: the contract is
            // explicit that patches must never be merged onto a pre-gap document (§8).
            optimisticRef.current.clear();
            setState(bridgeDocument(data));
            setReady(true);
            return;
          }
          case AUDIO_ACTIONS.patch: {
            const patch = bridgeDocument(data);
            setState((current) => mergeAudioState(current, patch));
            // The desk has spoken — but only for the feeds this patch carries. Dropping
            // every local guess on any patch meant someone moving a bus master snapped
            // back a channel fader that had just been moved and not yet echoed, so the
            // clear is limited to the feed that actually changed. Lists are replaced
            // wholesale (contract §4.4), so a feed being present speaks for all of it.
            if (optimisticRef.current.size) {
              const prefixes: string[] = [];
              if (patch.strips) prefixes.push('send:', 'sendmute:', 'stripmute:');
              if (patch.mixes) prefixes.push('mix:', 'mixmute:');
              let cleared = false;
              for (const key of [...optimisticRef.current.keys()]) {
                if (!prefixes.some((prefix) => key.startsWith(prefix))) continue;
                optimisticRef.current.delete(key);
                cleared = true;
              }
              if (cleared) setOverlayTick((n) => n + 1);
            }
            return;
          }
          case AUDIO_ACTIONS.meters: {
            const frame: AudioMeters = {
              strips: (data.strips ?? {}) as Record<string, number>,
              mixes: (data.mixes ?? {}) as Record<string, number>,
            };
            for (const handler of metersHandlersRef.current) handler(frame);
            return;
          }
          case AUDIO_ACTIONS.ack: {
            // `ok: true` only means it was sent, so success is deliberately silent — the
            // patch that follows is the confirmation. A refusal is worth saying out loud.
            if (data.ok === false) {
              optimisticRef.current.clear();
              setOverlayTick((n) => n + 1);
              setLastError({ message: typeof data.error === 'string' ? data.error : 'refused', at: Date.now() });
            }
            return;
          }
          case AUDIO_ACTIONS.event: {
            // The desk dropped or came back. Either way the document is suspect, and the
            // operator sends a fresh snapshot once it has one.
            if (data.name === 'mixerDisconnected') setReady(false);
            return;
          }
          default:
            return;
        }
      }),
    [subscribe],
  );

  // ── Subscription ───────────────────────────────────────────────────────────
  //
  // What this phone is watching, read by the keepalive below so that changing it never
  // has to restart the timer.
  const payloadRef = useRef<Record<string, unknown>>({});
  payloadRef.current = { mixId, stripIds, meters };

  /**
   * Tell the operator what changed — as an update, never as a teardown.
   *
   * This used to be one effect with the keepalive, so picking a channel ran its cleanup:
   * `unsubscribe`, then `subscribe`. To the operator that is not a change of mind, it is a
   * *new* subscriber, and a new subscriber is answered with a fresh announcement and a
   * full 48-strip snapshot — the whole mixer re-rendered to add one fader. Worse, for the
   * instant between the two frames nobody was left asking for meters, so the operator
   * dropped the desk's meter feed and immediately asked for it again, and every bar fell
   * to zero on the way past. Sending `subscribe` on its own is idempotent for a client the
   * operator already knows: it just swaps the parameters.
   *
   * `stripIds` is an array; the caller memoises it so this does not fire per render.
   */
  useEffect(() => {
    if (!bridge.connected) return;
    sendFrame(AUDIO_ACTIONS.subscribe, payloadRef.current);
  }, [bridge.connected, sendFrame, mixId, stripIds, meters]);

  // The renewal is what tells the operator this phone still exists. Without it a tab
  // closed mid-service would keep the desk's meter feed alive for nobody. Deliberately its
  // own effect, keyed on the connection alone, so the note above holds.
  useEffect(() => {
    if (!bridge.connected) return;
    const timer = setInterval(() => sendFrame(AUDIO_ACTIONS.subscribe, payloadRef.current), AUDIO_KEEPALIVE_MS);
    return () => {
      clearInterval(timer);
      sendFrame(AUDIO_ACTIONS.unsubscribe);
    };
  }, [bridge.connected, sendFrame]);

  const onMeters = useCallback((handler: MetersHandler) => {
    metersHandlersRef.current.add(handler);
    return () => {
      metersHandlersRef.current.delete(handler);
    };
  }, []);

  // ── Commands ───────────────────────────────────────────────────────────────
  const cmdSeqRef = useRef(0);

  const send = useCallback(
    (command: AudioCommand) => {
      const args = command.args as Record<string, unknown>;
      // Record what we just asked for, so the control follows the finger rather than the
      // network. Cleared by the next patch, or by the sweep below if none arrives.
      const key = optimisticKey(command);
      if (key) {
        const value = 'level' in args ? (args.level as number) : (args.muted as boolean);
        optimisticRef.current.set(key, { value, at: Date.now() });
        setOverlayTick((n) => n + 1);
      }
      sendFrame(AUDIO_ACTIONS.cmd, { id: ++cmdSeqRef.current, cmd: command.cmd, args });
    },
    [sendFrame],
  );

  // A command that is never answered — the operator went away mid-drag, the desk is
  // gone — must not leave the control sitting on a value that was never applied.
  useEffect(() => {
    const timer = setInterval(() => {
      const cutoff = Date.now() - OPTIMISTIC_TTL_MS;
      let changed = false;
      for (const [key, entry] of optimisticRef.current) {
        if (entry.at < cutoff) {
          optimisticRef.current.delete(key);
          changed = true;
        }
      }
      if (changed) setOverlayTick((n) => n + 1);
    }, OPTIMISTIC_TTL_MS / 2);
    return () => clearInterval(timer);
  }, []);

  // ── Reading a value, local guess first ─────────────────────────────────────
  const overlay = optimisticRef.current;

  const sendLevel = useCallback(
    (strip: IStrip, id: string) => {
      const local = overlay.get(`send:${strip.id}:${id}`);
      if (typeof local?.value === 'number') return local.value;
      return strip.sends[id]?.level ?? 0;
    },
    [overlay],
  );

  const sendMuted = useCallback(
    (strip: IStrip, id: string) => {
      const local = overlay.get(`sendmute:${strip.id}:${id}`);
      if (typeof local?.value === 'boolean') return local.value;
      return !!strip.sends[id]?.muted;
    },
    [overlay],
  );

  const stripMuted = useCallback(
    (strip: IStrip) => {
      const local = overlay.get(`stripmute:${strip.id}`);
      if (typeof local?.value === 'boolean') return local.value;
      return strip.muted;
    },
    [overlay],
  );

  const mixLevel = useCallback(
    (mix: IMix) => {
      const local = overlay.get(`mix:${mix.id}`);
      if (typeof local?.value === 'number') return local.value;
      return mix.level;
    },
    [overlay],
  );

  const mixMuted = useCallback(
    (mix: IMix) => {
      const local = overlay.get(`mixmute:${mix.id}`);
      if (typeof local?.value === 'boolean') return local.value;
      return mix.muted;
    },
    [overlay],
  );

  const mixes = useMemo(() => state.mixes?.list ?? [], [state.mixes]);
  const strips = useMemo(() => state.strips?.list ?? [], [state.strips]);
  const muteGroups = useMemo(() => state.muteGroups?.list ?? [], [state.muteGroups]);

  return { ready, mixes, strips, muteGroups, lastError, send, onMeters, sendLevel, sendMuted, stripMuted, mixLevel, mixMuted };
};

/** Where a command's optimistic value is filed, or null when it has no visible control. */
const optimisticKey = (command: AudioCommand): string | null => {
  switch (command.cmd) {
    case 'setSendLevel':
      return `send:${command.args.stripId}:${command.args.mixId}`;
    case 'setSendMute':
      return `sendmute:${command.args.stripId}:${command.args.mixId}`;
    case 'setStripMute':
      return `stripmute:${command.args.stripId}`;
    case 'setMixLevel':
      return `mix:${command.args.mixId}`;
    case 'setMixMute':
      return `mixmute:${command.args.mixId}`;
    default:
      // Mute groups come back from the desk fast and have no in-between state worth
      // guessing at — a group is either on or it is not.
      return null;
  }
};
