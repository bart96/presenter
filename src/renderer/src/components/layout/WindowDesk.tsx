/**
 * The desk: this machine's displays drawn to scale, with every configured presentation
 * window drawn on the screen it actually occupies.
 *
 * The Window Manager used to lead with a list, and the picture of the desk was buried
 * inside the edit form. That is backwards — the one thing an operator needs to know at a
 * glance is *which beamer is showing what*, and the arrangement answers it directly.
 * Selecting, moving and creating all happen here; the list below is for detail.
 *
 * Electron-only in practice: in the browser `listScreens()` reports a single synthetic
 * screen, which still draws correctly as one box but offers no choice.
 */
import { useState, type DragEvent } from 'react';
import { Box, Stack, Tooltip, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import { AcUnit as FreezeIcon, Cast as StreamIcon, Monitor as NormalIcon, VisibilityOff as HiddenIcon } from '@mui/icons-material';
import { useI18nContext } from '@/i18n/i18n-react';
import { deskLayout, type ScreenInfo } from './ScreenPicker';
import type { RigWindow, WindowBounds } from '@/hooks/usePresentationWindows';

interface WindowDeskProps {
  screens: ScreenInfo[];
  windows: RigWindow[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  /** Move a window onto a screen (fills that screen's bounds). */
  onAssign: (windowId: string, screen: ScreenInfo) => void;
  /** Double-click on empty screen space — create a window filling it. */
  onCreateOnScreen?: (screen: ScreenInfo) => void;
  height?: number;
  maxWidth?: number;
}

/**
 * Where to draw a window. An open window reports live bounds; a closed one is drawn from
 * the geometry it will be reopened with, so a rig can be arranged before anything is on.
 */
const boundsForWindow = (w: RigWindow): WindowBounds | undefined => {
  if (w.bounds) return w.bounds;
  const { positionX, positionY, width, height } = w.config;
  if (positionX === undefined || positionY === undefined || !width || !height) return undefined;
  return { x: positionX, y: positionY, width, height };
};

export const WindowDesk = ({
  screens,
  windows,
  selectedId,
  onSelect,
  onAssign,
  onCreateOnScreen,
  height = 230,
  maxWidth = 840,
}: WindowDeskProps) => {
  const { LL } = useI18nContext();
  const [dragWindowId, setDragWindowId] = useState<string | null>(null);
  const [dropScreenId, setDropScreenId] = useState<number | null>(null);

  if (screens.length === 0) return null;

  const { scale, boardW, boardH, minX, minY } = deskLayout(screens, maxWidth, height);

  const placed = windows.map((w) => ({ w, bounds: boundsForWindow(w) }));

  return (
    <Stack spacing={0.5}>
      <Box
        sx={{
          position: 'relative',
          height,
          borderRadius: 1,
          bgcolor: 'action.hover',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Box sx={{ position: 'relative', width: boardW, height: boardH }}>
          {/* Screens */}
          {screens.map((s) => {
            const isDropTarget = dropScreenId === s.id && dragWindowId !== null;
            return (
              <Box
                key={s.id}
                onDragOver={(e: DragEvent) => {
                  if (!dragWindowId) return;
                  e.preventDefault();
                  setDropScreenId(s.id);
                }}
                onDragLeave={() => setDropScreenId((cur) => (cur === s.id ? null : cur))}
                onDrop={(e: DragEvent) => {
                  e.preventDefault();
                  if (dragWindowId) onAssign(dragWindowId, s);
                  setDragWindowId(null);
                  setDropScreenId(null);
                }}
                onDoubleClick={() => onCreateOnScreen?.(s)}
                sx={(theme) => ({
                  position: 'absolute',
                  left: (s.bounds.x - minX) * scale,
                  top: (s.bounds.y - minY) * scale,
                  width: Math.max(24, s.bounds.width * scale - 4),
                  height: Math.max(20, s.bounds.height * scale - 4),
                  border: '2px solid',
                  borderColor: isDropTarget ? 'primary.main' : 'divider',
                  bgcolor: isDropTarget ? alpha(theme.palette.primary.main, 0.18) : theme.palette.background.paper,
                  borderRadius: 1,
                  overflow: 'hidden',
                  transition: 'background-color 120ms, border-color 120ms',
                })}
              >
                {/* Screen label sits in the corner so window rectangles get the middle. */}
                <Stack sx={{ position: 'absolute', top: 2, left: 4, pointerEvents: 'none', maxWidth: '100%' }}>
                  <Typography variant="caption" noWrap sx={{ fontWeight: 700, fontSize: '0.6rem', lineHeight: 1.2 }}>
                    {s.label}
                    {s.isPrimary ? ` · ${LL.WINDOW.PRIMARY_SCREEN()}` : ''}
                  </Typography>
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.55rem', lineHeight: 1.2 }}>
                    {s.bounds.width}×{s.bounds.height}
                  </Typography>
                </Stack>
              </Box>
            );
          })}

          {/* Windows, drawn over the screens they sit on. */}
          {placed.map(({ w, bounds }) => {
            if (!bounds) return null;
            const selected = selectedId === w.id;
            const left = (bounds.x - minX) * scale;
            const top = (bounds.y - minY) * scale;
            const width = Math.max(30, bounds.width * scale - 8);
            const height_ = Math.max(22, bounds.height * scale - 8);

            return (
              <Tooltip key={w.id} title={`${w.name}${w.isOpen ? '' : ` — ${LL.WINDOW.CLOSED()}`}`}>
                <Box
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected}
                  draggable
                  onDragStart={() => setDragWindowId(w.id)}
                  onDragEnd={() => {
                    setDragWindowId(null);
                    setDropScreenId(null);
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(w.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect(w.id);
                    }
                  }}
                  sx={(theme) => {
                    // State reads off the fill, so the arrangement answers "what is that
                    // beamer doing" without opening anything.
                    const tint = w.frozen ? theme.palette.info.main : w.hidden ? theme.palette.warning.main : theme.palette.primary.main;
                    return {
                      position: 'absolute',
                      left: left + 4,
                      top: top + 4,
                      width,
                      height: height_,
                      border: selected ? '2px solid' : '1px solid',
                      borderStyle: w.isOpen ? 'solid' : 'dashed',
                      borderColor: selected ? tint : alpha(tint, 0.7),
                      bgcolor: alpha(tint, w.isOpen ? (selected ? 0.42 : 0.26) : 0.08),
                      color: theme.palette.getContrastText(theme.palette.background.paper),
                      opacity: w.isOpen ? 1 : 0.65,
                      borderRadius: 0.75,
                      cursor: 'grab',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 0.25,
                      px: 0.5,
                      overflow: 'hidden',
                      boxShadow: selected ? `0 0 0 2px ${alpha(tint, 0.35)}` : 'none',
                      transition: 'background-color 120ms, border-color 120ms, box-shadow 120ms',
                      '&:active': { cursor: 'grabbing' },
                      '&:focus-visible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 },
                    };
                  }}
                >
                  <Stack direction="row" spacing={0.25} sx={{ alignItems: 'center', maxWidth: '100%' }}>
                    {w.config.displayMode === 'stream' ? <StreamIcon sx={{ fontSize: 11 }} /> : <NormalIcon sx={{ fontSize: 11 }} />}
                    {w.frozen && <FreezeIcon sx={{ fontSize: 11 }} />}
                    {w.hidden && <HiddenIcon sx={{ fontSize: 11 }} />}
                    <Typography variant="caption" noWrap sx={{ fontSize: '0.6rem', fontWeight: 700 }}>
                      {w.name}
                    </Typography>
                  </Stack>
                  {/* Which stage layers land here — the fastest way to see that the countdown
                      is going to the wrong beamer. */}
                  {(w.config.stageLayerIds?.length ?? 0) > 0 && height_ > 34 && (
                    <Typography variant="caption" sx={{ fontSize: '0.5rem', opacity: 0.8 }}>
                      ⏱ {w.config.stageLayerIds!.length}
                    </Typography>
                  )}
                </Box>
              </Tooltip>
            );
          })}
        </Box>
      </Box>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {LL.WINDOW.DESK_HINT()}
      </Typography>
    </Stack>
  );
};
