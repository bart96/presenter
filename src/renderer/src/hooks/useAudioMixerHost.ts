/**
 * useAudioMixerHost — the operator's half of monitor mixing.
 *
 * It owns the one websocket to Streamer's audio bridge and re-serves it to the account's
 * musicians over the WS relay. Musicians cannot open that socket themselves: they load
 * this app over https, and a browser refuses `ws://<lan-ip>` from an https page as mixed
 * content. So the operator, which is on the same LAN as the desk and not subject to that
 * rule, stands in the middle.
 *
 * Standing in the middle is also where the permissions live. A musician asking to mute
 * the main gets an `ok: false` here, not a screen that merely lacks the button — the
 * difference between a rule and a suggestion. Everything leaving this hook is filtered
 * to the mixes that musician is allowed before it is sent, so a client that lies about
 * its own permissions still never receives what it may not have.
 *
 * Runs inside `usePresentationSync`, which already owns the operator's relay socket. It
 * is a passenger on that connection rather than a second one — an operator appearing
 * twice in its own connected-clients list would be its own bug report.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAppDispatch } from '@/store';
import { useGetSettings } from '@/store/settingsSlice';
import { setAudioMixerStatus, type AudioMixerBus, type AudioMixerStatus } from '@/store/audioMixerSlice';
import {
  AUDIO_ACTIONS,
  AUDIO_SCHEMA,
  AUDIO_SUBSCRIBER_TTL_MS,
  bridgeDocument,
  filterAudioState,
  mergeAudioState,
  refuseCommand,
  trimMeters,
  type AudioCommandName,
  type AudioMeters,
  type AudioState,
  type MixerAnnouncement,
  type MixerCapabilities,
  type MixerInfo,
  type MixerLink,
  type MixerPermissions,
  type MixerSubscription,
} from '@/audio/protocol';

/** Backoff for the bridge socket, capped as the contract asks (§8). */
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30_000;

/** How often expired subscribers are swept. Cheap, and never on the meter path. */
const SWEEP_INTERVAL_MS = 5000;

interface Subscriber extends MixerSubscription {
  /** Last time this client renewed. Older than the TTL and it is dropped. */
  seenAt: number;
}

type SendRelay = (action: string, data?: Record<string, unknown>, to?: string | string[]) => void;

interface UseAudioMixerHostOptions {
  /** Sends on the operator's relay socket. Stable — see `usePresentationSync`. */
  send: SendRelay;
}

export const useAudioMixerHost = ({ send }: UseAudioMixerHostOptions) => {
  const dispatch = useAppDispatch();
  const { audioMixer } = useGetSettings();

  const wsRef = useRef<WebSocket | null>(null);
  /** The desk's full state, unfiltered. Never enters Redux — see `audioMixerSlice`. */
  const stateRef = useRef<AudioState>({});
  const helloRef = useRef<{ mixer?: MixerInfo; capabilities?: MixerCapabilities } | null>(null);
  const linkRef = useRef<MixerLink>('offline');
  const errorRef = useRef<string | undefined>(undefined);
  /** clientId → what that musician asked for. */
  const subscribersRef = useRef<Map<string, Subscriber>>(new Map());
  /** Which bridge feeds we currently hold, so meters are only asked for when wanted. */
  const metersOnRef = useRef(false);
  const sendRef = useRef(send);
  sendRef.current = send;

  /**
   * The operator's configuration, read inside socket callbacks.
   *
   * Behind a ref because a settings change must not tear the bridge socket down and put
   * every musician through a reconnect: flipping "musicians may mute their wedge" is not
   * a reason to drop the desk.
   */
  const configRef = useRef(audioMixer);
  configRef.current = audioMixer;

  /** Bumped on every configuration change, so clients can tell a change from a repeat. */
  const revRef = useRef(0);

  /**
   * What this instance calls itself on the relay.
   *
   * Only has to be unique within the account and stable for the life of the window, so it
   * is generated here rather than plumbed down from the relay socket — which reconnects,
   * and takes its id with it. See `MixerAnnouncement.from` for what a client does with it.
   */
  const hostIdRef = useRef('');
  if (!hostIdRef.current) {
    hostIdRef.current = `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Which mixes a musician may see. Derived from the operator's allow-list, then
   * intersected with what the desk actually publishes — a bus removed from the desk (or
   * a config carried over from a different venue) must not appear as an empty mix.
   */
  const allowedMixIds = useCallback((): Set<string> => {
    const config = configRef.current;
    const wanted = new Set<string>(config.buses);
    if (config.allowMain) wanted.add('main');
    const published = stateRef.current.mixes?.list;
    if (!published) return wanted;
    return new Set(published.filter((mix) => wanted.has(mix.id)).map((mix) => mix.id));
  }, []);

  const permissions = useCallback((): MixerPermissions => {
    const config = configRef.current;
    return {
      main: config.allowMain,
      mainMute: config.allowMain && config.allowMainMute,
      mixMute: config.allowMixMute,
      stripMutes: config.allowStripMutes,
      muteGroups: config.allowMuteGroups,
      meters: config.allowMeters,
    };
  }, []);

  // ── Status, mirrored into Redux for the settings panel ─────────────────────
  const publishStatus = useCallback(() => {
    const config = configRef.current;
    const mixes: AudioMixerBus[] = (stateRef.current.mixes?.list ?? []).map(({ id, name, kind }) => ({ id, name, kind }));
    const next: AudioMixerStatus = {
      enabled: config.enabled,
      link: config.enabled ? linkRef.current : 'offline',
      mixer: helloRef.current?.mixer,
      capabilities: helloRef.current?.capabilities,
      mixes,
      subscribers: subscribersRef.current.size,
      error: errorRef.current,
    };
    dispatch(setAudioMixerStatus(next));
  }, [dispatch]);

  /**
   * Send one frame to a client, saying which instance it came from.
   *
   * Every operator→client frame goes through here, not just the announcement. The
   * announcement is how a musician chooses a host, but a snapshot, a patch, an ack or a
   * meter frame from a *different* instance is just as capable of ruining the picture —
   * an operator with no desk answers a subscribe with an empty snapshot, and answers a
   * fader with "that mix is not available to you". Both were happening on a rig where one
   * Presenter had been left open through an update. The stamp is what lets the client
   * throw those away; see `useMixerBridge`.
   */
  const sendToClient = useCallback((action: string, data: Record<string, unknown>, to: string | string[]) => {
    sendRef.current(action, { ...data, from: hostIdRef.current }, to);
  }, []);

  // ── Announcement ───────────────────────────────────────────────────────────
  const announcement = useCallback((): MixerAnnouncement => {
    const config = configRef.current;
    const hello = helloRef.current;
    return {
      enabled: config.enabled,
      link: config.enabled ? linkRef.current : 'offline',
      mixer: hello?.mixer,
      capabilities: hello?.capabilities,
      permissions: permissions(),
      mixCount: allowedMixIds().size,
      rev: revRef.current,
      from: hostIdRef.current,
    };
  }, [allowedMixIds, permissions]);

  const announceTo = useCallback(
    (to: string | string[]) => {
      sendToClient(AUDIO_ACTIONS.announce, announcement() as unknown as Record<string, unknown>, to);
    },
    [announcement, sendToClient],
  );

  /** Everyone with the mixer open, for a state change they all need to hear about. */
  const subscriberIds = () => [...subscribersRef.current.keys()];

  const snapshotTo = useCallback(
    (to: string) => {
      const filtered = filterAudioState(stateRef.current, allowedMixIds());
      sendToClient(AUDIO_ACTIONS.snapshot, { state: filtered } as Record<string, unknown>, to);
    },
    [allowedMixIds, sendToClient],
  );

  // ── Command correlation ────────────────────────────────────────────────────
  /** Bridge command id → who asked, so the ack can be routed back to them. */
  const pendingAcksRef = useRef<Map<number, { clientId: string; clientCmdId: unknown }>>(new Map());
  const cmdSeqRef = useRef(0);

  /**
   * Ask the bridge for meters exactly when somebody wants them, and stop when nobody
   * does — Streamer stops renewing the desk's own meter subscription in turn, which is
   * what keeps an idle rig off the desk's uplink entirely.
   */
  const syncMeterFeed = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    let wanted = false;
    for (const sub of subscribersRef.current.values()) {
      if (sub.meters) {
        wanted = true;
        break;
      }
    }
    if (wanted === metersOnRef.current) return;
    metersOnRef.current = wanted;
    ws.send(
      JSON.stringify({
        v: 1,
        t: 'subscribe',
        feeds: wanted ? ['mixes', 'strips', 'muteGroups', 'meters'] : ['mixes', 'strips', 'muteGroups'],
        ...(configRef.current.secret ? { secret: configRef.current.secret } : {}),
      }),
    );
  }, []);

  // ── The bridge socket ──────────────────────────────────────────────────────
  //
  // Keyed on the connection details alone: everything else about the configuration is
  // read through `configRef` precisely so it does not restart the socket.
  const { enabled, host, port, secret } = audioMixer;

  useEffect(() => {
    if (!enabled || !host) {
      linkRef.current = 'offline';
      helloRef.current = null;
      stateRef.current = {};
      errorRef.current = undefined;
      publishStatus();
      return;
    }

    let stopped = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (stopped) return;
      let ws: WebSocket;
      const url = `ws://${host}:${port || 5003}/audio`;
      try {
        ws = new WebSocket(url);
      } catch {
        // A malformed host never becomes valid on its own, but retrying costs nothing and
        // means fixing the setting does not also need a restart.
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;
      linkRef.current = 'connecting';
      publishStatus();

      ws.onopen = () => {
        if (stopped) return ws.close();
        attempt = 0;
        // Meters are asked for separately, and only while somebody wants them (§6).
        metersOnRef.current = false;
        ws.send(
          JSON.stringify({
            v: 1,
            t: 'subscribe',
            feeds: ['mixes', 'strips', 'muteGroups'],
            ...(secret ? { secret } : {}),
          }),
        );
      };

      ws.onmessage = (event) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(event.data as string) as Record<string, unknown>;
        } catch {
          return;
        }
        handleBridgeFrame(msg);
      };

      ws.onerror = () => {
        // Reconnection is driven by onclose; a browser WebSocket error carries nothing
        // useful to report beyond "it did not work".
      };

      ws.onclose = (event) => {
        wsRef.current = null;
        if (stopped) return;
        // 4401 is the bridge refusing the shared secret. Retrying with the same wrong
        // secret forever would hide the one thing the operator needs to be told.
        if (event.code === 4401) {
          stopped = true;
          linkRef.current = 'offline';
          errorRef.current = 'secret';
          helloRef.current = null;
          publishStatus();
          sendToClient(AUDIO_ACTIONS.announce, announcement() as unknown as Record<string, unknown>, subscriberIds());
          return;
        }
        linkRef.current = 'offline';
        helloRef.current = null;
        stateRef.current = {};
        publishStatus();
        // The desk is gone as far as musicians are concerned — say so rather than leaving
        // them on a snapshot that quietly stops changing.
        const ids = subscriberIds();
        if (ids.length) {
          sendToClient(AUDIO_ACTIONS.event, { name: 'mixerDisconnected' }, ids);
          announceTo(ids);
        }
        scheduleReconnect();
      };
    };

    const scheduleReconnect = () => {
      if (stopped) return;
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** attempt++);
      reconnectTimer = setTimeout(connect, delay);
    };

    const handleBridgeFrame = (msg: Record<string, unknown>) => {
      switch (msg.t) {
        case 'hello': {
          // A schema we do not know must be refused rather than half-rendered: the state
          // document is the thing that changed, and guessing at it is how a musician ends
          // up moving a fader that is not the one on screen.
          if (typeof msg.schema === 'number' && msg.schema !== AUDIO_SCHEMA) {
            linkRef.current = 'schema';
            errorRef.current = `schema ${msg.schema}`;
            wsRef.current?.close();
            publishStatus();
            return;
          }
          errorRef.current = undefined;
          helloRef.current = {
            mixer: msg.mixer as MixerInfo | undefined,
            capabilities: msg.capabilities as MixerCapabilities | undefined,
          };
          const mixer = msg.mixer as MixerInfo | undefined;
          // `connected` only means Streamer has a UDP socket pointed somewhere; a
          // non-empty model is the proof a desk actually answered (contract §3.3).
          linkRef.current = !mixer?.connected ? 'offline' : mixer.model ? 'connected' : 'no-desk';
          publishStatus();
          announceTo(subscriberIds());
          return;
        }
        case 'snapshot': {
          stateRef.current = bridgeDocument(msg);
          publishStatus();
          for (const id of subscriberIds()) snapshotTo(id);
          return;
        }
        case 'patch': {
          const incoming = bridgeDocument(msg);
          stateRef.current = mergeAudioState(stateRef.current, incoming);
          publishStatus();
          const ids = subscriberIds();
          if (!ids.length) return;
          sendToClient(AUDIO_ACTIONS.patch, { state: filterAudioState(incoming, allowedMixIds()) } as Record<string, unknown>, ids);
          return;
        }
        case 'meters': {
          const meters: AudioMeters = {
            strips: (msg.strips ?? {}) as Record<string, number>,
            mixes: (msg.mixes ?? {}) as Record<string, number>,
          };
          const allowed = allowedMixIds();
          // One frame per subscriber, trimmed to what that phone is actually showing.
          // Forwarding all 48 strips to everyone is ~7 KB/s each over venue wifi.
          for (const [id, sub] of subscribersRef.current) {
            if (!sub.meters) continue;
            sendToClient(AUDIO_ACTIONS.meters, trimMeters(meters, sub, allowed) as unknown as Record<string, unknown>, id);
          }
          return;
        }
        case 'event': {
          const name = msg.name;
          if (name === 'mixerConnected' || name === 'mixerDisconnected') {
            const mixer = helloRef.current?.mixer;
            if (mixer) mixer.connected = name === 'mixerConnected';
            linkRef.current = name === 'mixerConnected' ? 'connected' : 'offline';
            publishStatus();
            announceTo(subscriberIds());
          }
          const ids = subscriberIds();
          if (ids.length) sendToClient(AUDIO_ACTIONS.event, { name }, ids);
          return;
        }
        case 'ack': {
          const pending = pendingAcksRef.current.get(Number(msg.id));
          if (!pending) return;
          pendingAcksRef.current.delete(Number(msg.id));
          sendToClient(AUDIO_ACTIONS.ack, { id: pending.clientCmdId, ok: !!msg.ok, error: msg.error }, pending.clientId);
          return;
        }
        default:
          // Unknown frame types are ignored rather than treated as errors, so either side
          // can add one without a flag day (contract §3).
          return;
      }
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onclose = null;
        ws.onmessage = null;
        ws.onopen = null;
        ws.close();
      }
      linkRef.current = 'offline';
      helloRef.current = null;
      stateRef.current = {};
    };
    // `secret` and the address are the only things that justify a reconnect; the rest of
    // the configuration is read through configRef on purpose.
  }, [enabled, host, port, secret, allowedMixIds, announcement, announceTo, publishStatus, snapshotTo, sendToClient]);

  /** Applies the shared rule (see `refuseCommand`) to this operator's current settings. */
  const refuse = useCallback(
    (cmd: AudioCommandName, args: Record<string, unknown>): string | null => refuseCommand(cmd, args, permissions(), allowedMixIds()),
    [allowedMixIds, permissions],
  );

  // ── Relay traffic from musicians ───────────────────────────────────────────
  const handleRelayMessage = useCallback(
    (msg: Record<string, unknown>) => {
      const action = msg.action;
      if (typeof action !== 'string' || !action.startsWith('audio_')) return;
      const data = (msg.data ?? {}) as Record<string, unknown>;
      const from = typeof data.from === 'string' ? data.from : '';
      if (!from) return;

      /**
       * An instance with monitor mixing switched off is not a mixer host, and answering
       * as though it were is actively harmful.
       *
       * An account can have several Presenters signed in — a spare machine, a second
       * operator station — and the relay hands `audio_hello` to all of them. Every one
       * used to reply, so a musician got the real desk's announcement and then, a few
       * hundred milliseconds later, `enabled: false, link: 'offline'` from an instance
       * that has the feature off, applied it as the newer truth, and was told the mixing
       * desk was not responding while it responded perfectly to the operator standing
       * next to it. Silence is the honest answer: this instance has nothing to host.
       *
       * Retraction is unaffected — switching the feature off announces to the subscribers
       * this instance already has, in the `permissionKey` effect below, so an open mixer
       * still closes the moment its own operator turns it off.
       */
      if (!configRef.current.enabled && action !== AUDIO_ACTIONS.unsubscribe) return;

      switch (action) {
        case AUDIO_ACTIONS.hello: {
          announceTo(from);
          return;
        }
        case AUDIO_ACTIONS.subscribe: {
          const known = subscribersRef.current.has(from);
          subscribersRef.current.set(from, {
            mixId: typeof data.mixId === 'string' ? data.mixId : undefined,
            stripIds: Array.isArray(data.stripIds) ? (data.stripIds as string[]) : undefined,
            meters: !!data.meters && configRef.current.allowMeters,
            seenAt: Date.now(),
          });
          syncMeterFeed();
          // A renewal is just a keepalive; a new subscriber needs the picture.
          if (!known) {
            announceTo(from);
            snapshotTo(from);
            publishStatus();
          }
          return;
        }
        case AUDIO_ACTIONS.unsubscribe: {
          if (subscribersRef.current.delete(from)) {
            syncMeterFeed();
            publishStatus();
          }
          return;
        }
        case AUDIO_ACTIONS.cmd: {
          const cmd = data.cmd as AudioCommandName;
          const args = (data.args ?? {}) as Record<string, unknown>;
          const clientCmdId = data.id;

          const reason = refuse(cmd, args);
          if (reason) {
            sendToClient(AUDIO_ACTIONS.ack, { id: clientCmdId, ok: false, error: reason }, from);
            return;
          }
          const ws = wsRef.current;
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            sendToClient(AUDIO_ACTIONS.ack, { id: clientCmdId, ok: false, error: 'mixer not connected' }, from);
            return;
          }
          const id = ++cmdSeqRef.current;
          pendingAcksRef.current.set(id, { clientId: from, clientCmdId });
          ws.send(JSON.stringify({ v: 1, t: 'cmd', id, cmd, args }));
          return;
        }
        default:
          return;
      }
    },
    [announceTo, publishStatus, refuse, snapshotTo, syncMeterFeed, sendToClient],
  );

  // ── Configuration changes reach musicians without them asking ──────────────
  //
  // Everything a musician may do is decided here, so a permission taken away has to
  // arrive at an open mixer straight away — waiting for the next reload would leave a
  // control on screen that is already being refused.
  const permissionKey = useMemo(
    () =>
      JSON.stringify([
        audioMixer.enabled,
        audioMixer.buses,
        audioMixer.allowMain,
        audioMixer.allowMainMute,
        audioMixer.allowMixMute,
        audioMixer.allowStripMutes,
        audioMixer.allowMuteGroups,
        audioMixer.allowMeters,
      ]),
    [audioMixer],
  );

  useEffect(() => {
    revRef.current += 1;
    publishStatus();
    const ids = subscriberIds();
    if (!ids.length) return;
    announceTo(ids);
    // The allow-list moved, so what each client is entitled to see moved with it.
    for (const id of ids) snapshotTo(id);
    syncMeterFeed();
  }, [permissionKey, announceTo, publishStatus, snapshotTo, syncMeterFeed]);

  // ── Sweep subscribers that stopped renewing ────────────────────────────────
  useEffect(() => {
    const timer = setInterval(() => {
      const cutoff = Date.now() - AUDIO_SUBSCRIBER_TTL_MS;
      let dropped = false;
      for (const [id, sub] of subscribersRef.current) {
        if (sub.seenAt < cutoff) {
          subscribersRef.current.delete(id);
          dropped = true;
        }
      }
      if (dropped) {
        syncMeterFeed();
        publishStatus();
      }
    }, SWEEP_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [publishStatus, syncMeterFeed]);

  return { handleRelayMessage };
};
