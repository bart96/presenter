/**
 * useWsSync — Browser WebSocket client for musician sync mode.
 *
 * Connects to a shared WebSocket relay server (e.g. wss://ws.example.com),
 * authenticates with the account number, receives `musician_sync` messages
 * and fires navigation callbacks.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SyncOrigin } from '@/utils/syncProtocol';

export type WsSyncStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'dropped_by_operator';

/** Close code the relay uses when the operator clears the connected clients. */
export const WS_CLOSE_OPERATOR_DISCONNECT = 4010;

/**
 * Self-description sent to the relay on auth. The relay mirrors it to the account's
 * other clients, which is how the operator footer can tell a musician following the
 * operator apart from one on MIDI, a mobile remote, or a text viewer.
 */
export interface WsClientInfo {
  role: 'operator' | 'musician' | 'remote' | 'viewer';
  /** Musicians: their current sync mode ('midi' | 'operator' | 'off'). */
  mode?: string;
  /** Shown in the operator's tooltip when set (musician name). */
  name?: string;
}

export interface WsSyncState extends SyncOrigin {
  /**
   * Identifies the client that produced this state. Musician pages tag their own
   * broadcasts with it so they can drop the relay's echo — a musician in MIDI mode
   * holds two sockets (this one to receive, a `useWsOperator` one to send) and the
   * relay only excludes the *sending* socket, not the other socket of the same page.
   */
  clientId?: string;
  /**
   * True when this state is the relay's CACHE of the last broadcast, sent once on auth —
   * not a peer actively talking. Useful as a starting position (operator sync mode), but
   * it must never drive navigation of a client that is itself the navigation master.
   */
  replay?: boolean;
  activeItemIndex: number;
  activeBlockIndex: number;
  activeLineIndex: number;
  isBlack: boolean;
  songNumber?: number;
  songTitle?: string;
  showTitle?: string;
  orderName?: string;
  contentType?: string;
  blockName?: string;
  blockLines?: Array<{ text: string; language?: string }>;
}

interface UseWsSyncOptions {
  url: string; // e.g. "wss://ws.example.com"
  account: number | null;
  enabled: boolean;
  onStateUpdate?: (state: WsSyncState) => void;
  /**
   * A peer asked for the current position. Only the client that is actually driving
   * navigation should answer — see `MusicianPage`, where the MIDI master does.
   */
  onGetState?: () => void;
  /** Who this client is — relayed to the operator for the connected-clients breakdown. */
  clientInfo?: WsClientInfo;
  /**
   * Frames this hook has no opinion about, handed on verbatim.
   *
   * The audio mixer rides this socket rather than opening a second one: the relay counts
   * every connection as a peer, and a musician showing up twice in the operator's client
   * list because they opened the mixer would be its own bug report. `relayClientId` below
   * is the other half — it is how the operator knows who to answer.
   */
  onRelayMessage?: (msg: Record<string, unknown>) => void;
  /**
   * Ask the operator to re-broadcast its state on connect (default). Turn it off for a
   * client that is only present to be seen — it would make the operator broadcast for
   * state this client then throws away.
   */
  requestState?: boolean;
}

const RECONNECT_DELAY_MS = 3000;

export const useWsSync = ({
  url,
  account,
  enabled,
  onStateUpdate,
  onGetState,
  clientInfo,
  requestState = true,
  onRelayMessage,
}: UseWsSyncOptions) => {
  const [status, setStatus] = useState<WsSyncStatus>('disconnected');
  /**
   * The id the relay gave this socket, once it has. Peers address replies to it.
   *
   * Empty on a relay that predates addressed delivery, which is why callers fall back to
   * an id of their own rather than waiting for one — see `useMixerClient`.
   */
  const [relayClientId, setRelayClientId] = useState('');
  const onStateUpdateRef = useRef(onStateUpdate);
  onStateUpdateRef.current = onStateUpdate;
  const onGetStateRef = useRef(onGetState);
  onGetStateRef.current = onGetState;
  const onRelayMessageRef = useRef(onRelayMessage);
  onRelayMessageRef.current = onRelayMessage;
  const requestStateRef = useRef(requestState);
  requestStateRef.current = requestState;
  // Read inside the socket callbacks, so a descriptor change never re-opens the socket.
  const clientInfoRef = useRef(clientInfo);
  clientInfoRef.current = clientInfo;
  // The live socket, so callers can send on the connection this hook already owns instead
  // of opening a second one (which the relay would also count as an extra peer).
  const wsRef = useRef<WebSocket | null>(null);
  const authedRef = useRef(false);
  // Bumped by reconnect() to re-run the connect effect after the operator dropped us.
  const [reconnectNonce, setReconnectNonce] = useState(0);

  useEffect(() => {
    if (!enabled || !url || account == null) {
      setStatus('disconnected');
      return;
    }

    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        console.error('[WsSync] WebSocket constructor threw:', err);
        setStatus('error');
        return;
      }

      wsRef.current = ws;
      authedRef.current = false;
      setStatus('connecting');

      ws.onopen = () => {
        if (stopped) {
          ws.close();
          return;
        }
        setStatus('connecting');
        try {
          ws.send(JSON.stringify({ action: 'auth', account, client: clientInfoRef.current }));
        } catch (err) {
          console.warn('[WsSync] failed to send auth:', err);
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'auth_ok') {
            authedRef.current = true;
            setStatus('connected');
            setRelayClientId(typeof msg.clientId === 'string' ? msg.clientId : '');
            // Request current state from the operator
            if (requestStateRef.current) {
              try {
                ws.send(JSON.stringify({ action: 'get_state', id: 'init' }));
              } catch (err) {
                console.warn('[WsSync] failed to send get_state:', err);
              }
            }
            return;
          }
          if (msg.action === 'get_state') {
            onGetStateRef.current?.();
            return;
          }
          if (msg.action === 'musician_sync' && onStateUpdateRef.current) {
            // The relay marks its cached-state replay on the envelope, not the payload —
            // surface it to the handler so a navigation master can ignore stale caches.
            onStateUpdateRef.current({ ...(msg.data as WsSyncState), replay: !!msg.replay });
            return;
          }
          onRelayMessageRef.current?.(msg as Record<string, unknown>);
        } catch {
          // ignore malformed messages
        }
      };

      ws.onerror = (e) => {
        console.warn('[WsSync] WebSocket error', e);
        if (!stopped) setStatus('error');
      };

      ws.onclose = (event) => {
        if (stopped) return;
        authedRef.current = false;
        // The operator deliberately cleared the connected clients — reconnecting on a timer
        // would put us straight back and make the button useless. Wait for the user.
        if (event.code === WS_CLOSE_OPERATOR_DISCONNECT) {
          stopped = true;
          setStatus('dropped_by_operator');
          return;
        }
        setStatus('disconnected');
        setRelayClientId('');
        reconnectTimer = setTimeout(() => {
          if (!stopped) connect();
        }, RECONNECT_DELAY_MS);
      };
    };

    connect();

    return () => {
      stopped = true;
      authedRef.current = false;
      wsRef.current = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.close();
      }
      setStatus('disconnected');
    };
  }, [url, account, enabled, reconnectNonce]);

  // A client that starts following mid-session (musician leaving independent mode) keeps the
  // socket it already has, so the auth-time get_state never runs again — ask here instead,
  // otherwise it would sit on a stale position until the operator happens to broadcast.
  const wasRequestingStateRef = useRef(requestState);
  useEffect(() => {
    const wanted = requestState && !wasRequestingStateRef.current;
    wasRequestingStateRef.current = requestState;
    const ws = wsRef.current;
    if (!wanted || status !== 'connected' || !ws || ws.readyState !== WebSocket.OPEN || !authedRef.current) return;
    try {
      ws.send(JSON.stringify({ action: 'get_state', id: 'resync' }));
    } catch (err) {
      console.warn('[WsSync] failed to send get_state:', err);
    }
  }, [requestState, status]);

  // Tell the relay when our description changes (musician switching sync mode, renaming
  // themselves) so the operator's breakdown follows without dropping the connection.
  const clientInfoKey = clientInfo ? JSON.stringify(clientInfo) : '';
  useEffect(() => {
    const ws = wsRef.current;
    if (!clientInfoKey || status !== 'connected' || !ws || ws.readyState !== WebSocket.OPEN || !authedRef.current) return;
    try {
      ws.send(JSON.stringify({ action: 'client_info', client: JSON.parse(clientInfoKey) }));
    } catch {
      // a failed descriptor update is cosmetic — never surface it
    }
  }, [clientInfoKey, status]);

  /** Re-open after the operator dropped us (the only case that does not retry on its own). */
  const reconnect = useCallback(() => setReconnectNonce((n) => n + 1), []);

  /**
   * Relay a message to the account's other peers over this same connection.
   * Returns false when the socket is not connected/authenticated yet.
   */
  const broadcast = useCallback((action: string, data?: Record<string, unknown>, to?: string | string[]): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !authedRef.current) return false;
    // `to` names the peers that should receive this. A relay that does not understand it
    // simply broadcasts as before, so senders always set it and receivers always check it.
    ws.send(JSON.stringify({ type: 'broadcast', action, data, ...(to === undefined ? {} : { to }) }));
    return true;
  }, []);

  return { status, broadcast, reconnect, relayClientId };
};
