import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  AppBar,
  Box,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Snackbar,
  Stack,
  Toolbar,
  Tooltip,
  Typography,
  Button,
} from '@mui/material';
import {
  Brightness1 as BlackIcon,
  Visibility as ShowIcon,
  Palette as StyleIcon,
  Window as WindowManagerIcon,
  TextFields as HideTextIcon,
  Timer as StageIcon,
  People as WsClientsIcon,
  Cable as MidiActiveIcon,
} from '@mui/icons-material';
import { useI18nContext } from '@/i18n/i18n-react';
import { useAppDispatch } from '@/store';
import { toggleBlack, toggleTextHidden, useGetPresentationSettings } from '@/store/presentationSlice';
import { toggleStageAllHidden } from '@/store/stageSlice';
import { StyleEditor } from '@/components/style/StyleEditor';
import { WindowManager } from '@/components/layout/WindowManager';
import { FooterWindows } from '@/components/layout/FooterWindows';
import { StagePanel } from '@/components/stage/StagePanel';
import { StageTransport } from '@/components/stage/StageTransport';
import { useStageStatus } from '@/hooks/useStageEngine';
import { useGetSettings } from '@/store/settingsSlice';
import { useGetMusicianSettings, useUpdateMusicianSetting } from '@/store/musicianSlice';

const ConnectedWebsocketClients = ({
  wsClientCount,
  connected,
  connectedLabel,
  disconnectedLabel,
  onDisconnectAll,
}: {
  wsClientCount: number;
  connected: boolean;
  /** Multi-line breakdown of what is connected (see Footer's `wsClientsTooltip`). */
  connectedLabel: ReactNode;
  disconnectedLabel: string;
  /** Provided when there is something to clear — makes the chip clickable. */
  onDisconnectAll?: () => void;
}) => (
  <Tooltip title={connected ? connectedLabel : disconnectedLabel}>
    <Chip
      icon={<WsClientsIcon sx={{ pl: '0.25rem' }} />}
      label={wsClientCount}
      size="small"
      color={connected && wsClientCount > 0 ? 'primary' : 'default'}
      variant="outlined"
      onClick={onDisconnectAll}
      sx={{ alignSelf: 'center', fontSize: '0.7rem', cursor: onDisconnectAll ? 'pointer' : 'default', opacity: connected ? 1 : 0.5 }}
    />
  </Tooltip>
);

const FooterActions = ({ onOpenStyleEditor, onOpenWindowManager }: { onOpenStyleEditor: () => void; onOpenWindowManager: () => void }) => {
  const { LL } = useI18nContext();
  return (
    <>
      <Tooltip title={LL.STYLE.EDITOR()}>
        <IconButton size="small" onClick={onOpenStyleEditor}>
          <StyleIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title={LL.HEADER.WINDOW_MANAGER()}>
        <IconButton size="small" onClick={onOpenWindowManager}>
          <WindowManagerIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </>
  );
};

/** A titled group of controls in the phone panel. */
const PanelSection = ({ title, children }: { title: string; children: ReactNode }) => (
  <Stack sx={{ gap: 1 }}>
    <Typography variant="overline" sx={{ color: 'text.secondary', lineHeight: 1.6 }}>
      {title}
    </Typography>
    {children}
  </Stack>
);

export type FooterProps = {
  /**
   * `bar` is the desktop strip along the bottom of the window. `panel` is the same controls as a
   * full-height page, which is how the phone layout reaches them — it has no room for the strip.
   */
  variant?: 'bar' | 'panel';
};

const Footer = ({ variant = 'bar' }: FooterProps) => {
  const { LL } = useI18nContext();
  const dispatch = useAppDispatch();

  // ── WS client count — from redux (kept in sync by usePresentationSync via useWsOperator)
  const {
    isBlack,
    isTextHidden,
    wsConnectedCount: wsClientCount,
    wsPeers,
    wsMidiSyncAt,
    wsOperatorConnected,
  } = useGetPresentationSettings();
  const { windowFooterVisible } = useGetSettings();
  const { midiTrackingMaster } = useGetMusicianSettings();
  const updateMusicianSetting = useUpdateMusicianSetting();

  // Clearing the connected clients is disruptive (every tablet/phone has to reconnect),
  // so it is confirmed rather than fired straight off the chip.
  const [disconnectConfirmOpen, setDisconnectConfirmOpen] = useState(false);
  const [disconnectResult, setDisconnectResult] = useState<{ severity: 'success' | 'warning'; text: string } | null>(null);
  const disconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The relay answers a disconnect request with the number of peers it closed. No answer
  // within a few seconds means the request was not understood — in practice a relay still
  // running a build from before this feature, which silently relays it as a normal message.
  useEffect(() => {
    const handler = (e: Event) => {
      if (disconnectTimeoutRef.current) {
        clearTimeout(disconnectTimeoutRef.current);
        disconnectTimeoutRef.current = null;
      }
      const count = (e as CustomEvent<{ count: number }>).detail?.count ?? 0;
      setDisconnectResult({ severity: 'success', text: LL.FOOTER.WS_DISCONNECT_DONE({ count }) });
    };
    window.addEventListener('presenter:ws-peers-disconnected', handler);
    return () => window.removeEventListener('presenter:ws-peers-disconnected', handler);
  }, [LL]);

  useEffect(() => () => clearTimeout(disconnectTimeoutRef.current ?? undefined), []);

  /**
   * Storage ran out. Worth interrupting for: the operator otherwise finds out only when a
   * setting or the open show has quietly forgotten itself after a restart. The two cases
   * differ in what to do about it — offline data was sacrificed and everything is saved
   * (informational), or nothing could be saved at all (needs action), so they are shown at
   * different severities and the second one stays up until dismissed.
   */
  const [storageWarning, setStorageWarning] = useState<{ severity: 'info' | 'error'; text: string } | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ freed: string[]; saved: boolean }>).detail;
      if (detail?.saved) {
        setStorageWarning({ severity: 'info', text: LL.FOOTER.STORAGE_FULL_FREED({ freed: (detail.freed ?? []).join(', ') }) });
      } else {
        setStorageWarning({ severity: 'error', text: LL.FOOTER.STORAGE_FULL_UNSAVED() });
      }
    };
    window.addEventListener('presenter:storage-full', handler);
    return () => window.removeEventListener('presenter:storage-full', handler);
  }, [LL]);

  const handleDisconnectAllClients = () => {
    setDisconnectConfirmOpen(false);
    setDisconnectResult(null);
    window.dispatchEvent(new Event('presenter:disconnect-ws-peers'));
    if (disconnectTimeoutRef.current) clearTimeout(disconnectTimeoutRef.current);
    disconnectTimeoutRef.current = setTimeout(() => {
      disconnectTimeoutRef.current = null;
      setDisconnectResult({ severity: 'warning', text: LL.FOOTER.WS_DISCONNECT_NO_REPLY() });
    }, 4000);
  };

  /**
   * Tooltip of the connected-clients chip: one line per kind of client, so a glance tells
   * whether the tablet that stopped following is on MIDI, independent, or simply gone.
   *
   * Clients that never described themselves (old musician/viewer builds) and the clients a
   * pre-breakdown relay only counts are folded into one "unidentified" line — the total
   * always adds up to the number on the chip, whatever the peers reported.
   */
  const wsClientsTooltip = useMemo(() => {
    if (wsClientCount <= 0) return LL.FOOTER.WS_CLIENTS_NONE();

    const musicians = wsPeers.filter((p) => p.role === 'musician');
    const byMode = (mode: string) =>
      musicians.filter((p) => (p.mode === 'midi' || p.mode === 'operator' || p.mode === 'off' ? p.mode : 'unknown') === mode);
    /**
     * Append the names, so "1 independent" also answers "which tablet?". Only when EVERY
     * member of the group is named — a partial list next to a count reads as if the count
     * were wrong, which is the opposite of helpful when hunting a missing client.
     */
    const withNames = (label: string, list: typeof wsPeers) => {
      const names = list.map((p) => p.name).filter((n): n is string => !!n);
      return names.length === list.length ? `${label} (${names.join(', ')})` : label;
    };
    const indent = (line: string) => `    ${line}`;

    const lines: string[] = [LL.FOOTER.WS_CLIENTS({ count: wsClientCount })];

    if (musicians.length > 0) {
      lines.push(LL.FOOTER.WS_CLIENTS_MUSICIANS({ count: musicians.length }));
      const modeLines: [string, (arg: { count: number }) => string][] = [
        ['midi', LL.FOOTER.WS_CLIENTS_MUSICIAN_MIDI],
        ['operator', LL.FOOTER.WS_CLIENTS_MUSICIAN_FOLLOWING],
        ['off', LL.FOOTER.WS_CLIENTS_MUSICIAN_INDEPENDENT],
        ['unknown', LL.FOOTER.WS_CLIENTS_MUSICIAN_UNKNOWN_MODE],
      ];
      for (const [mode, label] of modeLines) {
        const group = byMode(mode);
        if (group.length > 0) lines.push(indent(withNames(label({ count: group.length }), group)));
      }
    }

    const remotes = wsPeers.filter((p) => p.role === 'remote');
    if (remotes.length > 0) lines.push(LL.FOOTER.WS_CLIENTS_REMOTE({ count: remotes.length }));

    const viewers = wsPeers.filter((p) => p.role === 'viewer');
    if (viewers.length > 0) lines.push(LL.FOOTER.WS_CLIENTS_VIEWER({ count: viewers.length }));

    const operators = wsPeers.filter((p) => p.role === 'operator');
    if (operators.length > 0) lines.push(LL.FOOTER.WS_CLIENTS_OPERATOR({ count: operators.length }));

    // Peers of unknown role, plus any client the relay counted but did not describe.
    const unidentified = wsPeers.filter((p) => p.role === 'unknown').length + Math.max(0, wsClientCount - wsPeers.length);
    if (unidentified > 0) lines.push(LL.FOOTER.WS_CLIENTS_UNKNOWN({ count: unidentified }));

    // pre-wrap, not pre-line: the sub-lines are indented with plain spaces, which pre-line
    // would collapse away.
    return <Box sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{lines.join('\n')}</Box>;
  }, [LL, wsClientCount, wsPeers]);

  const MIDI_ACTIVE_TTL_MS = 10_000;
  const [midiSyncActive, setMidiSyncActive] = useState(false);
  useEffect(() => {
    if (!wsMidiSyncAt) return;
    setMidiSyncActive(true);
    const t = setTimeout(() => setMidiSyncActive(false), MIDI_ACTIVE_TTL_MS);
    return () => clearTimeout(t);
  }, [wsMidiSyncAt]);

  // The chip carries two independent facts and the click only changes one of them:
  //   `followingMidi`  — are we taking our position from the musician? (what the click toggles)
  //   `midiSyncActive` — is a musician broadcasting at all? (nothing to do with us)
  // Filling the chip for either one made "stop following" look like it had done nothing
  // while the musician kept playing, so the fill now tracks the toggle alone and the
  // musician's presence only lifts the dimming.
  const followingMidi = midiTrackingMaster === 'midi';
  const midiChipProps = {
    color: 'success' as const,
    variant: followingMidi ? ('filled' as const) : ('outlined' as const),
    tooltip: followingMidi ? LL.MIDI.FOLLOW_MIDI_ACTIVE() : LL.MIDI.SYNC_ACTIVE(),
    onClick: () => updateMusicianSetting('midiTrackingMaster', followingMidi ? 'operator' : 'midi'),
    sx: {
      alignSelf: 'center',
      fontSize: '0.7rem',
      cursor: 'pointer',
      opacity: followingMidi || midiSyncActive ? 1 : 0.25,
      transition: 'opacity 0.4s ease-in-out',
    },
  };

  // Which panel is open. The window rig itself — chips, quick actions, restore-on-start —
  // belongs to FooterWindows, and the stage engine's position to useStageEngine.
  const [styleEditorOpen, setStyleEditorOpen] = useState(false);
  const [stagePanelOpen, setStagePanelOpen] = useState(false);
  const [windowManager, setWindowManager] = useState<{ open: boolean; withNew?: boolean; selectId?: string }>({ open: false });

  const openWindowManager = useCallback((options?: { withNew?: boolean; selectId?: string }) => {
    setWindowManager({ open: true, ...options });
  }, []);

  const stage = useStageStatus();

  if (!windowFooterVisible) return null;

  const connectionChips = (
    <>
      <ConnectedWebsocketClients
        connected={wsOperatorConnected}
        wsClientCount={wsClientCount}
        connectedLabel={wsClientsTooltip}
        disconnectedLabel={LL.FOOTER.WS_NOT_CONNECTED()}
        onDisconnectAll={wsOperatorConnected && wsClientCount > 0 ? () => setDisconnectConfirmOpen(true) : undefined}
      />
      <Tooltip title={midiChipProps.tooltip}>
        <Chip
          icon={<MidiActiveIcon sx={{ pl: '0.25rem' }} />}
          label="MIDI"
          size="small"
          color={midiChipProps.color}
          variant={midiChipProps.variant}
          onClick={midiChipProps.onClick}
          sx={midiChipProps.sx}
        />
      </Tooltip>
    </>
  );

  return (
    <>
      <StyleEditor open={styleEditorOpen} onClose={() => setStyleEditorOpen(false)} />
      <StagePanel open={stagePanelOpen} onClose={() => setStagePanelOpen(false)} />
      <WindowManager
        open={windowManager.open}
        openWithNew={windowManager.withNew}
        selectWindowId={windowManager.selectId}
        onClose={() => setWindowManager({ open: false })}
      />
      {/* Disconnect all WebSocket clients */}
      <Dialog open={disconnectConfirmOpen} onClose={() => setDisconnectConfirmOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{LL.FOOTER.WS_DISCONNECT_ALL()}</DialogTitle>
        <DialogContent>
          <Typography variant="body2">{LL.FOOTER.WS_DISCONNECT_ALL_CONFIRM({ count: wsClientCount })}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDisconnectConfirmOpen(false)}>{LL.COMMON.CANCEL()}</Button>
          <Button variant="contained" color="warning" onClick={handleDisconnectAllClients}>
            {LL.FOOTER.WS_DISCONNECT_ALL()}
          </Button>
        </DialogActions>
      </Dialog>
      <Snackbar
        open={!!disconnectResult}
        autoHideDuration={disconnectResult?.severity === 'warning' ? 10000 : 4000}
        onClose={() => setDisconnectResult(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={disconnectResult?.severity ?? 'success'} onClose={() => setDisconnectResult(null)}>
          {disconnectResult?.text ?? ''}
        </Alert>
      </Snackbar>
      <Snackbar
        open={!!storageWarning}
        // Nothing could be saved: leave it up until acknowledged, since ignoring it costs
        // the operator their settings at the next restart.
        autoHideDuration={storageWarning?.severity === 'error' ? null : 8000}
        onClose={() => setStorageWarning(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={storageWarning?.severity ?? 'info'} onClose={() => setStorageWarning(null)}>
          {storageWarning?.text ?? ''}
        </Alert>
      </Snackbar>
      {/* Phone layout: the bar's contents as a page. Everything the toolbar packs into 40px of
          height gets a section, a label and a tap target here — on a phone there is no hover to
          reveal what an icon means, and the vertical room to say it outright is free. */}
      {variant === 'panel' ? (
        <Stack sx={{ height: '100%', overflowY: 'auto', p: 2, gap: 3 }}>
          <PanelSection title={LL.FOOTER.PANEL_WINDOWS()}>
            <FooterWindows variant="panel" onOpenWindowManager={openWindowManager} />
          </PanelSection>

          {stage.statuses.some((st) => st.layer.enabled && st.cue) && (
            <PanelSection title={LL.STAGE.PANEL_TITLE()}>
              <StageTransport statuses={stage.statuses} allHidden={stage.allHidden} onOpenPanel={() => setStagePanelOpen(true)} />
            </PanelSection>
          )}

          <PanelSection title={LL.FOOTER.PANEL_OUTPUT()}>
            <Button
              variant={isBlack ? 'contained' : 'outlined'}
              color={isBlack ? 'error' : 'inherit'}
              startIcon={isBlack ? <ShowIcon /> : <BlackIcon />}
              onClick={() => dispatch(toggleBlack())}
            >
              {isBlack ? LL.FOOTER.SHOW() : LL.FOOTER.BLACK()}
            </Button>
            <Button
              variant={isTextHidden ? 'contained' : 'outlined'}
              color={isTextHidden ? 'warning' : 'inherit'}
              startIcon={<HideTextIcon />}
              onClick={() => dispatch(toggleTextHidden())}
            >
              {isTextHidden ? LL.FOOTER.SHOW_TEXT() : LL.FOOTER.HIDE_TEXT()}
            </Button>
          </PanelSection>

          <PanelSection title={LL.FOOTER.PANEL_CONNECTIONS()}>
            <Stack direction="row" sx={{ gap: 0.5, flexWrap: 'wrap' }}>
              {connectionChips}
            </Stack>
          </PanelSection>

          <PanelSection title={LL.FOOTER.PANEL_TOOLS()}>
            <Button variant="outlined" color="inherit" startIcon={<StyleIcon />} onClick={() => setStyleEditorOpen(true)}>
              {LL.STYLE.EDITOR()}
            </Button>
            <Button variant="outlined" color="inherit" startIcon={<WindowManagerIcon />} onClick={() => openWindowManager()}>
              {LL.HEADER.WINDOW_MANAGER()}
            </Button>
          </PanelSection>
        </Stack>
      ) : (
        <AppBar
          position="static"
          color="default"
          elevation={2}
          sx={{
            top: 'auto',
            bottom: 0,
            borderTop: 1,
            borderColor: 'divider',
            bgcolor: 'background.paper',
          }}
        >
          <Toolbar variant="dense" sx={{ minHeight: 40, gap: 1 }}>
            <FooterWindows variant="bar" onOpenWindowManager={openWindowManager} />

            <Stack direction="row" sx={{ gap: 0.5, ml: 'auto', flexShrink: 0, alignItems: 'center' }}>
              {/* The stage transport sits next to the output controls, because during a
                  service the countdown is the other thing being watched. */}
              <StageTransport statuses={stage.statuses} allHidden={stage.allHidden} onOpenPanel={() => setStagePanelOpen(true)} />

              <Stack direction="row" sx={{ gap: 0.5, mx: 1 }}>
                {connectionChips}
              </Stack>

              {stage.anyLive && (
                <Tooltip title={stage.allHidden ? LL.STAGE.SHOW_ALL() : LL.STAGE.HIDE_ALL()}>
                  <IconButton size="small" onClick={() => dispatch(toggleStageAllHidden())} color={stage.allHidden ? 'warning' : 'default'}>
                    <StageIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}

              <Tooltip title={isTextHidden ? LL.FOOTER.SHOW_TEXT() : LL.FOOTER.HIDE_TEXT()}>
                <IconButton size="small" onClick={() => dispatch(toggleTextHidden())} color={isTextHidden ? 'warning' : 'default'}>
                  <HideTextIcon fontSize="small" />
                </IconButton>
              </Tooltip>

              <Tooltip title={isBlack ? LL.FOOTER.SHOW() : LL.FOOTER.BLACK()}>
                <IconButton size="small" onClick={() => dispatch(toggleBlack())} color={isBlack ? 'error' : 'default'}>
                  {isBlack ? <ShowIcon fontSize="small" /> : <BlackIcon fontSize="small" />}
                </IconButton>
              </Tooltip>
              <FooterActions onOpenStyleEditor={() => setStyleEditorOpen(true)} onOpenWindowManager={() => openWindowManager()} />
            </Stack>
          </Toolbar>
        </AppBar>
      )}
    </>
  );
};

export default Footer;
