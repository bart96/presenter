import { useState, useCallback, useEffect, ReactNode } from 'react';
import { IconButton, SpeedDial, SpeedDialAction, Stack, Tooltip, Typography, useTheme, Badge } from '@mui/material';
import {
  Settings as SettingsIcon,
  LooksOne as OnePageIcon,
  LooksTwo as LooksTwoIcon,
  Fullscreen as FullscreenIcon,
  FullscreenExit as FullscreenExitIcon,
  VisibilityOff as VisibilityOffIcon,
  Visibility as VisibilityIcon,
  ZoomIn as ZoomInIcon,
  ZoomOut as ZoomOutIcon,
  FitScreen as FitWidthIcon,
  AspectRatio as Zoom100Icon,
  Create as AnnotateIcon,
  PictureAsPdf as PdfIcon,
  Menu as MenuIcon,
  Sync as SyncIcon,
  SyncDisabled as SyncDisabledIcon,
  Cable as MidiIcon,
  Lock as LockIcon,
  LockOpen as LockOpenIcon,
  RotateLeft as RefetchAnnotationsIcon,
  MultipleStop as OrderIcon,
  CloudSync as RefreshContentIcon,
  Autorenew as AutoRefreshIcon,
  Tune as MixerIcon,
} from '@mui/icons-material';
import { alpha, type Palette } from '@mui/material/styles';
import { useI18nContext } from '@/i18n/i18n-react';
import { useUpdateMusicianSetting, useGetMusicianSettings } from '@/store/musicianSlice';
import { useMetrics } from '@/hooks/useMetrics';
import type { WsSyncStatus } from '@/hooks/useWsSync';

const FAB_SIZE = 44;
const NAV_MARGIN = 36;

export type SyncMode = 'off' | 'operator' | 'midi';

/** Shared base floating button style using theme palette tokens */
export const floatingBtnSx = (palette: Palette, isActive = false) => {
  const isDark = palette.mode === 'dark';
  if (isActive) {
    // Active: uses the primary color prominently
    return {
      width: FAB_SIZE,
      height: FAB_SIZE,
      backdropFilter: 'blur(12px)',
      backgroundColor: alpha(palette.primary.main, isDark ? 0.35 : 0.85),
      color: palette.primary.contrastText,
      border: '1px solid',
      borderColor: alpha(palette.primary.light, isDark ? 0.6 : 0.9),
      boxShadow: `0 2px 8px ${alpha(palette.primary.dark, 0.4)}`,
      transition: 'all 0.2s',
      // Ensure individual buttons are always interactive even when the surrounding
      // Stack has pointerEvents: 'none' to let drawing events pass through.
      pointerEvents: 'auto' as const,
      '&:hover': {
        backgroundColor: alpha(palette.primary.main, isDark ? 0.5 : 0.95),
      },
    };
  }
  // Inactive: subtle semi-transparent grey
  const bg = isDark ? palette.grey[900] : palette.grey[600];
  return {
    width: FAB_SIZE,
    height: FAB_SIZE,
    backdropFilter: 'blur(12px)',
    backgroundColor: alpha(bg, 0.7),
    color: palette.common.white,
    border: '1px solid',
    borderColor: alpha(isDark ? palette.common.white : palette.common.black, 0.12),
    boxShadow: `0 2px 8px ${alpha(palette.common.black, isDark ? 0.5 : 0.18)}`,
    transition: 'all 0.2s',
    // Ensure individual buttons are always interactive even when the surrounding
    // Stack has pointerEvents: 'none' to let drawing events pass through.
    pointerEvents: 'auto' as const,
    '&:hover': {
      backgroundColor: alpha(bg, 0.95),
    },
  };
};

export const FloatingButton = ({
  icon,
  tooltip,
  onClick,
  active,
}: {
  icon: ReactNode;
  tooltip: string;
  onClick: () => void;
  active?: boolean;
}) => {
  const { palette } = useTheme();
  return (
    <Tooltip title={tooltip} placement="left">
      <IconButton onClick={onClick} size="small" sx={floatingBtnSx(palette, active)}>
        {icon}
      </IconButton>
    </Tooltip>
  );
};

export const makeSpeedDialFabSx = (palette: Palette, isActive = false) => {
  return { ...floatingBtnSx(palette, isActive), minHeight: FAB_SIZE };
};

/** Compact SpeedDial root sx — reduces default action spacing to match FloatingButton layout */
const speedDialCompactSx = {
  // Allow pointer events on the SpeedDial itself even though the parent Stack has pointerEvents:none
  pointerEvents: 'auto' as const,
  '& .MuiSpeedDial-actions': {
    gap: '6px',
    paddingLeft: '6px',
    // MUI adds individual margins on each action — zero them out so gap controls spacing
    '& .MuiSpeedDialAction-staticTooltipLabel': { marginLeft: 0 },
    '& > .MuiButtonBase-root, & > .MuiSpeedDialAction-staticTooltip': { margin: 0 },
  },
};

interface MusicianToolbarProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  syncMode: SyncMode;
  onSetSyncMode: (mode: SyncMode) => void;
  wsStatus?: WsSyncStatus;
  onOpenSettings: () => void;
  onOpenPdfModal: () => void;
  isSongItem: boolean;
  activeSongNumber?: number;
  pageView: 'two-page' | 'one-page';
  onSetPageView: (mode: 'two-page' | 'one-page') => void;
  zoomLevel: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onZoomFitWidth: () => void;
  annotateMode: boolean;
  onToggleAnnotate: () => void;
  hasPdfs: boolean;
  /** Triggers an immediate annotation reload from the server. Only available when a PDF is shown. */
  onRefetchAnnotations?: () => void;
  /** Reloads show, songs, orders and PDFs from the server. */
  onRefreshContent?: () => void;
  /** When true, server updates are applied automatically instead of being offered. */
  autoRefresh?: boolean;
  onToggleAutoRefresh?: () => void;
  orderEditorOpen?: boolean;
  onToggleOrderEditor?: () => void;
  /**
   * The operator is offering monitor mixing to this musician. False also covers "no
   * operator online yet", so the button appears when the answer arrives rather than
   * sitting there doing nothing.
   */
  mixerAvailable?: boolean;
  /** The mixer is on screen — lights the button, as every other stateful one here does. */
  mixerOpen?: boolean;
  onToggleMixer?: () => void;
}

export const MusicianToolbar = ({
  sidebarOpen,
  onToggleSidebar,
  syncMode,
  onSetSyncMode,
  wsStatus,
  onOpenSettings,
  onOpenPdfModal,
  isSongItem,
  activeSongNumber,
  pageView,
  onSetPageView,
  zoomLevel,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onZoomFitWidth,
  annotateMode,
  onToggleAnnotate,
  hasPdfs,
  onRefetchAnnotations,
  onRefreshContent,
  autoRefresh,
  onToggleAutoRefresh,
  orderEditorOpen,
  onToggleOrderEditor,
  mixerAvailable,
  mixerOpen,
  onToggleMixer,
}: MusicianToolbarProps) => {
  const { LL } = useI18nContext();
  const { palette } = useTheme();
  const isDark = palette.mode === 'dark';
  const { trackEvent } = useMetrics();

  const { musicianToolbarExpanded } = useGetMusicianSettings();
  const updateMusicianSetting = useUpdateMusicianSetting();

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [wakeLock, setWakeLock] = useState<WakeLockSentinel | null>(null);
  const [pageCountOpen, setPageCountOpen] = useState(false);
  const [syncDialOpen, setSyncDialOpen] = useState(false);
  const [zoomDialOpen, setZoomDialOpen] = useState(false);
  const [refreshDialOpen, setRefreshDialOpen] = useState(false);

  // Safari-compatible fullscreen helpers
  const getFullscreenElement = (): Element | null => document.fullscreenElement ?? (document as any).webkitFullscreenElement ?? null;

  const toggleFullscreen = useCallback(() => {
    const el = document.documentElement as any;
    if (!getFullscreenElement()) {
      if (el.requestFullscreen) {
        el.requestFullscreen().catch(() => {});
      } else if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if ((document as any).webkitExitFullscreen) {
        (document as any).webkitExitFullscreen();
      }
    }
  }, []);

  useEffect(() => {
    const h = () => setIsFullscreen(!!getFullscreenElement());
    document.addEventListener('fullscreenchange', h);
    document.addEventListener('webkitfullscreenchange', h);
    return () => {
      document.removeEventListener('fullscreenchange', h);
      document.removeEventListener('webkitfullscreenchange', h);
    };
  }, []);

  // Wake Lock (keep screen awake)
  const supportsWakeLock = 'wakeLock' in navigator;

  const toggleWakeLock = useCallback(async () => {
    if (wakeLock) {
      await wakeLock.release();
      setWakeLock(null);
    } else {
      try {
        const sentinel = await navigator.wakeLock.request('screen');
        sentinel.addEventListener('release', () => setWakeLock(null));
        setWakeLock(sentinel);
      } catch {
        // Wake lock request failed (e.g. page not visible)
      }
    }
  }, [wakeLock]);

  // Release wake lock on unmount
  useEffect(() => {
    return () => {
      wakeLock?.release().catch(() => {});
    };
  }, [wakeLock]);

  const syncModeIcon: Record<SyncMode, ReactNode> = {
    off: <SyncDisabledIcon fontSize="small" />,
    operator: <SyncIcon fontSize="small" />,
    midi: <MidiIcon fontSize="small" />,
  };
  const syncModeLabel: Record<SyncMode, string> = {
    off: 'Sync Off',
    operator: 'Operator Sync',
    midi: 'MIDI Sync',
  };

  const toggleExpanded = () => {
    trackEvent('musician_button_clicked', undefined, undefined, { button: 'toolbar_toggle' });
    updateMusicianSetting('musicianToolbarExpanded', !musicianToolbarExpanded);
  };

  const zoomPercent = Math.round(zoomLevel * 100);

  const activeActionFabSx = (active: boolean) =>
    active
      ? {
          backgroundColor: alpha(palette.primary.main, isDark ? 0.35 : 0.85),
          color: palette.primary.contrastText,
          border: '2px solid',
          borderColor: alpha(palette.primary.light, isDark ? 0.6 : 0.9),
          '&:hover': { backgroundColor: alpha(palette.primary.main, isDark ? 0.5 : 0.95) },
        }
      : {};

  const showPdfTools = isSongItem && hasPdfs;

  return (
    <Stack
      spacing={0.75}
      sx={{
        alignItems: 'flex-end',
        position: 'absolute',
        top: 10,
        right: NAV_MARGIN,
        // Above the quick order editor (zIndex 12) — a tall wrapped order used to grow
        // into the toolbar and swallow its clicks.
        zIndex: 20,
        pointerEvents: 'none',
      }}
    >
      {/* Row 1: Sync (left) + Wake Lock + Toggle Toolbar (right) — always visible */}
      <Stack
        direction="row"
        spacing={0.75}
        sx={{
          alignItems: 'center',
        }}
      >
        <SpeedDial
          ariaLabel="Sync mode"
          sx={speedDialCompactSx}
          open={syncDialOpen}
          onOpen={() => setSyncDialOpen(true)}
          onClose={() => setSyncDialOpen(false)}
          direction="left"
          icon={
            syncMode === 'operator' || syncMode === 'midi' ? (
              <Badge
                variant="dot"
                color={wsStatus === 'connected' ? 'success' : wsStatus === 'error' ? 'error' : 'warning'}
                overlap="circular"
              >
                {syncModeIcon[syncMode]}
              </Badge>
            ) : (
              syncModeIcon[syncMode]
            )
          }
          FabProps={{
            size: 'small',
            sx: makeSpeedDialFabSx(palette, syncMode !== 'off'),
          }}
        >
          {(['off', 'operator', 'midi'] as SyncMode[]).map((mode) => (
            <SpeedDialAction
              key={mode}
              icon={syncModeIcon[mode]}
              slotProps={{
                tooltip: { title: syncModeLabel[mode], placement: 'bottom' },
                fab: { sx: activeActionFabSx(syncMode === mode) },
              }}
              onClick={() => {
                onSetSyncMode(mode);
                setSyncDialOpen(false);
                trackEvent('musician_button_clicked', undefined, undefined, { button: 'sync_mode', value: mode });
              }}
            />
          ))}
        </SpeedDial>
        {/* Wake lock — always visible so users can quickly keep the screen on */}
        {supportsWakeLock && (
          <FloatingButton
            icon={wakeLock ? <LockIcon fontSize="small" /> : <LockOpenIcon fontSize="small" />}
            tooltip={wakeLock ? LL.MUSICIAN.WAKE_LOCK_OFF() : LL.MUSICIAN.WAKE_LOCK_ON()}
            onClick={() => {
              trackEvent('musician_button_clicked', undefined, undefined, { button: wakeLock ? 'wake_lock_off' : 'wake_lock_on' });
              toggleWakeLock();
            }}
            active={!!wakeLock}
          />
        )}
        <FloatingButton
          icon={musicianToolbarExpanded ? <VisibilityOffIcon fontSize="small" /> : <VisibilityIcon fontSize="small" />}
          tooltip={LL.MUSICIAN.TOOLBAR_TOGGLE()}
          onClick={toggleExpanded}
        />
      </Stack>
      {/* Expandable toolbar column */}
      {musicianToolbarExpanded && (
        <>
          {/* Sidebar toggle */}
          <FloatingButton
            icon={<MenuIcon fontSize="small" />}
            tooltip={LL.MUSICIAN.SIDEBAR_TOGGLE()}
            onClick={() => {
              trackEvent('musician_button_clicked', undefined, undefined, { button: 'sidebar_toggle' });
              onToggleSidebar();
            }}
            active={sidebarOpen}
          />

          {/* Monitor mixer — only when the operator has one to offer. Pressing it is what
              downloads the mixer chunk; until then nothing of it has been fetched. */}
          {mixerAvailable && (
            <FloatingButton
              icon={<MixerIcon fontSize="small" />}
              tooltip={LL.MIXER.TITLE()}
              active={mixerOpen}
              onClick={() => {
                trackEvent('musician_button_clicked', undefined, undefined, {
                  button: 'monitor_mixer',
                  value: mixerOpen ? 'close' : 'open',
                });
                onToggleMixer?.();
              }}
            />
          )}

          {/* Fullscreen */}
          <FloatingButton
            icon={isFullscreen ? <FullscreenExitIcon fontSize="small" /> : <FullscreenIcon fontSize="small" />}
            tooltip={isFullscreen ? LL.MUSICIAN.EXIT_FULLSCREEN() : LL.MUSICIAN.FULLSCREEN()}
            onClick={() => {
              trackEvent('musician_button_clicked', undefined, undefined, { button: isFullscreen ? 'exit_fullscreen' : 'fullscreen' });
              toggleFullscreen();
            }}
            active={isFullscreen}
          />

          {/* 3. Page spread (per-PDF) */}
          <SpeedDial
            ariaLabel="Page display count"
            sx={speedDialCompactSx}
            open={pageCountOpen}
            onOpen={() => setPageCountOpen(true)}
            onClose={() => setPageCountOpen(false)}
            direction="left"
            icon={pageView === 'two-page' ? <LooksTwoIcon fontSize="small" /> : <OnePageIcon fontSize="small" />}
            FabProps={{ size: 'small', sx: makeSpeedDialFabSx(palette) }}
          >
            <SpeedDialAction
              icon={<OnePageIcon fontSize="small" />}
              slotProps={{
                tooltip: { title: LL.MUSICIAN.PAGE_ONE(), placement: 'bottom' },
                fab: { sx: activeActionFabSx(pageView === 'one-page') },
              }}
              onClick={() => {
                onSetPageView('one-page');
                setPageCountOpen(false);
                trackEvent('musician_button_clicked', undefined, undefined, { button: 'page_view', value: 'one-page' });
              }}
            />
            <SpeedDialAction
              icon={<LooksTwoIcon fontSize="small" />}
              slotProps={{
                tooltip: { title: LL.MUSICIAN.PAGE_TWO(), placement: 'bottom' },
                fab: { sx: activeActionFabSx(pageView === 'two-page') },
              }}
              onClick={() => {
                onSetPageView('two-page');
                setPageCountOpen(false);
                trackEvent('musician_button_clicked', undefined, undefined, { button: 'page_view', value: 'two-page' });
              }}
            />
          </SpeedDial>

          {/* 4. PDF management */}
          {isSongItem && activeSongNumber != null && (
            <FloatingButton
              icon={<PdfIcon fontSize="small" />}
              tooltip={hasPdfs ? LL.PDF.MANAGE_TITLE() : LL.PDF.IMPORT_TITLE()}
              onClick={() => {
                trackEvent('musician_button_clicked', undefined, undefined, { button: hasPdfs ? 'pdf_manage' : 'pdf_import' });
                onOpenPdfModal();
              }}
            />
          )}

          {/* 5. Annotate — only when PDF is shown */}
          {showPdfTools && (
            <FloatingButton
              icon={<AnnotateIcon fontSize="small" />}
              tooltip={LL.MUSICIAN.ANNOTATE()}
              onClick={() => {
                trackEvent('musician_button_clicked', undefined, undefined, { button: 'annotate_toggle' });
                onToggleAnnotate();
              }}
              active={annotateMode}
            />
          )}

          {/* 5a. Order editor toggle — song items only */}
          {isSongItem && onToggleOrderEditor && (
            <FloatingButton
              icon={<OrderIcon fontSize="small" />}
              tooltip={LL.MUSICIAN.ITEM_EDIT_ORDER()}
              onClick={() => {
                trackEvent('musician_button_clicked', undefined, undefined, { button: 'order_editor_toggle' });
                onToggleOrderEditor();
              }}
              active={!!orderEditorOpen}
            />
          )}

          {/* 5b. Reload from server — annotations / full content / auto mode */}
          {(onRefreshContent || onToggleAutoRefresh || (showPdfTools && onRefetchAnnotations)) && (
            <SpeedDial
              ariaLabel="Reload from server"
              sx={speedDialCompactSx}
              open={refreshDialOpen}
              onOpen={() => setRefreshDialOpen(true)}
              onClose={() => setRefreshDialOpen(false)}
              direction="left"
              icon={autoRefresh ? <AutoRefreshIcon fontSize="small" /> : <RefetchAnnotationsIcon fontSize="small" />}
              FabProps={{ size: 'small', sx: makeSpeedDialFabSx(palette, !!autoRefresh) }}
            >
              {showPdfTools && onRefetchAnnotations && (
                <SpeedDialAction
                  icon={<RefetchAnnotationsIcon fontSize="small" />}
                  slotProps={{ tooltip: { title: LL.ANNOTATION.REFETCH(), placement: 'bottom' } }}
                  onClick={() => {
                    onRefetchAnnotations();
                    setRefreshDialOpen(false);
                    trackEvent('musician_button_clicked', undefined, undefined, { button: 'refetch_annotations' });
                  }}
                />
              )}
              {onRefreshContent && (
                <SpeedDialAction
                  icon={<RefreshContentIcon fontSize="small" />}
                  slotProps={{ tooltip: { title: LL.MUSICIAN.REFRESH_CONTENT(), placement: 'bottom' } }}
                  onClick={() => {
                    onRefreshContent();
                    setRefreshDialOpen(false);
                    trackEvent('musician_button_clicked', undefined, undefined, { button: 'refresh_content' });
                  }}
                />
              )}
              {onToggleAutoRefresh && (
                <SpeedDialAction
                  icon={<AutoRefreshIcon fontSize="small" />}
                  slotProps={{
                    tooltip: { title: LL.MUSICIAN.AUTO_REFRESH(), placement: 'bottom' },
                    fab: { sx: activeActionFabSx(!!autoRefresh) },
                  }}
                  onClick={() => {
                    onToggleAutoRefresh();
                    setRefreshDialOpen(false);
                    trackEvent('musician_button_clicked', undefined, undefined, {
                      button: 'auto_refresh',
                      value: autoRefresh ? 'off' : 'on',
                    });
                  }}
                />
              )}
            </SpeedDial>
          )}

          {/* 6. Zoom — only when PDF is shown */}
          {showPdfTools && (
            <SpeedDial
              ariaLabel="Zoom controls"
              sx={speedDialCompactSx}
              open={zoomDialOpen}
              onOpen={() => setZoomDialOpen(true)}
              onClose={() => setZoomDialOpen(false)}
              direction="left"
              icon={
                <Stack
                  sx={{
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '100%',
                    height: '100%',
                  }}
                >
                  <ZoomInIcon sx={{ fontSize: '1.1rem' }} />
                  <Typography sx={{ fontSize: '0.5rem', lineHeight: 1, fontWeight: 700, mt: '-2px' }}>{zoomPercent}%</Typography>
                </Stack>
              }
              FabProps={{ size: 'small', sx: makeSpeedDialFabSx(palette) }}
            >
              <SpeedDialAction
                icon={<ZoomInIcon fontSize="small" />}
                slotProps={{ tooltip: { title: LL.MUSICIAN.ZOOM_IN(), placement: 'bottom' } }}
                onClick={() => {
                  onZoomIn();
                  trackEvent('musician_button_clicked', undefined, undefined, { button: 'zoom_in' });
                }}
              />
              <SpeedDialAction
                icon={<ZoomOutIcon fontSize="small" />}
                slotProps={{ tooltip: { title: LL.MUSICIAN.ZOOM_OUT(), placement: 'bottom' } }}
                onClick={() => {
                  onZoomOut();
                  trackEvent('musician_button_clicked', undefined, undefined, { button: 'zoom_out' });
                }}
              />
              <SpeedDialAction
                icon={<Zoom100Icon fontSize="small" />}
                slotProps={{
                  tooltip: { title: LL.MUSICIAN.ZOOM_100(), placement: 'bottom' },
                  fab: { sx: activeActionFabSx(zoomPercent === 100) },
                }}
                onClick={() => {
                  onZoomReset();
                  setZoomDialOpen(false);
                  trackEvent('musician_button_clicked', undefined, undefined, { button: 'zoom_reset' });
                }}
              />
              <SpeedDialAction
                icon={<FitWidthIcon fontSize="small" />}
                slotProps={{ tooltip: { title: LL.MUSICIAN.ZOOM_FIT_WIDTH(), placement: 'bottom' } }}
                onClick={() => {
                  onZoomFitWidth();
                  setZoomDialOpen(false);
                  trackEvent('musician_button_clicked', undefined, undefined, { button: 'zoom_fit_width' });
                }}
              />
            </SpeedDial>
          )}

          {/* 7. Settings */}
          <FloatingButton
            icon={<SettingsIcon fontSize="small" />}
            tooltip={LL.MUSICIAN.SETTINGS()}
            onClick={() => {
              trackEvent('musician_button_clicked', undefined, undefined, { button: 'settings' });
              onOpenSettings();
            }}
          />
        </>
      )}
    </Stack>
  );
};
