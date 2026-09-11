/**
 * Mobile remote-control page (/control → control.html).
 *
 * Deliberately DECOUPLED from the main application bundles: no Redux store, no MUI,
 * no i18n — just React + the WebSocket relay. This keeps the page a few kB so it
 * loads instantly on a phone on stage Wi-Fi.
 *
 * Flow:
 *   1. GET /rest/Session → authentication check + account number + WS host config.
 *   2. Connect to the WS relay, authenticate with the account number.
 *   3. Request the operator state (`get_state`) and render incoming `musician_sync`.
 *   4. Tiles broadcast `remote_command` messages which the operator applies
 *      (handled in usePresentationSync → handleRemoteCommand). The operator's
 *      broadcast includes `remoteCommands` — the list of allowed command ids —
 *      and tiles for anything not listed are hidden.
 *
 * Extras: screen wake lock (on by default), fullscreen toggle, and a blocking
 * full-page "reconnecting" overlay whenever the relay connection is down.
 */
import { StrictMode, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { mountRoot } from './mountRoot';

interface AgendaEntry {
  type: string;
  label: string;
}

interface SyncState {
  showTitle?: string;
  songTitle?: string;
  /** Display title of the active item (song title / media label / bible ref). */
  itemTitle?: string;
  blockName?: string;
  activeItemIndex?: number;
  activeBlockIndex?: number;
  isBlack?: boolean;
  isTextHidden?: boolean;
  videoVisible?: boolean;
  contentType?: string;
  mediaSubType?: string;
  /** All show items (label + type) — for the expandable agenda + set_item jumps. */
  agenda?: AgendaEntry[];
  /** Current song's block names — for the expandable order + set_block jumps. */
  blockNames?: string[];
  /** Allowed remote command ids, broadcast by the operator. Absent = all allowed. */
  remoteCommands?: string[];
}

interface WsHost {
  host?: string;
  port?: number;
  path?: string;
  wss?: boolean;
}

interface SessionResponse {
  isAuthenticated?: boolean;
  account?: number;
  settings?: { wsHost?: WsHost };
}

const RECONNECT_DELAY_MS = 4000;

/** How long a sent command waits for the operator's broadcast before the spinner gives up. */
const COMMAND_ACK_TIMEOUT_MS = 2500;
/** How long the acknowledgement ring stays on a control after the broadcast came back. */
const COMMAND_CONFIRM_MS = 700;

/** Relay close code meaning "the operator cleared the connected clients" — do not retry. */
const WS_CLOSE_OPERATOR_DISCONNECT = 4010;

// ── Minimal bilingual labels (page is decoupled from the app i18n bundles) ────
const de = typeof navigator !== 'undefined' && (navigator.language || '').toLowerCase().startsWith('de');
const T = {
  connecting: de ? 'Verbinde mit Presenter…' : 'Connecting to presenter…',
  reconnecting: de ? 'Verbindung zum Presenter wird wiederhergestellt…' : 'Reconnecting to presenter…',
  noWsHost: de ? 'Kein WebSocket-Server für dieses Konto konfiguriert.' : 'No WebSocket host configured for this account.',
  serverUnreachable: de ? 'Server nicht erreichbar.' : 'Could not reach the server.',
  retry: de ? 'Erneut versuchen' : 'Retry',
  droppedByOperator: de
    ? 'Die Verbindung wurde vom Presenter getrennt. Du kannst dich jederzeit wieder verbinden.'
    : 'The presenter disconnected this client. You can reconnect whenever you like.',
  reconnect: de ? 'Wieder verbinden' : 'Reconnect',
  prevBlock: de ? 'Block zurück' : 'Prev block',
  nextBlock: de ? 'Block vor' : 'Next block',
  prevItem: de ? 'Song zurück' : 'Prev song',
  nextItem: de ? 'Song vor' : 'Next song',
  text: de ? 'Text' : 'Text',
  background: de ? 'Hintergrund' : 'Background',
  videoPlayback: de ? 'Video Play/Pause' : 'Video play/pause',
  black: de ? 'Schwarz' : 'Black',
  noCommands: de ? 'Keine Befehle freigegeben.' : 'No commands allowed.',
  agenda: de ? 'Ablauf' : 'Agenda',
  order: de ? 'Reihenfolge' : 'Order',
  nowPlaying: de ? 'Nichts ausgewählt' : 'Nothing selected',
};

// ── Colors ────────────────────────────────────────────────────────────────────
// Mirrors the operator app's DARK theme (src/renderer/src/theme.ts) so the phone reads as
// the same product. The values are inlined on purpose: this page pulls in neither MUI nor
// the theme module. Keep them in sync by hand if the theme's palette changes.
const C = {
  bg: '#0F1214', // palette.background.default
  panel: '#161616', // palette.background.paper
  border: 'rgba(255,255,255,0.12)', // MUI dark divider
  text: '#FFFFFF', // palette.text.primary
  dim: 'rgba(255,255,255,0.7)', // MUI dark text.secondary
  // Primary red marks the current position — the active agenda item and the active block,
  // like the operator sidebar's selected row. On the tiles it is NOT a resting state: it
  // flashes only to acknowledge that a command reached the operator (see Tile below).
  accent: '#CF7079', // palette.primary.light — accent text/borders, legible on dark
  accentSolid: '#C44D58', // palette.primary.main — filled surfaces (white text on top)
  accentBg: 'rgba(196,77,88,0.16)', // primary-tinted surface, like MUI's "selected" state
  // Active-toggle tones follow the operator Footer: warning for hidden content, error for black.
  warn: '#ffa726', // MUI dark warning.main
  warnBg: 'rgba(255,167,38,0.16)',
  danger: '#f44336', // MUI dark error.main
  dangerBg: 'rgba(244,67,54,0.16)',
  ok: '#66bb6a', // MUI dark success.main
};

// ── Inline SVG icons (feather-style, stroke = currentColor) ───────────────────
const Icon = ({ children, size = 32 }: { children: ReactNode; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

const icons = {
  chevronLeft: (
    <Icon size={38}>
      <path d="M15 18l-6-6 6-6" />
    </Icon>
  ),
  chevronRight: (
    <Icon size={38}>
      <path d="M9 18l6-6-6-6" />
    </Icon>
  ),
  chevronDown: (
    <Icon size={20}>
      <path d="M6 9l6 6 6-6" />
    </Icon>
  ),
  skipBack: (
    <Icon>
      <path d="M19 20L9 12l10-8v16z" />
      <path d="M5 19V5" />
    </Icon>
  ),
  skipForward: (
    <Icon>
      <path d="M5 4l10 8-10 8V4z" />
      <path d="M19 5v14" />
    </Icon>
  ),
  text: (
    <Icon>
      <path d="M4 7V4h16v3" />
      <path d="M9 20h6" />
      <path d="M12 4v16" />
    </Icon>
  ),
  image: (
    <Icon>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </Icon>
  ),
  playPause: (
    <Icon>
      <path d="M4 5l8 7-8 7V5z" />
      <path d="M16 5v14" />
      <path d="M20 5v14" />
    </Icon>
  ),
  moon: (
    <Icon>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </Icon>
  ),
  expand: (
    <Icon size={20}>
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M16 3h3a2 2 0 0 1 2 2v3" />
      <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </Icon>
  ),
  shrink: (
    <Icon size={20}>
      <path d="M8 3v3a2 2 0 0 1-2 2H3" />
      <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
      <path d="M3 16h3a2 2 0 0 1 2 2v3" />
      <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
    </Icon>
  ),
  lock: (
    <Icon size={20}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </Icon>
  ),
  unlock: (
    <Icon size={20}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 7.9-.9" />
    </Icon>
  ),
};

// ── Tile button ───────────────────────────────────────────────────────────────
const Tile = ({
  icon,
  label,
  onClick,
  active,
  big,
  tone = 'warn',
  pending,
  confirmed,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  /** Highlighted state (e.g. text currently hidden, black active) */
  active?: boolean;
  /** Taller primary tile (block navigation) */
  big?: boolean;
  /** Which highlight the active state uses — matches the operator Footer's icon colors. */
  tone?: 'warn' | 'danger';
  /** Command sent, operator has not confirmed it yet — shows a spinner. */
  pending?: boolean;
  /** The operator's broadcast came back — brief red ring, then back to resting. */
  confirmed?: boolean;
}) => {
  const activeColor = tone === 'danger' ? C.danger : C.warn;
  const activeBg = tone === 'danger' ? C.dangerBg : C.warnBg;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        minHeight: big ? 118 : 92,
        border: `1px solid ${active ? activeColor : C.border}`,
        borderRadius: 16,
        background: active ? activeBg : C.panel,
        color: active ? activeColor : C.text,
        // The acknowledgement ring sits outside the border so it composes with any state.
        boxShadow: confirmed ? `0 0 0 2px ${C.accentSolid}` : 'none',
        transition: 'box-shadow 0.15s ease-out',
        fontSize: 14,
        fontWeight: 600,
        cursor: 'pointer',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'manipulation',
        padding: 10,
      }}
    >
      {/* While in flight the spinner takes the icon's place — same box, so nothing shifts. */}
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: big ? 38 : 32,
          height: big ? 38 : 32,
        }}
      >
        {pending ? <span className="ctl-spinner-md" /> : icon}
      </span>
      <span>{label}</span>
    </button>
  );
};

const HeaderButton = ({ icon, onClick, active }: { icon: ReactNode; onClick: () => void; active?: boolean }) => (
  <button
    type="button"
    onClick={onClick}
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 40,
      height: 40,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      background: active ? C.accentBg : C.panel,
      color: active ? C.accent : C.dim,
      cursor: 'pointer',
      WebkitTapHighlightColor: 'transparent',
      touchAction: 'manipulation',
      flexShrink: 0,
    }}
  >
    {icon}
  </button>
);

// ── Scrollable list panel (agenda items / song blocks) ───────────────────────
const PanelList = ({
  title,
  entries,
  activeIndex,
  onPick,
  pendingIndex,
}: {
  title: string;
  entries: { label: string; sub?: string }[];
  activeIndex: number;
  onPick: (index: number) => void;
  /** Row whose jump was sent but not yet confirmed by the operator — shows a spinner. */
  pendingIndex?: number | null;
}) => {
  // The order panel stays open while blocks advance (from here, the operator or another
  // remote), so follow the active row instead of leaving it scrolled out of sight.
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, entries.length]);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: C.panel,
        border: `1px solid ${C.border}`,
        borderRadius: 16,
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: '10px 16px', fontSize: 12, fontWeight: 700, color: C.dim, textTransform: 'uppercase', letterSpacing: 0.8 }}>
        {title}
      </div>
      <div style={{ overflowY: 'auto', flex: 1, WebkitOverflowScrolling: 'touch' }}>
        {entries.map((e, i) => {
          const active = i === activeIndex;
          return (
            <button
              key={i}
              type="button"
              ref={active ? activeRef : undefined}
              onClick={() => onPick(i)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                textAlign: 'left',
                border: 'none',
                borderTop: `1px solid ${C.border}`,
                background: active ? C.accentBg : 'transparent',
                color: active ? C.accent : C.text,
                fontSize: 16,
                fontWeight: active ? 700 : 500,
                padding: '14px 16px',
                cursor: 'pointer',
                WebkitTapHighlightColor: 'transparent',
                touchAction: 'manipulation',
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  width: 26,
                  fontSize: 13,
                  fontWeight: 700,
                  color: active ? C.accent : C.dim,
                }}
              >
                {i + 1}
              </span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.label}</span>
              {i === pendingIndex && <span className="ctl-spinner-sm" style={{ flexShrink: 0 }} />}
              {e.sub && <span style={{ flexShrink: 0, fontSize: 12, color: C.dim }}>{e.sub}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
};

const spinnerCss = `
@keyframes ctl-spin { to { transform: rotate(360deg); } }
.ctl-spinner {
  width: 44px; height: 44px; border-radius: 50%;
  border: 4px solid ${C.border}; border-top-color: ${C.accent};
  animation: ctl-spin 0.9s linear infinite;
}
.ctl-spinner-sm {
  display: block; width: 16px; height: 16px; border-radius: 50%;
  border: 2px solid ${C.border}; border-top-color: ${C.accent};
  animation: ctl-spin 0.7s linear infinite;
}
/* Stands in for a tile's icon while its command is in flight. */
.ctl-spinner-md {
  display: block; width: 26px; height: 26px; border-radius: 50%;
  border: 3px solid ${C.border}; border-top-color: ${C.accent};
  animation: ctl-spin 0.7s linear infinite;
}`;

const ControlApp = () => {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [connected, setConnected] = useState(false);
  const [sync, setSync] = useState<SyncState>({});
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [wakeLockActive, setWakeLockActive] = useState(false);
  // Which expandable panel (if any) is open in place of the tile grid.
  const [expanded, setExpanded] = useState<'none' | 'agenda' | 'order'>('none');
  // The allowed-command list actually used to filter the tiles. `undefined` = all
  // allowed (old operators / not yet narrowed). Applied via a small debounce below so
  // a transient wide→narrow blip never flashes a denied tile into view.
  const [appliedCommands, setAppliedCommands] = useState<string[] | undefined>(undefined);
  // Gate tile rendering until we have decided the allowed list (first sync or a grace
  // timeout) — otherwise the tiles would render all-allowed for a frame before filtering.
  const [commandsKnown, setCommandsKnown] = useState(false);
  const hasAppliedRef = useRef(false);
  const remoteCommandsRef = useRef<string[] | undefined>(undefined);
  remoteCommandsRef.current = sync.remoteCommands;

  /** Set when the operator cleared the clients: we stay down until the user taps Reconnect. */
  const [droppedByOperator, setDroppedByOperator] = useState(false);
  const reconnectRef = useRef<(() => void) | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const wakeLockWantedRef = useRef(true);

  // ── Command acknowledgement ─────────────────────────────────────────────────
  // A command is fire-and-forget over the relay, so the only proof it landed is the
  // operator's next musician_sync. Until that arrives the control shows a spinner
  // ("sent, not applied yet"), then flashes a red ring. A command the operator ignores
  // (next_block on the last block, a denied permission) never produces a broadcast, so
  // the spinner simply times out — no false "done".
  // Keys are the command id, or `set_block:<index>` / `set_item:<index>` for list jumps.
  const [pendingCmd, setPendingCmd] = useState<string | null>(null);
  const [confirmedCmd, setConfirmedCmd] = useState<string | null>(null);
  const pendingRef = useRef<string | null>(null);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markPending = useCallback((key: string) => {
    pendingRef.current = key;
    setPendingCmd(key);
    setConfirmedCmd(null);
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    pendingTimerRef.current = setTimeout(() => {
      if (pendingRef.current !== key) return;
      pendingRef.current = null;
      setPendingCmd(null);
    }, COMMAND_ACK_TIMEOUT_MS);
  }, []);

  /** Called on every incoming musician_sync — the operator moved, so our command landed. */
  const confirmPending = useCallback(() => {
    const key = pendingRef.current;
    if (!key) return;
    pendingRef.current = null;
    setPendingCmd(null);
    setConfirmedCmd(key);
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = setTimeout(() => setConfirmedCmd((c) => (c === key ? null : c)), COMMAND_CONFIRM_MS);
  }, []);

  useEffect(
    () => () => {
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    },
    [],
  );

  // ── WebSocket connection ────────────────────────────────────────────────────
  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    // Per-effect-run flag (NOT a ref): StrictMode's mount → cleanup → mount would leave a
    // ref stuck at `true`, so the remounted page never connects again in dev.
    let stopped = false;

    const connect = (url: string, account: number) => {
      if (stopped) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        reconnectTimer = setTimeout(() => connect(url, account), RECONNECT_DELAY_MS);
        return;
      }
      wsRef.current = ws;

      // `client` tells the relay what we are, so the operator's connected-clients chip can
      // list this phone as a remote control rather than an anonymous connection.
      ws.onopen = () => ws.send(JSON.stringify({ action: 'auth', account, client: { role: 'remote' } }));

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as Record<string, unknown>;
          if (msg.type === 'auth_ok') {
            setConnected(true);
            // Ask the operator to broadcast the current state immediately
            ws.send(JSON.stringify({ type: 'broadcast', action: 'get_state' }));
          } else if (msg.action === 'musician_sync' && msg.data) {
            const data = msg.data as SyncState;
            confirmPending();
            // Merge only the fields present — musician clients broadcast partial states
            setSync((prev) => {
              const next = { ...prev };
              for (const key of Object.keys(data) as (keyof SyncState)[]) {
                if (data[key] !== undefined) (next as Record<string, unknown>)[key] = data[key];
              }
              return next;
            });
          }
        } catch {
          /* ignore malformed messages */
        }
      };

      ws.onclose = (event) => {
        if (stopped) return;
        setConnected(false);
        wsRef.current = null;
        // Deliberately cleared by the operator — retrying on a timer would put us straight
        // back and make the operator's button pointless. Wait for the user instead.
        if (event.code === WS_CLOSE_OPERATOR_DISCONNECT) {
          setDroppedByOperator(true);
          return;
        }
        reconnectTimer = setTimeout(() => connect(url, account), RECONNECT_DELAY_MS);
      };
    };

    fetch('/rest/Session')
      .then((r) => r.json() as Promise<SessionResponse>)
      .then((session) => {
        if (!session?.isAuthenticated) {
          window.location.replace('/login?next=' + encodeURIComponent('/control'));
          return;
        }
        const account = session.account;
        const h = session.settings?.wsHost;
        if (typeof account !== 'number' || !h?.host || !h?.port) {
          setPhase('error');
          setErrorMsg(T.noWsHost);
          return;
        }
        const path = h.path && h.path !== '/' ? h.path : '';
        const url = `${h.wss ? 'wss' : 'ws'}://${h.host}:${h.port}${path}`;
        setPhase('ready');
        reconnectRef.current = () => {
          setDroppedByOperator(false);
          connect(url, account);
        };
        connect(url, account);
      })
      .catch(() => {
        setPhase('error');
        setErrorMsg(T.serverUnreachable);
      });

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
    // confirmPending is stable (useCallback with no deps) — listed so the handler is never stale.
  }, [confirmPending]);

  // Fallback: if a (pre-permissions) operator never sends a command list, reveal the
  // tiles anyway shortly after connecting (appliedCommands stays undefined = all allowed).
  useEffect(() => {
    if (!connected || commandsKnown) return;
    const t = setTimeout(() => setCommandsKnown(true), 1500);
    return () => clearTimeout(t);
  }, [connected, commandsKnown]);

  // Apply the operator's allowed-command list to the tile filter. The FIRST list applies
  // immediately (so the gate opens onto the correct set); later changes are debounced so a
  // transient wide→narrow blip (e.g. an intermediate/stale broadcast, or a second operator
  // with different settings) settles on the narrow set without ever flashing a denied tile.
  const remoteCommandsKey = sync.remoteCommands ? [...sync.remoteCommands].sort().join('|') : '';
  useEffect(() => {
    if (!remoteCommandsKey) return;
    if (!hasAppliedRef.current) {
      hasAppliedRef.current = true;
      setAppliedCommands(remoteCommandsRef.current);
      setCommandsKnown(true);
      return;
    }
    const t = setTimeout(() => setAppliedCommands(remoteCommandsRef.current), 350);
    return () => clearTimeout(t);
  }, [remoteCommandsKey]);

  // Collapse any open panel when the connection drops (stale agenda/order otherwise).
  useEffect(() => {
    if (!connected) setExpanded('none');
  }, [connected]);

  // ── Screen wake lock — on by default, reacquired when the tab becomes visible ──
  const requestWakeLock = useCallback(async () => {
    if (!('wakeLock' in navigator) || !wakeLockWantedRef.current) return;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => setWakeLockActive(false));
      wakeLockRef.current = sentinel;
      setWakeLockActive(true);
    } catch {
      setWakeLockActive(false);
    }
  }, []);

  useEffect(() => {
    void requestWakeLock();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void requestWakeLock();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      wakeLockRef.current?.release().catch(() => {});
    };
  }, [requestWakeLock]);

  const toggleWakeLock = useCallback(() => {
    if (wakeLockRef.current) {
      wakeLockWantedRef.current = false;
      void wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
      setWakeLockActive(false);
    } else {
      wakeLockWantedRef.current = true;
      void requestWakeLock();
    }
  }, [requestWakeLock]);

  // ── Fullscreen ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void document.documentElement.requestFullscreen().catch(() => {});
    }
  }, []);

  // ── Commands ────────────────────────────────────────────────────────────────
  const sendCommand = useCallback(
    (command: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'broadcast', action: 'remote_command', data: { command } }));
      markPending(command);
    },
    [markPending],
  );

  /** Filter by the debounced applied list; undefined (old operator) = everything allowed. */
  const allowed = useCallback((command: string) => !appliedCommands || appliedCommands.includes(command), [appliedCommands]);

  /** Row index awaiting acknowledgement in a list panel, from the `<command>:<index>` key. */
  const pendingIndexFor = (command: 'set_item' | 'set_block') => {
    if (!pendingCmd?.startsWith(`${command}:`)) return null;
    return Number(pendingCmd.slice(command.length + 1));
  };

  const isBlack = sync.isBlack === true;
  const isTextHidden = sync.isTextHidden === true;
  const videoHidden = sync.videoVisible === false;

  // Title shown in the now-playing card — prefer the operator-provided itemTitle
  // (correct for media/color/bible), fall back to songTitle for older operators.
  const displayTitle = sync.itemTitle || sync.songTitle || T.nowPlaying;

  const itemNavAllowed = allowed('next_item') || allowed('prev_item');
  const blockNavAllowed = allowed('next_block') || allowed('prev_block');
  const agenda = sync.agenda ?? [];
  const blockNames = sync.blockNames ?? [];
  // Tapping the title opens the agenda; tapping the block chip opens the order.
  const canExpandAgenda = itemNavAllowed && agenda.length > 0;
  const canExpandOrder = blockNavAllowed && sync.contentType === 'song' && blockNames.length > 1;

  // Collapse an open panel if its precondition is lost (e.g. active item becomes media).
  useEffect(() => {
    if ((expanded === 'agenda' && !canExpandAgenda) || (expanded === 'order' && !canExpandOrder)) {
      setExpanded('none');
    }
  }, [expanded, canExpandAgenda, canExpandOrder]);

  const pickItem = useCallback(
    (index: number) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'broadcast', action: 'remote_command', data: { command: 'set_item', index } }));
        markPending(`set_item:${index}`);
      }
      setExpanded('none');
    },
    [markPending],
  );
  // Deliberately does NOT collapse the panel: jumping around within a song usually means
  // several picks in a row, so the order list stays up until the chip is tapped again.
  const pickBlock = useCallback(
    (index: number) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'broadcast', action: 'remote_command', data: { command: 'set_block', index } }));
        markPending(`set_block:${index}`);
      }
    },
    [markPending],
  );

  const tiles: {
    id: string;
    icon: ReactNode;
    label: string;
    active?: boolean;
    big?: boolean;
    tone?: 'warn' | 'danger';
  }[] = [
    { id: 'prev_block', icon: icons.chevronLeft, label: T.prevBlock, big: true },
    { id: 'next_block', icon: icons.chevronRight, label: T.nextBlock, big: true },
    { id: 'prev_item', icon: icons.skipBack, label: T.prevItem },
    { id: 'next_item', icon: icons.skipForward, label: T.nextItem },
    { id: 'toggle_text', icon: icons.text, label: T.text, active: isTextHidden },
    { id: 'toggle_video', icon: icons.image, label: T.background, active: videoHidden },
    { id: 'toggle_video_playback', icon: icons.playPause, label: T.videoPlayback },
    { id: 'toggle_black', icon: icons.moon, label: T.black, active: isBlack, tone: 'danger' as const },
  ].filter((t) => allowed(t.id));

  const showOverlay = phase === 'loading' || phase === 'error' || (phase === 'ready' && !connected);

  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        background: C.bg,
        color: C.text,
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        padding:
          'calc(env(safe-area-inset-top, 0px) + 12px) calc(env(safe-area-inset-right, 0px) + 12px) calc(env(safe-area-inset-bottom, 0px) + 12px) calc(env(safe-area-inset-left, 0px) + 12px)',
        boxSizing: 'border-box',
        gap: 12,
      }}
    >
      <style>{spinnerCss}</style>

      {/* Header: connection dot, show title, wake lock + fullscreen */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: connected ? C.ok : C.danger,
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 14, color: C.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {sync.showTitle ?? ''}
        </span>
        {'wakeLock' in navigator && (
          <HeaderButton icon={wakeLockActive ? icons.lock : icons.unlock} onClick={toggleWakeLock} active={wakeLockActive} />
        )}
        <HeaderButton icon={isFullscreen ? icons.shrink : icons.expand} onClick={toggleFullscreen} active={isFullscreen} />
      </div>

      {/* Now playing — title toggles the agenda, block chip toggles the order */}
      <div
        style={{
          background: C.panel,
          border: `1px solid ${expanded !== 'none' ? C.accent : C.border}`,
          borderRadius: 16,
          padding: '10px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minHeight: 56,
          boxSizing: 'border-box',
        }}
      >
        <button
          type="button"
          disabled={!canExpandAgenda}
          onClick={() => setExpanded((e) => (e === 'agenda' ? 'none' : 'agenda'))}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            border: 'none',
            background: 'transparent',
            color: C.text,
            textAlign: 'left',
            padding: '4px 4px',
            cursor: canExpandAgenda ? 'pointer' : 'default',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          <span
            style={{
              fontSize: 19,
              fontWeight: 700,
              lineHeight: 1.25,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
              minWidth: 0,
            }}
          >
            {displayTitle}
          </span>
          {canExpandAgenda && (
            <span
              style={{
                flexShrink: 0,
                color: expanded === 'agenda' ? C.accent : C.dim,
                transform: expanded === 'agenda' ? 'rotate(180deg)' : 'none',
              }}
            >
              {icons.chevronDown}
            </span>
          )}
        </button>
        {sync.blockName && (
          <button
            type="button"
            disabled={!canExpandOrder}
            onClick={() => setExpanded((e) => (e === 'order' ? 'none' : 'order'))}
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: expanded === 'order' ? '#fff' : C.accent,
              background: expanded === 'order' ? C.accentSolid : C.accentBg,
              border: `1px solid ${C.accentSolid}`,
              borderRadius: 8,
              padding: '6px 10px',
              textTransform: 'uppercase',
              letterSpacing: 0.6,
              whiteSpace: 'nowrap',
              flexShrink: 0,
              cursor: canExpandOrder ? 'pointer' : 'default',
              WebkitTapHighlightColor: 'transparent',
              maxWidth: 140,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {sync.blockName}
          </button>
        )}
      </div>

      {/* Body: an expanded panel, or the tile grid */}
      {expanded === 'agenda' ? (
        <PanelList
          title={T.agenda}
          entries={agenda.map((a) => ({ label: a.label }))}
          activeIndex={sync.activeItemIndex ?? -1}
          onPick={pickItem}
          pendingIndex={pendingIndexFor('set_item')}
        />
      ) : expanded === 'order' ? (
        <PanelList
          title={T.order}
          entries={blockNames.map((n) => ({ label: n }))}
          activeIndex={sync.activeBlockIndex ?? -1}
          onPick={pickBlock}
          pendingIndex={pendingIndexFor('set_block')}
        />
      ) : !commandsKnown ? (
        <div style={{ flex: 1 }} />
      ) : tiles.length > 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, flex: 1, alignContent: 'start' }}>
          {tiles.map((t) => (
            <Tile
              key={t.id}
              icon={t.icon}
              label={t.label}
              active={t.active}
              big={t.big}
              tone={t.tone}
              pending={pendingCmd === t.id}
              confirmed={confirmedCmd === t.id}
              onClick={() => sendCommand(t.id)}
            />
          ))}
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.dim, fontSize: 15 }}>
          {T.noCommands}
        </div>
      )}

      {/* Blocking reconnect overlay — covers everything while disconnected */}
      {showOverlay && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 100,
            background: 'rgba(16,20,24,0.94)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 20,
            padding: 24,
            textAlign: 'center',
          }}
        >
          {phase !== 'error' && !droppedByOperator && <div className="ctl-spinner" />}
          <div style={{ fontSize: 17, fontWeight: 600, color: C.text }}>
            {droppedByOperator ? T.droppedByOperator : phase === 'error' ? errorMsg : phase === 'loading' ? T.connecting : T.reconnecting}
          </div>
          {(phase === 'error' || droppedByOperator) && (
            <button
              type="button"
              onClick={() => (droppedByOperator && reconnectRef.current ? reconnectRef.current() : window.location.reload())}
              style={{
                border: `1px solid ${C.accent}`,
                borderRadius: 12,
                background: C.accentBg,
                color: C.accent,
                fontSize: 16,
                fontWeight: 600,
                padding: '12px 28px',
                cursor: 'pointer',
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              {droppedByOperator ? T.reconnect : T.retry}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

mountRoot(
  <StrictMode>
    <ControlApp />
  </StrictMode>,
);
