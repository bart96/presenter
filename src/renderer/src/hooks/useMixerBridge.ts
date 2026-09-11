/**
 * useMixerBridge — the musician's end of the audio-mixer link, minus the mixer.
 *
 * Deliberately small, because this part is *not* lazily loaded: it lives on the musician
 * page so the toolbar can know whether to offer the mixer at all, and every byte of it is
 * paid for by musicians who never open one. Everything expensive — the fader UI, the
 * state document, the meters — is in the `@/mixer` chunk, which is only fetched when the
 * button is pressed.
 *
 * The split is also why frames are handed out through a subscription rather than React
 * state. Meters arrive ten times a second; putting them in page state would re-render the
 * PDF viewer behind the mixer at 10 Hz to animate a bar. The page holds only the
 * announcement, which changes when the operator changes a setting and otherwise never.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AUDIO_ACTIONS, supersedesAnnouncement, type MixerAnnouncement } from '@/audio/protocol';

/** How long to wait before asking again when the operator has not answered. */
const HELLO_RETRY_MS = 15_000;

export type MixerFrameHandler = (action: string, data: Record<string, unknown>) => void;

export interface MixerBridge {
  /** How this client is addressed. See `AudioFrom` for why it may be locally generated. */
  clientId: string;
  /** True while the relay socket is up; a mixer on a dead socket can only mislead. */
  connected: boolean;
  /** Send one frame to the operator, with `from` filled in. */
  send: (action: string, data?: Record<string, unknown>) => void;
  /** Receive the operator's frames. Returns its own unsubscribe. */
  subscribe: (handler: MixerFrameHandler) => () => void;
}

interface UseMixerBridgeOptions {
  /** `broadcast` from the page's `useWsSync` — the socket is shared, not duplicated. */
  send: (action: string, data?: Record<string, unknown>, to?: string | string[]) => boolean;
  /** The relay's id for this socket; empty on a relay that predates addressed delivery. */
  relayClientId: string;
  connected: boolean;
}

export const useMixerBridge = ({ send, relayClientId, connected }: UseMixerBridgeOptions) => {
  const [announcement, setAnnouncement] = useState<MixerAnnouncement | null>(null);
  /** Read inside the relay callbacks, which must see the current one, not a captured one. */
  const announcementRef = useRef<MixerAnnouncement | null>(null);
  announcementRef.current = announcement;

  /**
   * The instance whose announcement we accepted — the one operator this client listens to.
   *
   * Empty while the host is an operator too old to stamp its frames, which switches the
   * filtering below off and restores the previous free-for-all. That is the honest
   * fallback: with nothing to tell two operators apart there is no filtering to do.
   */
  const hostIdRef = useRef('');

  /**
   * A stable fallback id for relays that do not hand one out.
   *
   * Such a relay also ignores `to` and broadcasts the operator's replies to everyone, so
   * the id is what lets this client recognise its own answers in the crowd. It only has
   * to be unique within the account, not globally.
   */
  const localIdRef = useRef<string>('');
  if (!localIdRef.current) {
    localIdRef.current = `mx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
  const clientId = relayClientId || localIdRef.current;

  const sendRef = useRef(send);
  sendRef.current = send;
  const clientIdRef = useRef(clientId);
  clientIdRef.current = clientId;

  const handlersRef = useRef(new Set<MixerFrameHandler>());

  const sendFrame = useCallback((action: string, data?: Record<string, unknown>) => {
    sendRef.current(action, { ...data, from: clientIdRef.current });
  }, []);

  const subscribe = useCallback((handler: MixerFrameHandler) => {
    handlersRef.current.add(handler);
    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  /**
   * Sort an incoming relay frame.
   *
   * The `to` check is not belt and braces: an older relay broadcasts the operator's reply
   * to every peer of the account, so without it two musicians would each apply the
   * other's snapshot — including the mixes they are not allowed to see.
   */
  const handleRelayMessage = useCallback((msg: Record<string, unknown>) => {
    const action = msg.action;
    if (typeof action !== 'string' || !action.startsWith('audio_')) return;

    const to = msg.to;
    const me = clientIdRef.current;
    if (typeof to === 'string' && to !== me) return;
    if (Array.isArray(to) && !to.includes(me)) return;

    const data = (msg.data ?? {}) as Record<string, unknown>;
    const source = typeof data.from === 'string' ? data.from : '';

    if (action === AUDIO_ACTIONS.announce) {
      // Not every announcement is an update. Several Presenters can be signed in to one
      // account and all of them hear the `hello`, so an answer saying there is no mixer
      // is only believed from the instance that offered one — see `supersedesAnnouncement`.
      const incoming = data as unknown as MixerAnnouncement;
      if (!supersedesAnnouncement(announcementRef.current, incoming)) return;
      hostIdRef.current = source;
      setAnnouncement(incoming);
      return;
    }

    /**
     * Everything past this point is the mixer itself talking, and only the instance we
     * took the announcement from is entitled to.
     *
     * Choosing a host is not enough on its own, because a musician's `subscribe` and
     * `cmd` are broadcast — they have no way of addressing one operator — so every
     * Presenter on the account answers them. One left open through an update, with the
     * feature off and no desk behind it, replied to a subscribe with an *empty* snapshot
     * and to a fader with "that mix is not available to you". The empty snapshot arriving
     * a moment after the real one is what made picking a channel flicker the whole mixer
     * blank, and the refusal is what made a fader that plainly worked report an error.
     */
    if (hostIdRef.current && source !== hostIdRef.current) return;

    for (const handler of handlersRef.current) handler(action, data);
  }, []);

  // ── Ask, and keep asking until answered ───────────────────────────────────
  //
  // The operator may be starting up, mid-reconnect, or simply not running yet. A single
  // question on connect would leave the mixer permanently absent for a musician who
  // opened the page first, which on a Sunday morning is most of them.
  useEffect(() => {
    if (!connected) {
      setAnnouncement(null);
      // The host is chosen afresh on the way back up: the operator we were listening to
      // may not be the one still there, and holding its id would silence the one that is.
      hostIdRef.current = '';
      return;
    }
    sendFrame(AUDIO_ACTIONS.hello);
    const timer = setInterval(() => {
      if (!announcementRef.current) sendFrame(AUDIO_ACTIONS.hello);
    }, HELLO_RETRY_MS);
    return () => clearInterval(timer);
  }, [connected, sendFrame]);

  const bridge = useMemo<MixerBridge>(
    () => ({ clientId, connected, send: sendFrame, subscribe }),
    [clientId, connected, sendFrame, subscribe],
  );

  /**
   * Whether the toolbar should offer the mixer at all.
   *
   * Being switched on is enough — a desk that is momentarily unreachable still gets a
   * button, because the mixer's own screen explains what is wrong far better than a
   * button that silently is not there. What must be hidden is a rig with no mixer
   * configured, and an account whose operator has given this musician nothing to look at.
   */
  const available = !!announcement?.enabled && announcement.mixCount > 0;

  return { bridge, announcement, available, handleRelayMessage };
};
