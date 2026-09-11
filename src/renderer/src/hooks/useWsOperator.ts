/**
 * useWsOperator — connects the operator (presenter) to the WebSocket relay
 * server and exposes a `broadcast` function to relay messages to all musician
 * clients that share the same account.
 *
 * The relay server expects every client to authenticate first:
 *   { action: "auth", account: <number> }
 * After that, any message sent by this client is forwarded to every other
 * client with the same account number.
 */
import { useEffect, useRef, useCallback, useState } from 'react';
import { WS_CLOSE_OPERATOR_DISCONNECT, type WsClientInfo } from './useWsSync';
import type { SyncOrigin } from '@/utils/syncProtocol';

const RECONNECT_DELAY_MS = 5000;

/**
 * What the relay reports about the OTHER clients of this account. Clients from before
 * the descriptor handshake (or a relay that predates it) arrive as role 'unknown' —
 * the count is still right, only the breakdown is missing.
 */
export interface WsPeerInfo {
  role: 'operator' | 'musician' | 'remote' | 'viewer' | 'unknown';
  mode?: string;
  name?: string;
}

/** Keep only the shape we understand; a relay may send anything. */
const parsePeers = (raw: unknown): WsPeerInfo[] | null => {
  if (!Array.isArray(raw)) return null;
  return raw.map((entry) => {
    const obj = (entry ?? {}) as Record<string, unknown>;
    const role = obj.role;
    return {
      role: role === 'operator' || role === 'musician' || role === 'remote' || role === 'viewer' ? role : ('unknown' as const),
      mode: typeof obj.mode === 'string' ? obj.mode : undefined,
      name: typeof obj.name === 'string' ? obj.name : undefined,
    };
  });
};

export interface WsOperatorIncomingSync extends SyncOrigin {
  activeItemIndex?: number;
  activeBlockIndex?: number;
  activeLineIndex?: number;
  songNumber?: number;
  songTitle?: string;
  orderName?: string;
  contentType?: string;
}

export const useWsOperator = (
  url: string,
  account: number | null,
  onMusicianSync?: (state: WsOperatorIncomingSync) => void,
  onGetState?: () => void,
  onRemoteCommand?: (data: Record<string, unknown>) => void,
  /**
   * Ask the account's peers for the current position on connect. Set while a MIDI musician
   * is the navigation master: this app then does not know where the show is, and publishing
   * its own start-up position would drag everyone back to it.
   */
  requestStateOnConnect = false,
  /**
   * Frames this hook has no opinion about, handed on verbatim — the audio mixer's requests
   * arrive here. It shares this socket rather than opening its own, so the operator does
   * not appear in its own connected-clients list twice.
   */
  onRelayMessage?: (msg: Record<string, unknown>) => void,
) => {
  const wsRef = useRef<WebSocket | null>(null);
  const authedRef = useRef(false);
  const [connected, setConnected] = useState(false);
  /** True after the operator cleared the connected clients — no auto-retry until asked. */
  const [droppedByOperator, setDroppedByOperator] = useState(false);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  /**
   * Relay's answer to a `disconnect_peers` request: how many peers it closed, and when.
   * Its absence is meaningful too — a relay that predates the feature never answers, so
   * the caller can tell "nothing to disconnect" from "the relay didn't understand me".
   */
  const [lastPeersDisconnected, setLastPeersDisconnected] = useState<{ count: number; at: number } | null>(null);
  const [connectedCount, setConnectedCount] = useState(0);
  /**
   * Breakdown of the connected peers. Empty while nothing is connected; the count and the
   * breakdown come from the same relay message, so they can never disagree.
   */
  const [peers, setPeers] = useState<WsPeerInfo[]>([]);
  const [lastMidiSyncAt, setLastMidiSyncAt] = useState<number>(0);
  const onMusicianSyncRef = useRef(onMusicianSync);
  onMusicianSyncRef.current = onMusicianSync;
  const onGetStateRef = useRef(onGetState);
  onGetStateRef.current = onGetState;
  const onRemoteCommandRef = useRef(onRemoteCommand);
  onRemoteCommandRef.current = onRemoteCommand;
  const onRelayMessageRef = useRef(onRelayMessage);
  onRelayMessageRef.current = onRelayMessage;
  const requestStateOnConnectRef = useRef(requestStateOnConnect);
  requestStateOnConnectRef.current = requestStateOnConnect;

  useEffect(() => {
    if (!url || account == null) {
      setConnected(false);
      setConnectedCount(0);
      setPeers([]);
      return;
    }

    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (stopped) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
        return;
      }

      wsRef.current = ws;
      authedRef.current = false;

      ws.onopen = () => {
        if (stopped) {
          ws.close();
          return;
        }
        const client: WsClientInfo = { role: 'operator' };
        ws.send(JSON.stringify({ action: 'auth', account, client }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as Record<string, unknown>;
          if (msg.type === 'auth_ok' || msg.type === 'peer_count') {
            if (msg.type === 'auth_ok') {
              authedRef.current = true;
              setConnected(true);
              // We are following a MIDI master — ask it where the show is rather than
              // assuming our own position is the truth.
              if (requestStateOnConnectRef.current) {
                try {
                  ws.send(JSON.stringify({ action: 'get_state', id: 'operator-init' }));
                } catch {
                  // a missed request just means we wait for the next musician broadcast
                }
              }
            }
            if (typeof msg.others === 'number') {
              setConnectedCount(msg.others);
            } else if (typeof msg.count === 'number') {
              // Backward compatibility: older relays send count including this client.
              setConnectedCount(Math.max(0, msg.count - 1));
            }
            // A relay that predates the breakdown sends no `peers` at all — leave the last
            // known list alone rather than replacing it with an empty one, so the tooltip
            // falls back to "kind unknown" instead of claiming there is nobody.
            const parsed = parsePeers(msg.peers);
            if (parsed) setPeers(parsed);
          } else if (msg.action === 'musician_sync' && msg.data) {
            // `replay` marks the relay's cached last state, sent to every client on auth.
            // It is not a musician telling us anything — following it would snap the
            // operator to a stale position every time this socket reconnects (and sockets
            // churn exactly when other devices are connecting).
            if (msg.replay) return;
            // Another OPERATOR's broadcast. The relay fans every broadcast out to all peers
            // of the account, so a second app instance — a laptop with the page still open,
            // a phone that never navigated away — arrives here looking exactly like a
            // musician driving the show. Following it dragged the live operator back to
            // that instance's stale item on every footswitch press and every musician
            // (re)connect. An operator is never navigation input for another operator.
            // Untagged senders predate the field and stay trusted.
            const data = msg.data as WsOperatorIncomingSync;
            if (data.senderRole === 'operator') return;
            // A musician is broadcasting their current position — record the timestamp
            setLastMidiSyncAt(Date.now());
            onMusicianSyncRef.current?.(data);
          } else if (msg.action === 'get_state') {
            // A new musician client is requesting the current state — re-broadcast immediately
            onGetStateRef.current?.();
          } else if (msg.type === 'peers_disconnected') {
            setLastPeersDisconnected({ count: typeof msg.count === 'number' ? msg.count : 0, at: Date.now() });
          } else if (msg.action === 'remote_command' && msg.data) {
            // A remote-control client (mobile control page) sent a navigation command
            onRemoteCommandRef.current?.(msg.data as Record<string, unknown>);
          } else {
            onRelayMessageRef.current?.(msg);
          }
        } catch {
          // ignore
        }
      };

      ws.onerror = () => {
        // reconnect is handled by onclose
      };

      ws.onclose = (event) => {
        if (stopped) return;
        authedRef.current = false;
        setConnected(false);
        setConnectedCount(0);
        setPeers([]);
        setLastMidiSyncAt(0);
        wsRef.current = null;
        // Cleared by the operator — retrying immediately would defeat the purpose.
        if (event.code === WS_CLOSE_OPERATOR_DISCONNECT) {
          stopped = true;
          setDroppedByOperator(true);
          return;
        }
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      };
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      authedRef.current = false;
      setConnected(false);
      setConnectedCount(0);
      setPeers([]);
      setLastMidiSyncAt(0);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [url, account, reconnectNonce]);

  const broadcast = useCallback((action: string, data?: Record<string, unknown>, to?: string | string[]) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !authedRef.current) return;
    // `to` limits delivery to the named peers. Relays that predate it broadcast as before,
    // and every receiver checks the field itself, so both worlds stay correct.
    ws.send(JSON.stringify({ type: 'broadcast', action, data, ...(to === undefined ? {} : { to }) }));
  }, []);

  /** Re-open after the operator dropped us — the one close that does not retry on its own. */
  const reconnect = useCallback(() => {
    setDroppedByOperator(false);
    setReconnectNonce((n) => n + 1);
  }, []);

  return { connected, connectedCount, peers, lastMidiSyncAt, broadcast, droppedByOperator, reconnect, lastPeersDisconnected };
};
