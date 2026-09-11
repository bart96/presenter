/**
 * The audio-mixer protocol, in two halves.
 *
 * **Streamer's bridge** is the contract documented in Streamer's
 * `docs/audio-bridge-contract.md`: a websocket on the LAN that speaks in mixes, strips
 * and levels so nothing here has to know OSC, or whether the desk is an X32 or an XR16.
 *
 * **The relay envelope** is ours, and exists because musicians reach this app over
 * https. A browser blocks `ws://<lan-ip>` from an https page as mixed content, with no
 * override, so a phone cannot talk to the bridge directly. Instead the operator holds
 * the single bridge socket and forwards the parts of it a given musician is allowed to
 * see through the wss relay the app already runs.
 *
 * That indirection buys more than reachability. The operator sits in the command path,
 * so a musician who may not touch the main mix is *refused*, not merely shown a screen
 * without the button — which is the difference between a permission and a decoration.
 *
 * Nothing in here imports from the app: the operator host, the musician client and the
 * lazily-loaded mixer UI all share these types, and the mixer chunk must not drag the
 * store in behind them.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Bridge — Streamer's own frames, passed through unchanged where they are safe
// ─────────────────────────────────────────────────────────────────────────────

/** The schema this build understands. A bridge announcing another one is refused. */
export const AUDIO_SCHEMA = 1;

/** Default port of Streamer's bridge; 5001 is its backend and 5002 the Companion bridge. */
export const AUDIO_BRIDGE_DEFAULT_PORT = 5003;

/** A bus or the main output — the thing a musician listens on. */
export interface IMix {
  /** Stable; `main` for the master, `bus1`…`bus16` for the buses. */
  id: string;
  /** The desk's own scribble, or a numbered fallback the bridge supplies. */
  name: string;
  kind: 'bus' | 'main';
  muted: boolean;
  /** 0..1, the desk's own taper — see `fader.ts`. */
  level: number;
}

/** One strip's contribution to one mix. */
export interface ISend {
  level: number;
  /**
   * Only present on buses, and only on a desk with `sendMutes` (an X32). Never on
   * `main` on any desk: a strip's contribution to the main *is* its own fader, and the
   * only mute on that path is `IStrip.muted`.
   */
  muted?: boolean;
}

/** An input that feeds into a mix. */
export interface IStrip {
  /** Matches Streamer's channel ids exactly: `"3"`, `"auxin1"`, `"fxrtn2"`. */
  id: string;
  name: string;
  kind: 'channel' | 'auxin' | 'fxrtn';
  /** Behringer icon id, 1 when unknown. */
  icon: number;
  color: string;
  /** Silences the strip in every mix at once — see `MixerPermissions.stripMutes`. */
  muted: boolean;
  /** Mute groups this strip belongs to. Read-only over the protocol. */
  muteGroups: number[];
  /** Per mix id. A mix absent here cannot be sent to. */
  sends: Record<string, ISend>;
}

export interface IMuteGroup {
  /** 1-based, as the desk counts. */
  index: number;
  name: string;
  active: boolean;
}

/** What the bridge reports about the desk it is holding. */
export interface MixerInfo {
  type: string;
  /**
   * Empty until the desk has answered `/xinfo`, so a non-empty model is the proof a real
   * desk replied — a stronger signal than `connected`, which only means Streamer has a
   * UDP socket pointed at an address.
   */
  model: string;
  firmware: string;
  connected: boolean;
}

export interface MixerCapabilities {
  /** True on an X32, false on an X-Air, which has no per-send mute at all. */
  sendMutes: boolean;
  sendLevels: boolean;
  meters: boolean;
  muteGroups: number;
}

/** The complete state document, as carried by `snapshot` and merged from `patch`. */
export interface AudioState {
  mixes?: { list: IMix[] };
  strips?: { list: IStrip[] };
  muteGroups?: { list: IMuteGroup[] };
}

/**
 * Pull the state document out of a bridge frame.
 *
 * **The envelope key is not the same on both frames**, and the contract document does not
 * say so: a `snapshot` carries its document under `state`, a `patch` carries it under
 * `changed`. Both were read off the wire from a live X32 rather than from the spec.
 *
 * Reading the wrong one does not throw and does not log — it yields an empty document,
 * which merges to a no-op. The symptom is a mixer that shows the right thing on open and
 * then silently never changes again: a fader springs back after its optimistic value
 * lapses, and a move made at the desk never arrives. It cost an afternoon, so the
 * unwrapping lives here, once, with both keys accepted in either direction.
 */
export const bridgeDocument = (frame: Record<string, unknown>): AudioState => {
  const doc = frame.state ?? frame.changed;
  return doc && typeof doc === 'object' ? (doc as AudioState) : {};
};

/** Level readings. Never part of the state document, never patched — see contract §6. */
export interface AudioMeters {
  /** Strip id → 0..1, linear in **decibels** over a -60 dBFS floor. Not a fader level. */
  strips: Record<string, number>;
  /** Mix id → the same scale. Buses are pre-fader, `main` is post-fader. */
  mixes: Record<string, number>;
}

/** Things that happen and have no resting state. */
export type AudioEventName = 'mixerConnected' | 'mixerDisconnected' | 'metersUnavailable';

/** The commands the bridge accepts, with the arguments each one needs. */
export type AudioCommand =
  | { cmd: 'setSendLevel'; args: { stripId: string; mixId: string; level: number } }
  | { cmd: 'setSendMute'; args: { stripId: string; mixId: string; muted: boolean } }
  | { cmd: 'setStripMute'; args: { stripId: string; muted: boolean } }
  | { cmd: 'setMixLevel'; args: { mixId: string; level: number } }
  | { cmd: 'setMixMute'; args: { mixId: string; muted: boolean } }
  | { cmd: 'setMuteGroup'; args: { index: number; active: boolean } };

export type AudioCommandName = AudioCommand['cmd'];

/** Feeds a client may subscribe to. Meters are separate because they are a firehose. */
export type AudioFeed = 'mixes' | 'strips' | 'muteGroups' | 'meters';

// ─────────────────────────────────────────────────────────────────────────────
// Relay — the envelope musicians actually see
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Relay actions, all namespaced so they cannot collide with `musician_sync` or
 * `remote_command`. Everything a musician sends is a request to the operator; everything
 * the operator sends is addressed at one or more specific clients.
 */
export const AUDIO_ACTIONS = {
  /** client → operator: "is there a mixer, and what may I do with it?" */
  hello: 'audio_hello',
  /** operator → client: a {@link MixerAnnouncement}. */
  announce: 'audio_announce',
  /** client → operator: start (or renew) a subscription. Doubles as the keepalive. */
  subscribe: 'audio_subscribe',
  /** client → operator: stop; the mixer was closed. */
  unsubscribe: 'audio_unsubscribe',
  /** operator → client: the filtered state document. */
  snapshot: 'audio_snapshot',
  /** operator → subscribers: a partial document to merge over the last snapshot. */
  patch: 'audio_patch',
  /** operator → one subscriber: meters, trimmed to what that client can see. */
  meters: 'audio_meters',
  /** client → operator: a command to run against the desk. */
  cmd: 'audio_cmd',
  /** operator → client: the result of one command. */
  ack: 'audio_ack',
  /** operator → subscribers: a bridge event. */
  event: 'audio_event',
} as const;

/** Every action above, for the cheap "is this ours?" test on an incoming frame. */
export const AUDIO_ACTION_VALUES: string[] = Object.values(AUDIO_ACTIONS);

/**
 * How long a subscription survives without being renewed.
 *
 * A phone that goes into a tunnel, sleeps, or has its tab closed never says goodbye, and
 * the operator would otherwise keep the desk's meter feed alive for a listener that no
 * longer exists. Clients renew every {@link AUDIO_KEEPALIVE_MS}, so this is three misses.
 */
export const AUDIO_SUBSCRIBER_TTL_MS = 30_000;

/** How often a client with the mixer open renews its subscription. */
export const AUDIO_KEEPALIVE_MS = 10_000;

/**
 * What a musician is allowed to do. Enforced by the operator on every command, and used
 * by the mixer to leave out controls it would only be refused for.
 */
export interface MixerPermissions {
  /** The main mix may be selected at all — its sends are the front-of-house faders. */
  main: boolean;
  /** The main mix may be muted. Separate, because muting the main silences the room. */
  mainMute: boolean;
  /** A bus master (the wedge's own level) may be muted. */
  mixMute: boolean;
  /**
   * The global strip mutes may be offered. Still off by default on the device too — see
   * contract §4.2.1: whether that button is useful or a loaded gun depends on who is
   * holding the phone, so both the operator and the device have to say yes.
   */
  stripMutes: boolean;
  /** Mute groups may be toggled. Off by default: they affect everybody at once. */
  muteGroups: boolean;
  /** Meters may be requested. */
  meters: boolean;
}

/**
 * The operator's link to the bridge, as musicians see it.
 *
 * `offline` and `no-desk` are deliberately separate: "the presenter cannot reach the
 * mixer bridge" and "the bridge is there but no desk answered" send someone to look at
 * two different things, and collapsing them into "unavailable" wastes a service.
 */
export type MixerLink = 'connected' | 'no-desk' | 'connecting' | 'offline' | 'schema';

/** The operator's answer to `audio_hello`. */
export interface MixerAnnouncement {
  /** The operator has the feature switched on. When false nothing else is meaningful. */
  enabled: boolean;
  link: MixerLink;
  mixer?: MixerInfo;
  capabilities?: MixerCapabilities;
  permissions: MixerPermissions;
  /** How many mixes this musician may pick from, so the launcher can say so. */
  mixCount: number;
  /**
   * Bumped whenever the operator's configuration changes, so a client can tell a genuine
   * change from the periodic re-announcement and re-request its snapshot.
   */
  rev: number;
  /**
   * Which Presenter instance is speaking.
   *
   * An account can have more than one signed in — a spare machine, a second operator
   * station, a laptop somebody left open — and every one of them hears `audio_hello`.
   * Without a name on the answer a musician cannot tell "a different operator has no
   * mixer" from "the mixer just went away", which is exactly the confusion
   * {@link supersedesAnnouncement} exists to settle.
   *
   * Absent on operator builds that predate it — and absent is an identity of its own,
   * not a wildcard. "Some instance that cannot say who it is" is never the same instance
   * as one that can, which is what stops a Presenter that was left open through an update
   * from taking the desk away from the one that was updated.
   */
  from?: string;
}

/**
 * Whether an arriving announcement should replace the one a client is already showing.
 *
 * The rule is narrow on purpose: **an instance that offers no mixer may not take away a
 * mixer another instance is offering.** Two Presenters signed in to one account both
 * answer every `audio_hello`, and the one with monitor mixing switched off answers with
 * `enabled: false, link: 'offline'`. Applied blindly that overwrites the live desk
 * roughly 300 ms after the good answer arrives, and the musician is told the mixing desk
 * is not responding while it sits there responding perfectly.
 *
 * Everything else still replaces: the hosting instance may always update or retract its
 * own announcement, and a second instance that genuinely does offer a mixer is taken at
 * its word rather than being locked out by whoever spoke first — pinning a musician to
 * one operator would leave them stranded when that operator is the one that quits.
 */
export const supersedesAnnouncement = (current: MixerAnnouncement | null, incoming: MixerAnnouncement): boolean => {
  if (!current) return true;
  const offers = (a: MixerAnnouncement) => a.enabled && a.mixCount > 0;
  if (offers(incoming) || !offers(current)) return true;
  // A downgrade, so it counts only from whoever made the claim in the first place.
  // `undefined === undefined` is deliberate: on an all-old rig neither side can name
  // itself, there is nothing to tell apart, and the single operator must still be able to
  // retract. As soon as one side *can* name itself the other's silence distinguishes it.
  return current.from === incoming.from;
};

/** What a client tells the operator when subscribing, so meters can be trimmed to it. */
export interface MixerSubscription {
  /** The mix the musician is looking at. Meters for other mixes are not sent. */
  mixId?: string;
  /**
   * Strips the musician has chosen to see.
   *
   * Absent means no preference — all of them. An **empty list is not the same thing**: it
   * means the musician has hidden every channel, which is a legitimate thing to do on the
   * way to picking a few. Collapsing the two would meter all forty-eight for someone
   * looking at none.
   */
  stripIds?: string[];
  /** Whether this device wants meters at all. */
  meters: boolean;
}

/**
 * Every relay frame carries the sender's id, so the operator knows who to answer.
 *
 * It is the relay's own client id when the relay is new enough to hand one out, and a
 * locally generated one otherwise. Either way the operator only ever echoes it back in
 * `to`, and a client ignores anything not addressed to it — which is what makes the
 * whole thing work on a relay that does not understand `to` and broadcasts regardless.
 */
export interface AudioFrom {
  from: string;
}

/** No permission at all — what a client assumes until the operator says otherwise. */
export const NO_PERMISSIONS: MixerPermissions = {
  main: false,
  mainMute: false,
  mixMute: false,
  stripMutes: false,
  muteGroups: false,
  meters: false,
};

/**
 * Decide whether one command may run. `null` means yes; a string is the reason it may not.
 *
 * This is the whole point of the operator standing between a musician and the desk, so it
 * is a pure function rather than a branch buried in the socket handler: it is the rule,
 * it is testable without a desk or a browser, and there is exactly one copy of it.
 *
 * Two checks, and both matter. The permission check is what the operator's settings mean.
 * The existence check — is this mix still on the allow-list — is what stops a client that
 * has been open since before the operator changed their mind from moving a fader it can
 * no longer see.
 */
export const refuseCommand = (
  cmd: AudioCommandName,
  args: Record<string, unknown>,
  permissions: MixerPermissions,
  allowedMixIds: Set<string>,
): string | null => {
  const mixId = typeof args.mixId === 'string' ? args.mixId : undefined;

  // Every mix-addressed command is refused for a mix this musician was not given, which
  // covers the main as well: it is only ever in the set when `permissions.main` is on.
  if (mixId !== undefined && !allowedMixIds.has(mixId)) return `mix "${mixId}" is not available to you`;

  switch (cmd) {
    case 'setSendLevel':
    case 'setMixLevel':
      return null;
    case 'setSendMute':
      // The bridge refuses this on `main` on every desk, and so do we: a strip's
      // contribution to the main is its own fader, and its only mute is the global one.
      // Dressing that up as a per-mix control is the failure the contract's §5.3 exists
      // to prevent, so it is refused here even when the main is otherwise allowed.
      if (mixId === 'main') return 'the main mix has no per-send mute';
      return null;
    case 'setMixMute':
      if (mixId === 'main') return permissions.mainMute ? null : 'muting the main is not allowed';
      return permissions.mixMute ? null : 'muting a mix is not allowed';
    case 'setStripMute':
      return permissions.stripMutes ? null : 'muting a channel everywhere is not allowed';
    case 'setMuteGroup':
      return permissions.muteGroups ? null : 'mute groups are not allowed';
    default:
      return `unknown command "${cmd}"`;
  }
};

/**
 * Trim a meter frame to what one subscriber can actually see.
 *
 * Meters are 10 Hz, and an X32 reports 48 strips — about 7 KB/s of JSON per client if
 * forwarded whole, to phones on the venue's wifi. A musician looking at one wedge needs
 * their own mix and the handful of strips they have chosen, which is an order of
 * magnitude less. Called once per subscriber per frame, so it stays allocation-light.
 */
export const trimMeters = (meters: AudioMeters, sub: MixerSubscription, allowedMixIds: Set<string>): AudioMeters => {
  const strips: Record<string, number> = {};
  const wanted = sub.stripIds;
  if (wanted) {
    // An explicit list, empty included — see `stripIds`.
    for (const id of wanted) {
      const value = meters.strips[id];
      if (value !== undefined) strips[id] = value;
    }
  } else {
    Object.assign(strips, meters.strips);
  }

  // Only the mix being watched — the others are off-screen by construction.
  const mixes: Record<string, number> = {};
  const id = sub.mixId;
  if (id && allowedMixIds.has(id) && meters.mixes[id] !== undefined) mixes[id] = meters.mixes[id];

  return { strips, mixes };
};

/**
 * Merge a patch over a state document, one level deep per feed.
 *
 * Lists are replaced wholesale rather than diffed — that is the contract's own choice
 * (§4.4), and it is why this is four lines instead of a reconciliation.
 */
export const mergeAudioState = (base: AudioState, patch: AudioState): AudioState => ({
  mixes: patch.mixes ?? base.mixes,
  strips: patch.strips ?? base.strips,
  muteGroups: patch.muteGroups ?? base.muteGroups,
});

/**
 * Narrow a state document to what one musician may see.
 *
 * Applied by the operator before anything leaves the building, so a client that lies
 * about its permissions still never receives the mixes it is not allowed. Strips keep
 * only the sends for the surviving mixes, which also cuts a 48-strip X32 snapshot from
 * roughly 40 KB to a few.
 */
export const filterAudioState = (state: AudioState, allowedMixIds: Set<string>): AudioState => {
  const mixes = state.mixes ? { list: state.mixes.list.filter((mix) => allowedMixIds.has(mix.id)) } : undefined;
  const strips = state.strips
    ? {
        list: state.strips.list.map((strip) => {
          const sends: Record<string, ISend> = {};
          for (const [mixId, send] of Object.entries(strip.sends)) {
            if (allowedMixIds.has(mixId)) sends[mixId] = send;
          }
          return { ...strip, sends };
        }),
      }
    : undefined;

  return { mixes, strips, muteGroups: state.muteGroups };
};
