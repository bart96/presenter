/**
 * The Behringer fader taper: 0..1 on the wire, decibels on screen.
 *
 * A verbatim port of Streamer's `utils/src/fader.ts`, kept identical on purpose. The
 * audio bridge sends the desk's own 0..1 fader position and leaves the dB conversion to
 * both ends (see the bridge contract §5.1); the moment the two sides convert their own
 * way, the operator's screen and the musician's phone disagree about what "-6 dB" means
 * and neither is obviously wrong.
 *
 * The relationship is piecewise linear over four segments, steepest at the bottom, so the
 * useful part of the travel gets most of the fader. A straight line is wrong everywhere
 * except the two ends.
 *
 * The anchor is hardware-confirmed: a channel at unity reports `0.7497556209564209`,
 * which is step 767 of the desk's 1024 and the 0.75 → 0 dB point below.
 */

/** Fader positions where the taper changes slope, with their dB values. */
const SEGMENTS: { from: number; scale: number; offset: number }[] = [
  { from: 0.5, scale: 40, offset: -30 }, // 0.5 → -10 dB … 1.0 → +10 dB
  { from: 0.25, scale: 80, offset: -50 }, // 0.25 → -30 dB
  { from: 0.0625, scale: 160, offset: -70 }, // 0.0625 → -60 dB
  { from: 0, scale: 480, offset: -90 }, // 0 → -90 dB, which the desk calls -∞
];

/** Quietest dB the taper expresses before the fader is simply off. */
export const FADER_MIN_DB = -90;
export const FADER_MAX_DB = 10;

/** Unity gain, and where a fader wants to snap back to on a double tap. */
export const FADER_UNITY = 0.7497556209564209;

/**
 * A fader position as decibels. A closed fader is `-Infinity`, not -90: the desk is
 * silent there, and printing a number invites someone to type it back.
 */
export const faderToDb = (level: number): number => {
  if (!Number.isFinite(level) || level <= 0) return -Infinity;

  const clamped = Math.min(1, level);
  const segment = SEGMENTS.find(({ from }) => clamped >= from) ?? SEGMENTS[SEGMENTS.length - 1];

  return clamped * segment.scale + segment.offset;
};

/**
 * Decibels back to a fader position — the exact inverse of {@link faderToDb}, so a typed
 * value and the fader it moves agree to the desk's own resolution.
 */
export const dbToFader = (db: number): number => {
  if (!Number.isFinite(db) || db <= FADER_MIN_DB) return 0;

  const capped = Math.min(FADER_MAX_DB, db);
  const segment = SEGMENTS.find(({ from, scale, offset }) => capped >= from * scale + offset) ?? SEGMENTS[SEGMENTS.length - 1];

  return Math.max(0, Math.min(1, (capped - segment.offset) / segment.scale));
};

/**
 * How a level is written wherever it is shown.
 *
 * One spelling everywhere, because a fader reading `-6 dB` in one app and `-6.0dB` in
 * another looks like two different numbers at a glance.
 */
export const formatDb = (level: number): string => {
  const db = faderToDb(level);
  if (db === -Infinity) return '-∞';

  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
};
