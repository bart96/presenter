/**
 * The Window Manager: a desk, a list, and an inspector.
 *
 * The desk (the screen arrangement with the windows drawn on it) is the primary view,
 * because "which beamer is showing what" is the question this panel exists to answer, and
 * it used to be buried inside the edit form. The list underneath is one row per configured
 * window — open or not — and selecting a row opens the inspector beside it, so the list
 * stays visible instead of being pushed off screen by an inline form.
 *
 * All three read from `usePresentationWindows`, which does the config × bridge × main-process
 * merge once. This component holds no window state of its own beyond what is selected.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  Drawer,
  IconButton,
  Stack,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  Brightness1 as BlackIcon,
  Close as CloseIcon,
  Fingerprint as IdentifyIcon,
  PlayArrow as OpenAllIcon,
  Visibility as ShowIcon,
} from '@mui/icons-material';
import { useI18nContext } from '@/i18n/i18n-react';
import { useAppDispatch } from '@/store';
import { toggleBlack, toggleFreezeWindow, toggleIdentify, useGetPresentationSettings } from '@/store/presentationSlice';
import type { WindowConfig } from '@/store/windowSlice';
import { useGetStylesQuery } from '@/api/styles.api';
import { useGetStageLayersQuery } from '@/api/stage.api';
import { useMetrics } from '@/hooks/useMetrics';
import { usePresentationWindows } from '@/hooks/usePresentationWindows';
import { hideIdentify, identifyWindows } from '@/utils/presentationBridge';
import type { ScreenInfo } from './ScreenPicker';
import { WindowDesk } from './WindowDesk';
import { WindowInspector } from './WindowInspector';
import { WindowRow } from './WindowRow';

interface WindowManagerProps {
  open: boolean;
  onClose: () => void;
  openWithNew?: boolean;
  /** Open with this window already selected — the footer's "All settings…" lands here. */
  selectWindowId?: string;
}

/** A sensible new window: 1080p on the primary screen unless a screen says otherwise. */
const draftConfig = (screen?: ScreenInfo, name = 'Presentation'): WindowConfig => ({
  name,
  displayMode: 'normal',
  frameless: true,
  fullscreen: false,
  alwaysOnTop: false,
  hideMouse: false,
  transparent: false,
  width: screen?.bounds.width ?? 1920,
  height: screen?.bounds.height ?? 1080,
  positionX: screen?.bounds.x ?? 0,
  positionY: screen?.bounds.y ?? 0,
});

export const WindowManager = ({ open, onClose, openWithNew, selectWindowId }: WindowManagerProps) => {
  const { LL } = useI18nContext();
  const dispatch = useAppDispatch();
  const { trackEvent } = useMetrics();
  const { isBlack, isIdentifying } = useGetPresentationSettings();

  const { data: styles = [] } = useGetStylesQuery();
  const { data: stageLayers = [] } = useGetStageLayersQuery();
  const rig = usePresentationWindows();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Non-null while creating: the config being filled in, not yet a window. */
  const [draft, setDraft] = useState<WindowConfig | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const startDraft = useCallback(
    (screen?: ScreenInfo) => {
      const existing = rig.windows.length;
      setDraft(draftConfig(screen, existing === 0 ? 'Presentation' : `Presentation ${existing + 1}`));
      setSelectedId(null);
    },
    [rig.windows.length],
  );

  useEffect(() => {
    if (!open) return;
    if (openWithNew) startDraft(rig.screens.find((s) => s.isPrimary) ?? rig.screens[0]);
    else if (selectWindowId) setSelectedId(selectWindowId);
    // Only when the drawer opens — re-running on every screen poll would reset the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, openWithNew, selectWindowId]);

  const selected = useMemo(() => rig.windows.find((w) => w.id === selectedId), [rig.windows, selectedId]);
  // The row a selection points at can disappear (deleted elsewhere, or an unmanaged window
  // that closed); fall back to the draft rather than showing an empty inspector.
  useEffect(() => {
    if (selectedId && !selected && !draft) setSelectedId(null);
  }, [selectedId, selected, draft]);

  const deskWindows = useMemo(() => rig.windows.map((w) => ({ id: w.id, name: w.name, bounds: w.bounds })), [rig.windows]);

  const handleCreate = useCallback(async () => {
    if (!draft) return;
    const id = await rig.create(draft);
    const screen = rig.screens.find(
      (s) => draft.positionX !== undefined && draft.positionX >= s.bounds.x && draft.positionX < s.bounds.x + s.bounds.width,
    );
    trackEvent('window_opened', 'window', id, {
      name: draft.name,
      displayMode: draft.displayMode,
      width: draft.width,
      height: draft.height,
      left: draft.positionX,
      top: draft.positionY,
      screen: screen?.label,
      fullscreen: draft.fullscreen,
      frameless: draft.frameless,
      transparent: draft.transparent,
      alwaysOnTop: draft.alwaysOnTop,
      styleId: draft.styleId,
    });
    setDraft(null);
    setSelectedId(id);
  }, [draft, rig, trackEvent]);

  /** Drop a window onto a screen: fill that screen, and apply it live if it is open. */
  const handleAssign = useCallback(
    (windowId: string, screen: ScreenInfo) => {
      void rig.update(windowId, {
        positionX: screen.bounds.x,
        positionY: screen.bounds.y,
        width: screen.bounds.width,
        height: screen.bounds.height,
      });
      setSelectedId(windowId);
    },
    [rig],
  );

  const pendingDeleteWindow = rig.windows.find((w) => w.id === pendingDelete);

  return (
    <Drawer open={open} anchor="right" onClose={onClose}>
      <Stack sx={{ width: 'min(96vw, 900px)', height: '100%' }}>
        {/* Header */}
        <Stack direction="row" sx={{ alignItems: 'center', p: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>
            {LL.WINDOW.PANEL_TITLE()}
          </Typography>
          <Box sx={{ flexGrow: 1 }} />
          <IconButton onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </Stack>

        {/* Global actions */}
        <Stack direction="row" spacing={1} sx={{ p: 1.5, pb: 1, flexWrap: 'wrap', gap: 1 }}>
          <Button
            size="small"
            variant={isBlack ? 'contained' : 'outlined'}
            color={isBlack ? 'error' : 'primary'}
            startIcon={isBlack ? <ShowIcon /> : <BlackIcon />}
            onClick={() => dispatch(toggleBlack())}
          >
            {isBlack ? LL.FOOTER.SHOW() : LL.FOOTER.BLACK()}
          </Button>
          <Button
            size="small"
            variant={isIdentifying ? 'contained' : 'outlined'}
            color={isIdentifying ? 'error' : 'primary'}
            startIcon={<IdentifyIcon />}
            onClick={() => {
              if (isIdentifying) hideIdentify();
              else identifyWindows();
              dispatch(toggleIdentify());
            }}
          >
            {LL.FOOTER.IDENTIFY()}
          </Button>

          <Box sx={{ flexGrow: 1 }} />

          {/* Open all / Close all are only meaningful now that closing keeps the config —
              they are what turns a set of windows into a rig you switch on per service. */}
          {rig.closedCount > 0 && (
            <Button size="small" variant="outlined" startIcon={<OpenAllIcon />} onClick={() => void rig.openAll()}>
              {LL.WINDOW.OPEN_ALL()}
            </Button>
          )}
          {rig.openCount > 0 && (
            <Button size="small" variant="outlined" color="error" startIcon={<CloseIcon />} onClick={() => void rig.closeAll()}>
              {LL.WINDOW.CLOSE_ALL()}
            </Button>
          )}
          <Button size="small" variant="contained" startIcon={<AddIcon />} onClick={() => startDraft(rig.screens[0])}>
            {LL.WINDOW.ADD()}
          </Button>
        </Stack>

        {/* The desk */}
        <Box sx={{ px: 1.5, pb: 1 }}>
          <WindowDesk
            screens={rig.screens}
            windows={rig.windows}
            selectedId={selectedId}
            onSelect={(id) => {
              setDraft(null);
              setSelectedId(id);
            }}
            onAssign={handleAssign}
            onCreateOnScreen={(screen) => startDraft(screen)}
          />
        </Box>

        <Divider />

        {/* List + inspector, side by side so choosing a window never hides the others. */}
        <Stack direction="row" sx={{ flex: 1, minHeight: 0 }}>
          <Stack sx={{ width: '45%', minWidth: 260, overflow: 'auto', borderRight: 1, borderColor: 'divider' }}>
            <Typography variant="overline" sx={{ px: 1.5, pt: 1, color: 'text.secondary' }}>
              {LL.WINDOW.CONFIGURED()} ({rig.windows.length})
            </Typography>
            {rig.windows.length === 0 ? (
              <Stack sx={{ p: 2, gap: 0.5 }}>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  {LL.WINDOW.NONE_CONFIGURED()}
                </Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {LL.WINDOW.NONE_CONFIGURED_HINT()}
                </Typography>
              </Stack>
            ) : (
              rig.windows.map((win) => (
                <WindowRow
                  key={win.id}
                  window={win}
                  selected={selectedId === win.id}
                  styleName={win.config.styleId ? styles.find((s) => s.id === win.config.styleId)?.name : undefined}
                  stageLayerCount={win.config.stageLayerIds?.length ?? 0}
                  onSelect={() => {
                    setDraft(null);
                    setSelectedId(win.id);
                  }}
                  onOpen={() => void rig.open(win.id)}
                  onClose={() => void rig.close(win.id)}
                  onDelete={() => setPendingDelete(win.id)}
                  onToggleFreeze={() => dispatch(toggleFreezeWindow(win.name))}
                  onToggleHidden={() => void rig.setHidden(win.id, !win.hidden)}
                  onBringToFront={() => {
                    if (win.runtimeId) void window.api?.focusPresentationWindow?.(win.runtimeId);
                  }}
                />
              ))
            )}
          </Stack>

          <Box sx={{ flex: 1, minWidth: 0, display: 'flex' }}>
            {draft ? (
              <WindowInspector
                config={draft}
                onChange={(patch) => setDraft((prev) => (prev ? { ...prev, ...patch } : prev))}
                screens={rig.screens}
                openWindows={deskWindows}
                styles={styles}
                stageLayers={stageLayers}
                footer={
                  <Stack direction="row" spacing={1}>
                    <Button variant="contained" startIcon={<AddIcon />} onClick={handleCreate} sx={{ flex: 1 }}>
                      {LL.WINDOW.CREATE()}
                    </Button>
                    <Button onClick={() => setDraft(null)}>{LL.COMMON.CANCEL()}</Button>
                  </Stack>
                }
              />
            ) : selected ? (
              // Edits apply as they are made. There is no Apply button because there is
              // nothing to batch: every change is already reversible by changing it back,
              // and seeing it happen on the beamer is the whole point.
              <WindowInspector
                key={selected.id}
                config={selected.config}
                onChange={(patch) => void rig.update(selected.id, patch)}
                screens={rig.screens}
                openWindows={deskWindows}
                styles={styles}
                stageLayers={stageLayers}
                bounds={selected.bounds}
              />
            ) : (
              <Stack sx={{ flex: 1, alignItems: 'center', justifyContent: 'center', p: 3 }}>
                <Typography variant="body2" sx={{ color: 'text.secondary', textAlign: 'center' }}>
                  {LL.WINDOW.SELECT_HINT()}
                </Typography>
              </Stack>
            )}
          </Box>
        </Stack>
      </Stack>

      <Dialog open={!!pendingDelete} onClose={() => setPendingDelete(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{LL.WINDOW.DELETE()}</DialogTitle>
        <DialogContent>
          <DialogContentText variant="body2">{LL.WINDOW.DELETE_CONFIRM({ name: pendingDeleteWindow?.name ?? '' })}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingDelete(null)}>{LL.COMMON.CANCEL()}</Button>
          <Button
            variant="contained"
            color="error"
            onClick={() => {
              if (pendingDelete) {
                void rig.remove(pendingDelete);
                if (selectedId === pendingDelete) setSelectedId(null);
              }
              setPendingDelete(null);
            }}
          >
            {LL.COMMON.DELETE()}
          </Button>
        </DialogActions>
      </Dialog>
    </Drawer>
  );
};
