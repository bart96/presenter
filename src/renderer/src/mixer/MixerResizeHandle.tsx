/**
 * MixerResizeHandle — the grip along the top edge of the compact mixer panel.
 *
 * How tall the panel should be is not something this app can decide for someone: it
 * depends on the device, on whether they are reading chords or a full score, and on how
 * many channels they keep visible. So it is a drag, and the answer is remembered.
 *
 * **The height is not written to the store while the finger is moving.** Musician settings
 * persist to localStorage on every reducer run, so dispatching per pointermove would be
 * sixty serialise-and-write cycles a second of the whole settings object — the exact shape
 * of the storage problem that has bitten this app before. The drag runs on local state and
 * commits once, on release.
 */
import { useCallback, useRef, useState } from 'react';
import { Box, Tooltip } from '@mui/material';

/** Never smaller than a usable fader, never so tall it stops being a panel. */
export const PANEL_MIN_HEIGHT = 150;
export const PANEL_MAX_VH = 0.85;

/** One press of an arrow key. Coarse enough to be useful, fine enough to be precise. */
const KEY_STEP = 24;

interface MixerResizeHandleProps {
  /** Live height while dragging, or null to fall back to the stored/default height. */
  onResize: (height: number | null) => void;
  /** Called once when the gesture ends, with the height to remember. */
  onCommit: (height: number) => void;
  /** The panel's current height in pixels, measured — the starting point for a drag. */
  measure: () => number;
  label: string;
}

const clampHeight = (height: number) => Math.max(PANEL_MIN_HEIGHT, Math.min(window.innerHeight * PANEL_MAX_VH, height));

export const MixerResizeHandle = ({ onResize, onCommit, measure, label }: MixerResizeHandleProps) => {
  const [dragging, setDragging] = useState(false);
  /** Read by the move handler, which must not depend on a render having happened first. */
  const draggingRef = useRef(false);
  const latestRef = useRef(0);

  const apply = useCallback(
    (height: number) => {
      const next = clampHeight(height);
      latestRef.current = next;
      onResize(next);
    },
    [onResize],
  );

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = true;
    setDragging(true);
    latestRef.current = measure();
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    // The panel is anchored to the bottom, so its height is simply how far the grip is
    // from the bottom of the viewport. No offset bookkeeping, and it stays correct if the
    // finger drifts sideways or the address bar collapses mid-drag.
    apply(window.innerHeight - event.clientY);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onCommit(latestRef.current);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    const next = clampHeight(measure() + direction * KEY_STEP);
    onResize(next);
    onCommit(next);
  };

  return (
    <Tooltip title={label} placement="top">
      <Box
        role="separator"
        aria-orientation="horizontal"
        aria-label={label}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={handleKeyDown}
        sx={{
          flexShrink: 0,
          height: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'ns-resize',
          // Without this the drag scrolls the sheet behind the panel instead of resizing.
          touchAction: 'none',
          backgroundColor: dragging ? 'rgba(255,255,255,0.10)' : 'transparent',
          '&:hover': { backgroundColor: 'rgba(255,255,255,0.07)' },
          '&:focus-visible': { outline: '2px solid rgba(120,170,255,0.7)', outlineOffset: '-2px' },
        }}
      >
        {/* A bar rather than an icon: it reads as something to pull, at any size. */}
        <Box
          sx={{
            width: 44,
            height: 4,
            borderRadius: 2,
            backgroundColor: dragging ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.35)',
          }}
        />
      </Box>
    </Tooltip>
  );
};
