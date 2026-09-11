/**
 * MixerFader — one vertical fader.
 *
 * Three things it does deliberately:
 *
 * **It ignores the desk while it is being touched.** Two people on two phones can hold
 * the same fader, and the desk echoes both back; the contract's own advice (§7) is to
 * ignore incoming state for a control under the finger and take it the moment it is
 * released, which is what `dragging` here is for. Without it a fader fights the hand
 * holding it.
 *
 * **It sends while it moves, not on release.** Last write wins and the bridge coalesces
 * to one patch per 100 ms, so a stream of positions is not a queue building up — it is
 * what makes the wedge follow the finger instead of jumping when it lets go.
 *
 * **The cap is where the desk says it is.** The 0..1 level *is* the physical fader
 * position, so drawing it as a fraction of the travel puts unity at three quarters up —
 * where it is on the desk, and where Mixing Station puts it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { FADER_UNITY, dbToFader, formatDb } from '@/audio/fader';
import { DRAG_SEND_INTERVAL_MS } from './useMixerSession';

/**
 * Cap height, full and compact.
 *
 * It is deliberately not scaled down as far as the strip is: the cap is the thing a finger
 * has to land on, and a short panel does not make thumbs smaller. Shrinking it only enough
 * to keep the proportions honest is the compromise.
 */
const CAP_HEIGHT = 26;
const CAP_HEIGHT_COMPACT = 20;

/**
 * The dB marks printed beside the track.
 *
 * Without them a fader is a handle on a blank strip: you can see it moved, but not how far
 * or how close it is to unity, and the number underneath only tells you where you ended
 * up. These are the same marks that are silk-screened on the desk, so the phone and the
 * hardware read alike.
 *
 * The compact set is shorter rather than smaller — a bottom panel gives the track a third
 * of the height, and eight labels in that space is a grey smear rather than a scale.
 */
const SCALE_DB = [10, 0, -10, -20, -30, -50];
const SCALE_DB_COMPACT = [10, 0, -10, -30];

/** Width of the gutter the marks live in, kept clear of the cap so neither obscures the other. */
const SCALE_WIDTH = 15;
const SCALE_WIDTH_COMPACT = 13;

/**
 * How far a touch must travel before it counts as grabbing the fader.
 *
 * Nothing is sent below this, which is what makes brushing a fader on the way past
 * harmless. On a forty-eight channel desk the strip row is always scrolled, and every
 * sideways swipe necessarily starts on top of a fader.
 */
const TOUCH_SLOP_PX = 6;

interface MixerFaderProps {
  level: number;
  onChange: (level: number) => void;
  /** Accent for the filled part of the track — the strip's own desk colour. */
  color: string;
  disabled?: boolean;
  /** Rendered under the fader; omitted when the caller shows the value elsewhere. */
  showValue?: boolean;
  /** Narrower track and a smaller cap, for the bottom-panel layout. */
  compact?: boolean;
  /**
   * This fader sits in the horizontally scrolling strip row, so a sideways swipe belongs
   * to the row and not to it. Off for the master, which is pinned and has no row to give
   * the gesture back to.
   */
  inScrollRow?: boolean;
}

export const MixerFader = ({ level, onChange, color, disabled, showValue = true, compact, inScrollRow }: MixerFaderProps) => {
  const capHeight = compact ? CAP_HEIGHT_COMPACT : CAP_HEIGHT;
  const scale = compact ? SCALE_DB_COMPACT : SCALE_DB;
  const scaleWidth = compact ? SCALE_WIDTH_COMPACT : SCALE_WIDTH;
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  /**
   * The same flag, readable *now*.
   *
   * The state drives rendering, but it cannot guard the handlers: a quick tap fires
   * `pointerdown` and `pointerup` inside one frame, so `pointerup` still closes over the
   * pre-tap render where `dragging` was false, bails out of `endDrag`, and leaves the
   * fader stuck in drag mode — ignoring the desk forever and showing a value that has
   * stopped tracking anything. A ref is current the moment it is written.
   */
  const draggingRef = useRef(false);
  /** A touch that has landed on the track but has not yet declared itself a drag. */
  const armedRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const [dragLevel, setDragLevel] = useState(level);
  const lastSentAtRef = useRef(0);
  const pendingRef = useRef<number | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const shown = dragging ? dragLevel : level;

  /** Pointer position → level, measured against the track's usable travel. */
  const levelFromEvent = useCallback(
    (clientY: number): number => {
      const track = trackRef.current;
      if (!track) return 0;
      const rect = track.getBoundingClientRect();
      // The cap has height, so its centre can only reach half of it from either end;
      // ignoring that makes the top and bottom of the travel unreachable by a few pixels.
      const usable = Math.max(1, rect.height - capHeight);
      const y = clientY - rect.top - capHeight / 2;
      return Math.max(0, Math.min(1, 1 - y / usable));
    },
    [capHeight],
  );

  /**
   * Rate-limit what goes on the wire without ever dropping the last position.
   *
   * A plain throttle loses the final move of a sweep — the fader stops under the finger
   * and the desk is left a few dB away from it. The pending value is flushed on release.
   */
  const emit = useCallback((next: number, force = false) => {
    const now = Date.now();
    if (!force && now - lastSentAtRef.current < DRAG_SEND_INTERVAL_MS) {
      pendingRef.current = next;
      return;
    }
    lastSentAtRef.current = now;
    pendingRef.current = null;
    onChangeRef.current(next);
  }, []);

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const next = levelFromEvent(event.clientY);
    draggingRef.current = true;
    setDragging(true);
    setDragLevel(next);
    emit(next, true);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    // A mouse or a pen means it the moment it goes down — there is no other gesture it
    // could turn into — so a click still jumps the fader as it always has. A touch is
    // ambiguous until it moves, and is held back below.
    if (!inScrollRow || event.pointerType !== 'touch') {
      beginDrag(event);
      return;
    }
    armedRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (draggingRef.current) {
      const next = levelFromEvent(event.clientY);
      setDragLevel(next);
      emit(next);
      return;
    }
    // A touch that has landed but not yet said what it is. `touch-action: pan-x` means the
    // browser claims a sideways swipe for the strip row on its own and cancels us, but it
    // does that *after* the first moves — so the direction is settled here too, and until
    // it is settled nothing reaches the desk.
    const armed = armedRef.current;
    if (!armed || armed.id !== event.pointerId) return;
    const dx = Math.abs(event.clientX - armed.x);
    const dy = Math.abs(event.clientY - armed.y);
    if (dx < TOUCH_SLOP_PX && dy < TOUCH_SLOP_PX) return;
    armedRef.current = null;
    // Sideways wins the tie. Scrolling the row is what people are usually doing, and a
    // fader that has not moved yet costs nothing to let go of.
    if (dx >= dy) return;
    beginDrag(event);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    armedRef.current = null;
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const pending = pendingRef.current;
    if (pending !== null) emit(pending, true);
  };

  // A throttled move that landed inside the window must still reach the desk even if the
  // pointer is lifted outside this element (scrolled away, a phone's palm rejection).
  useEffect(() => {
    if (dragging) return;
    const pending = pendingRef.current;
    if (pending === null) return;
    pendingRef.current = null;
    onChangeRef.current(pending);
  }, [dragging]);

  const percent = shown * 100;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, minHeight: 0, width: '100%' }}>
      <Box
        ref={trackRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        // Snap to unity: the one value anybody ever wants exactly, and fiddly to hit.
        onDoubleClick={() => !disabled && onChangeRef.current(FADER_UNITY)}
        sx={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          width: compact ? 38 : 46,
          // `pan-x` hands sideways swipes back to the strip row while keeping vertical
          // ones — the browser will not scroll a row on an axis it has been given, and
          // `none` gave it neither, so a fader under the finger swallowed every attempt to
          // scroll to the next channel. The master, which is pinned, still takes both.
          touchAction: inScrollRow ? 'pan-x' : 'none',
          cursor: disabled ? 'default' : 'ns-resize',
          opacity: disabled ? 0.4 : 1,
          userSelect: 'none',
        }}
      >
        {/* Track */}
        <Box
          sx={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            // Centred in what is left once the scale has its gutter, so the cap and the
            // marks sit side by side instead of on top of one another.
            left: `calc((100% - ${scaleWidth}px) / 2)`,
            width: 10,
            ml: '-5px',
            borderRadius: 5,
            backgroundColor: 'rgba(0,0,0,0.55)',
            border: '1px solid rgba(255,255,255,0.08)',
            overflow: 'hidden',
          }}
        >
          <Box
            sx={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: `${percent}%`,
              backgroundColor: color,
              opacity: 0.85,
              transition: dragging ? 'none' : 'height 90ms linear',
            }}
          />
        </Box>

        {/* The scale. Purely decorative, so it never eats a drag. */}
        <Box sx={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: scaleWidth, pointerEvents: 'none' }}>
          {scale.map((db) => (
            <Box
              key={db}
              sx={{
                position: 'absolute',
                right: 0,
                // The taper decides where a mark goes, not the number — which is the whole
                // point of drawing them: the gaps are uneven, and that is what a fader
                // actually does.
                bottom: `${dbToFader(db) * 100}%`,
                display: 'flex',
                alignItems: 'center',
                gap: '2px',
                transform: 'translateY(50%)',
              }}
            >
              <Box sx={{ width: 3, height: '1px', backgroundColor: 'rgba(255,255,255,0.28)' }} />
              <Box
                sx={{
                  fontSize: compact ? '0.46rem' : '0.5rem',
                  lineHeight: 1,
                  fontVariantNumeric: 'tabular-nums',
                  color: db === 0 ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.32)',
                  fontWeight: db === 0 ? 700 : 400,
                }}
              >
                {db > 0 ? `+${db}` : db}
              </Box>
            </Box>
          ))}
        </Box>

        {/* Unity, drawn across the track as well — it is the one mark worth finding
            without reading anything. */}
        <Box
          sx={{
            position: 'absolute',
            left: 2,
            right: scaleWidth,
            bottom: `calc(${FADER_UNITY * 100}% - 1px)`,
            height: '1px',
            backgroundColor: 'rgba(255,255,255,0.25)',
            pointerEvents: 'none',
          }}
        />

        {/* Cap */}
        <Box
          sx={{
            position: 'absolute',
            left: `calc((100% - ${scaleWidth}px) / 2)`,
            transform: 'translateX(-50%)',
            bottom: `calc(${percent}% - ${capHeight / 2}px)`,
            width: compact ? 24 : 30,
            height: capHeight,
            borderRadius: 1,
            background: 'linear-gradient(180deg, #6d7278 0%, #3a3e43 48%, #2a2d31 52%, #4a4e54 100%)',
            border: '1px solid rgba(0,0,0,0.6)',
            boxShadow: dragging ? '0 0 0 2px rgba(255,255,255,0.25)' : '0 2px 5px rgba(0,0,0,0.5)',
            pointerEvents: 'none',
            transition: dragging ? 'none' : 'bottom 90ms linear',
            '&::after': {
              content: '""',
              position: 'absolute',
              left: 4,
              right: 4,
              top: '50%',
              height: '2px',
              marginTop: '-1px',
              backgroundColor: 'rgba(255,255,255,0.55)',
              borderRadius: 1,
            },
          }}
        />
      </Box>

      {showValue && (
        <Typography
          variant="caption"
          sx={{
            mt: compact ? 0.25 : 0.5,
            fontVariantNumeric: 'tabular-nums',
            fontSize: compact ? '0.6rem' : '0.65rem',
            color: dragging ? 'primary.light' : 'text.secondary',
            lineHeight: 1.2,
          }}
        >
          {formatDb(shown)}
        </Typography>
      )}
    </Box>
  );
};
