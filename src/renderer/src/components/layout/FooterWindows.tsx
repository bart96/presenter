/**
 * The window strip in the operator footer, and the restore-on-start pass behind it.
 *
 * Pulled out of `Footer.tsx`, which had grown to hold three copies of the window state
 * (bridge list, hidden set, screen list) plus its own poll, a twelve-item menu and two
 * sub-menus — all of it duplicating the Window Manager. It now shares one merged view
 * through `usePresentationWindows`, and the chip opens a toggle panel rather than a menu.
 *
 * The chips scroll horizontally instead of wrapping or overflowing: a six-window rig used
 * to push the connection chips off the end of the toolbar.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { Box, Button, Chip, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import {
  Add as AddIcon,
  Cast as StreamIcon,
  Monitor as NormalIcon,
  PlayArrow as OpenIcon,
  Visibility as ShowIcon,
  VisibilityOff as HideWindowIcon,
} from '@mui/icons-material';
import { useI18nContext } from '@/i18n/i18n-react';
import { useAppDispatch } from '@/store';
import { toggleFreezeWindow, useGetPresentationSettings } from '@/store/presentationSlice';
import { useGetSettings } from '@/store/settingsSlice';
import { useWindowActions, useWindowConfigs, type SavedWindowConfig } from '@/store/windowSlice';
import { useGetStylesQuery } from '@/api/styles.api';
import { usePresentationWindows, refreshWindowRuntime, type RigWindow } from '@/hooks/usePresentationWindows';
import { getHasRestoredSavedWindows, markRestoredSavedWindows, openPresentationWindow } from '@/utils/presentationBridge';
import type { ScreenInfo } from './ScreenPicker';
import { WindowQuickActions } from './WindowQuickActions';

export interface FooterWindowsProps {
  variant: 'bar' | 'panel';
  /** Open the Window Manager, optionally straight onto a window or the new-window form. */
  onOpenWindowManager: (options?: { withNew?: boolean; selectId?: string }) => void;
}

/**
 * Reopen the windows that were configured last time.
 *
 * Runs once per renderer lifetime (the module-level guard in the bridge, not a ref — a ref
 * resets on every HMR remount and used to spawn duplicate BrowserWindows). Windows that
 * survived a renderer reload are adopted by name rather than opened again.
 */
const useRestoreSavedWindows = (adopt: (runtimeId: string, config: SavedWindowConfig) => void): void => {
  const configs = useWindowConfigs();
  const actions = useWindowActions();
  const { windowFooterVisible, restoreWindowsOnStart } = useGetSettings();

  const configsRef = useRef(configs);
  configsRef.current = configs;

  useEffect(() => {
    if (getHasRestoredSavedWindows()) return;
    if (!(windowFooterVisible || restoreWindowsOnStart)) return;
    const initial = configsRef.current;
    // Configs can arrive after mount (settings load asynchronously) — wait for them rather
    // than marking the restore done against an empty list.
    if (initial.length === 0) return;
    markRestoredSavedWindows();

    void (async () => {
      let live: Array<{ id: string; name?: string }> = [];
      try {
        if (window.api?.getWindowStates) live = await window.api.getWindowStates();
      } catch {
        /* no main process to ask — everything below just opens fresh */
      }
      const liveById = new Set(live.map((w) => w.id));
      const liveByName = new Map(live.filter((w) => w.name).map((w) => [w.name!, w]));
      const adopted = new Set<string>();

      for (const cfg of initial) {
        // Already alive under the id we remembered — adopt and move on.
        if (cfg._runtimeId && liveById.has(cfg._runtimeId)) {
          adopt(cfg._runtimeId, cfg);
          adopted.add(cfg._runtimeId);
          continue;
        }
        // A window of the same name survived a renderer reload; reuse it rather than
        // stacking a second one on the same beamer.
        const match = cfg.name ? liveByName.get(cfg.name) : undefined;
        if (match && !adopted.has(match.id)) {
          adopted.add(match.id);
          adopt(match.id, cfg);
          continue;
        }
        try {
          const runtimeId = await openPresentationWindow(cfg);
          actions.setRuntimeId(cfg.id, runtimeId);
        } catch (e) {
          console.error('Failed to restore window:', e);
        }
      }
      refreshWindowRuntime();
      window.dispatchEvent(new CustomEvent('presenter:force-broadcast'));
    })();
  }, [configs.length, windowFooterVisible, restoreWindowsOnStart, adopt, actions]);
};

/** One window as a footer chip. Name and mode only; state is in the tooltip and the tint. */
const WindowChip = ({
  window: win,
  styleName,
  isBlack,
  draggable,
  onOpenActions,
  onOpen,
  onToggleHidden,
  dragProps,
}: {
  window: RigWindow;
  styleName?: string;
  isBlack: boolean;
  draggable: boolean;
  onOpenActions: (e: MouseEvent<HTMLElement>) => void;
  onOpen: () => void;
  onToggleHidden: () => void;
  dragProps: Record<string, unknown>;
}) => {
  const { LL } = useI18nContext();

  // Everything that used to be a micro-icon crowding the label. Four of them made a chip
  // twice as wide as its name, on a strip where names are what you scan for.
  const details = [
    win.screen?.label,
    styleName,
    win.frozen ? LL.FOOTER.FREEZE() : null,
    win.config.fullscreen ? LL.WINDOW.FULLSCREEN() : null,
    win.config.alwaysOnTop ? LL.WINDOW.ALWAYS_ON_TOP() : null,
    win.hidden ? LL.FOOTER.HIDE_WINDOW() : null,
    (win.config.stageLayerIds?.length ?? 0) > 0 ? LL.WINDOW.STAGE_LAYERS() : null,
  ].filter(Boolean);

  const tooltip = <Box sx={{ whiteSpace: 'pre-line' }}>{[win.name, ...(details.length ? [details.join(' · ')] : [])].join('\n')}</Box>;

  if (!win.isOpen) {
    return (
      <Box {...dragProps} sx={{ display: 'inline-flex', cursor: draggable ? 'grab' : undefined }}>
        <Tooltip title={`${win.name} — ${LL.WINDOW.CLOSED()}`}>
          <Chip
            icon={<OpenIcon fontSize="small" />}
            label={win.name}
            size="small"
            variant="outlined"
            sx={{ fontSize: '0.75rem', opacity: 0.5 }}
            onClick={onOpen}
          />
        </Tooltip>
      </Box>
    );
  }

  return (
    <Box {...dragProps} sx={{ display: 'inline-flex', cursor: draggable ? 'grab' : undefined }}>
      <Tooltip title={tooltip}>
        <Chip
          icon={win.config.displayMode === 'stream' ? <StreamIcon fontSize="small" /> : <NormalIcon fontSize="small" />}
          label={win.name}
          size="small"
          variant={win.frozen ? 'filled' : 'outlined'}
          color={win.frozen ? 'info' : isBlack || win.hidden ? 'default' : 'primary'}
          sx={{ fontSize: '0.75rem', maxWidth: 190 }}
          onClick={onOpenActions}
          deleteIcon={
            <Tooltip title={win.hidden ? LL.FOOTER.SHOW_WINDOW() : LL.FOOTER.HIDE_WINDOW()}>
              {win.hidden ? <ShowIcon fontSize="small" /> : <HideWindowIcon fontSize="small" />}
            </Tooltip>
          }
          onDelete={onToggleHidden}
        />
      </Tooltip>
    </Box>
  );
};

export const FooterWindows = ({ variant, onOpenWindowManager }: FooterWindowsProps) => {
  const { LL } = useI18nContext();
  const dispatch = useAppDispatch();
  const { isBlack } = useGetPresentationSettings();
  const { data: styles = [] } = useGetStylesQuery();
  const actions = useWindowActions();
  const rig = usePresentationWindows();

  useRestoreSavedWindows(rig.adopt);

  const [actionsAnchor, setActionsAnchor] = useState<HTMLElement | null>(null);
  const [actionsWindowId, setActionsWindowId] = useState<string | null>(null);
  const actionsWindow = rig.windows.find((w) => w.id === actionsWindowId);

  // Drag-and-drop reordering of the chips, which is also the order the manager lists them in.
  const dragIdRef = useRef<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const dragPropsFor = useCallback(
    (win: RigWindow): Record<string, unknown> => {
      if (win.unmanaged) return {};
      return {
        draggable: true,
        onDragStart: () => (dragIdRef.current = win.id),
        onDragOver: (e: DragEvent) => {
          e.preventDefault();
          setDragOverId(win.id);
        },
        onDragLeave: () => setDragOverId((cur) => (cur === win.id ? null : cur)),
        onDrop: (e: DragEvent) => {
          e.preventDefault();
          const from = dragIdRef.current;
          setDragOverId(null);
          dragIdRef.current = null;
          if (!from || from === win.id) return;
          const ids = rig.windows.filter((w) => !w.unmanaged).map((w) => w.id);
          const next = ids.filter((id) => id !== from);
          next.splice(next.indexOf(win.id), 0, from);
          actions.reorder(next);
        },
        onDragEnd: () => {
          setDragOverId(null);
          dragIdRef.current = null;
        },
        style: dragOverId === win.id ? { outline: '2px solid currentColor', borderRadius: 16 } : undefined,
      };
    },
    [rig.windows, actions, dragOverId],
  );

  const chips = rig.windows.map((win) => (
    <WindowChip
      key={win.id}
      window={win}
      styleName={win.config.styleId ? styles.find((s) => s.id === win.config.styleId)?.name : undefined}
      isBlack={isBlack}
      draggable={!win.unmanaged}
      dragProps={dragPropsFor(win)}
      onOpen={() => void rig.open(win.id)}
      onToggleHidden={() => void rig.setHidden(win.id, !win.hidden)}
      onOpenActions={(e) => {
        setActionsAnchor(e.currentTarget);
        setActionsWindowId(win.id);
      }}
    />
  ));

  const closeActions = () => {
    setActionsAnchor(null);
    setActionsWindowId(null);
  };

  const quickActions = (
    <WindowQuickActions
      anchorEl={actionsAnchor}
      window={actionsWindow}
      styles={styles}
      screens={rig.screens}
      onClose={closeActions}
      onUpdate={(patch) => actionsWindow && void rig.update(actionsWindow.id, patch)}
      onToggleFreeze={() => actionsWindow && dispatch(toggleFreezeWindow(actionsWindow.name))}
      onToggleHidden={() => actionsWindow && void rig.setHidden(actionsWindow.id, !actionsWindow.hidden)}
      onBringToFront={() => {
        if (actionsWindow?.runtimeId) void window.api?.focusPresentationWindow?.(actionsWindow.runtimeId);
        closeActions();
      }}
      onCloseWindow={() => {
        if (actionsWindow) void rig.close(actionsWindow.id);
        closeActions();
      }}
      onMoveToScreen={(screen: ScreenInfo) => {
        if (!actionsWindow) return;
        void rig.update(actionsWindow.id, {
          positionX: screen.bounds.x,
          positionY: screen.bounds.y,
          width: screen.bounds.width,
          height: screen.bounds.height,
        });
      }}
      onOpenSettings={() => {
        const id = actionsWindow?.id;
        closeActions();
        onOpenWindowManager({ selectId: id });
      }}
    />
  );

  if (variant === 'panel') {
    return (
      <>
        {rig.windows.length > 0 ? (
          <Stack direction="row" sx={{ gap: 0.5, flexWrap: 'wrap', alignItems: 'center' }}>
            {chips}
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">
            {LL.FOOTER.NO_WINDOWS()}
          </Typography>
        )}
        <Button
          size="small"
          variant="outlined"
          startIcon={<AddIcon />}
          onClick={() => onOpenWindowManager({ withNew: true })}
          sx={{ alignSelf: 'flex-start' }}
        >
          {LL.WINDOW.ADD()}
        </Button>
        {quickActions}
      </>
    );
  }

  return (
    <>
      {rig.windows.length > 0 ? (
        <Stack
          direction="row"
          sx={{
            gap: 0.5,
            alignItems: 'center',
            minWidth: 0,
            // Scroll rather than wrap or overflow: the toolbar is one row high, and a rig
            // that outgrows it must not push the connection chips off the end.
            overflowX: 'auto',
            overflowY: 'hidden',
            py: 0.25,
            '&::-webkit-scrollbar': { height: 4 },
            '&::-webkit-scrollbar-thumb': { borderRadius: 2, backgroundColor: 'divider' },
          }}
        >
          {chips}
        </Stack>
      ) : (
        <Typography variant="body2" sx={{ color: 'text.secondary', flexGrow: 1, textAlign: 'center' }}>
          {LL.FOOTER.NO_WINDOWS()}
        </Typography>
      )}

      {rig.closedCount > 0 && rig.openCount === 0 && (
        <Tooltip title={LL.WINDOW.OPEN_ALL()}>
          <IconButton size="small" color="primary" onClick={() => void rig.openAll()}>
            <OpenIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}

      <Tooltip title={LL.WINDOW.ADD()}>
        <IconButton size="small" onClick={() => onOpenWindowManager({ withNew: true })}>
          <AddIcon fontSize="small" />
        </IconButton>
      </Tooltip>

      {quickActions}
    </>
  );
};
