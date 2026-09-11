/**
 * MixerMeter — one level bar, drawn without re-rendering.
 *
 * Meters arrive at 10 Hz. Routing them through React state would re-render a column of
 * strips ten times a second on a phone that is also holding a PDF in memory, to move a
 * bar a few pixels. So the bar subscribes to the meter feed itself and writes its own
 * `transform`, and React never hears about it after mount.
 *
 * The peak marker is the part that makes a meter readable at 10 Hz rather than 50: with
 * only ten frames a second a transient can fall between two of them, and a bar alone
 * makes a snare look quieter than it is. The marker holds the highest recent value and
 * falls slowly, so the eye catches what the samples nearly missed.
 */
import { memo, useEffect, useRef } from 'react';
import { Box } from '@mui/material';
import type { AudioMeters } from '@/audio/protocol';
import type { MetersHandler } from './useMixerSession';

/** How far the peak marker falls per frame — about 1.5 s from full scale to silence. */
const PEAK_DECAY = 0.07;

interface MixerMeterProps {
  /** Strip or mix id, as the meter frame keys it. */
  id: string;
  /** Which half of the frame to read. */
  source: 'strips' | 'mixes';
  onMeters: (handler: MetersHandler) => () => void;
  width?: number;
}

export const MixerMeter = memo(({ id, source, onMeters, width = 6 }: MixerMeterProps) => {
  const barRef = useRef<HTMLDivElement | null>(null);
  const peakRef = useRef<HTMLDivElement | null>(null);
  const peakValueRef = useRef(0);

  useEffect(() => {
    peakValueRef.current = 0;
    const handler = (frame: AudioMeters) => {
      const value = frame[source][id];
      const bar = barRef.current;
      const peak = peakRef.current;
      // An id the desk publishes no meter for is simply absent from the frame; leaving
      // the bar where it was would be a stuck reading, so it is treated as silence.
      const level = typeof value === 'number' ? Math.max(0, Math.min(1, value)) : 0;

      if (bar) bar.style.transform = `scaleY(${level})`;

      peakValueRef.current = level > peakValueRef.current ? level : Math.max(level, peakValueRef.current - PEAK_DECAY);
      if (peak) peak.style.bottom = `${peakValueRef.current * 100}%`;
    };
    return onMeters(handler);
  }, [id, source, onMeters]);

  return (
    <Box
      sx={{
        position: 'relative',
        width,
        flexShrink: 0,
        borderRadius: 0.5,
        overflow: 'hidden',
        backgroundColor: 'rgba(0,0,0,0.55)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <Box
        ref={barRef}
        sx={{
          position: 'absolute',
          inset: 0,
          transformOrigin: 'bottom',
          transform: 'scaleY(0)',
          // Green up to roughly -12 dBFS, amber into the last few, red at the top: the
          // gradient is fixed to the track, so the colour a bar reaches IS its level.
          background: 'linear-gradient(to top, #24b35e 0%, #24b35e 62%, #d9b528 82%, #e04a3f 100%)',
          transition: 'transform 90ms linear',
        }}
      />
      <Box
        ref={peakRef}
        sx={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: '2px',
          backgroundColor: 'rgba(255,255,255,0.85)',
          pointerEvents: 'none',
        }}
      />
    </Box>
  );
});

MixerMeter.displayName = 'MixerMeter';
