/**
 * The stage monitor, as it appears on a presentation window.
 *
 * This component owns the only clock in the system. The operator sends absolute timestamps
 * when a cue *changes*; the ticking happens here, locally, so a running countdown costs no
 * traffic at all and every window it is on shows the same number without anything having to
 * keep them in step.
 *
 * Sizes are percentages of the overlay's own measured height, so one layer definition looks
 * right on a 1280×720 confidence monitor and a 3840×2160 wall alike — and, because the
 * reference is the container rather than the viewport, the editor's small preview box renders
 * a faithful miniature instead of screen-sized text. (`vh` cannot do that: it is always
 * viewport-relative, whatever it is nested inside.)
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { renderStageCue, stageUrgency, type StageAnchor, type StageLayerWire, type StageOverlayPayload } from '@/stage/types';

/**
 * How often the display re-reads the clock.
 *
 * Four times a second: fast enough that a seconds digit never looks like it skipped, cheap
 * enough to be irrelevant next to a background video. It is a plain interval rather than an
 * animation frame because these windows are often on a screen nobody is looking at, and a
 * backgrounded rAF stops firing.
 */
const TICK_MS = 250;

/** Above the content and the copyright, below the identify overlay (9999). */
const STAGE_Z_INDEX = 500;

const anchorStyles = (anchor: StageAnchor, marginPct: number, widthPct: number): CSSProperties => {
  const [vertical, horizontal] = anchor.split(' ') as ['top' | 'center' | 'bottom', 'left' | 'center' | 'right'];
  const margin = `${marginPct}%`;
  const style: CSSProperties = { position: 'absolute', width: `${widthPct}%` };

  if (vertical === 'top') style.top = margin;
  else if (vertical === 'bottom') style.bottom = margin;
  else {
    style.top = '50%';
    style.transform = 'translateY(-50%)';
  }

  if (horizontal === 'left') style.left = margin;
  else if (horizontal === 'right') style.right = margin;
  else {
    style.left = '50%';
    // Compose rather than overwrite — a centre-centre layer needs both translations.
    style.transform = style.transform ? `${style.transform} translateX(-50%)` : 'translateX(-50%)';
  }

  return style;
};

/** Layer text colour, letting a countdown's thresholds override the resting colour. */
const colorFor = (layer: StageLayerWire, remainingSec: number | null): string => {
  const { style, cue } = layer;
  if (!cue) return style.color;
  switch (stageUrgency(cue, remainingSec)) {
    case 'danger':
      return style.dangerColor || style.color;
    case 'warn':
      return style.warnColor || style.color;
    default:
      return style.color;
  }
};

const StageLayerView = ({ layer, now, height }: { layer: StageLayerWire; now: number; height: number }) => {
  const { cue, style, placement } = layer;
  if (!cue) return null;

  const { text, label, remainingSec } = renderStageCue(cue, now);

  const hasPanel = !!style.background && (style.backgroundOpacity ?? 0) > 0;
  /** A percentage of the overlay height, in px. */
  const px = (pct: number) => `${(height * pct) / 100}px`;

  return (
    <div
      style={{
        ...anchorStyles(placement.anchor, placement.marginPct, placement.widthPct),
        display: 'flex',
        flexDirection: 'column',
        alignItems: style.textAlign === 'left' ? 'flex-start' : style.textAlign === 'right' ? 'flex-end' : 'center',
        gap: px(0.4),
        padding: hasPanel ? `${px(1.2)} ${px(1.6)}` : 0,
      }}
    >
      {/* The panel is its own layer so its translucency applies to the backdrop alone —
          putting the opacity on the container would fade the digits with it. */}
      {hasPanel && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundColor: style.background,
            opacity: style.backgroundOpacity,
            borderRadius: px(0.8),
          }}
        />
      )}
      {label && (
        <div
          style={{
            position: 'relative',
            fontFamily: style.fontFamily,
            // Captions sit at a third of the digits — readable, never competing.
            fontSize: px(Math.max(1.2, style.fontSizePct / 3)),
            color: style.color,
            opacity: 0.75,
            textAlign: style.textAlign ?? 'center',
            width: '100%',
            lineHeight: 1.2,
          }}
        >
          {label}
        </div>
      )}
      <div
        style={{
          position: 'relative',
          fontFamily: style.fontFamily,
          fontSize: px(style.fontSizePct),
          fontWeight: style.bold ? 700 : 400,
          color: colorFor(layer, remainingSec),
          textAlign: style.textAlign ?? 'center',
          width: '100%',
          lineHeight: 1.1,
          // Digits must not reflow as they change width, or the whole line jitters once a
          // second. Tabular figures are exactly the fix, and harmless on a message.
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          transition: 'color 300ms ease-in-out',
        }}
      >
        {text}
      </div>
    </div>
  );
};

export const StageOverlay = ({ payload }: { payload?: StageOverlayPayload }) => {
  const layers = payload?.layers ?? [];
  // Only the presence of a live value justifies a timer; a payload of nothing but messages
  // does not need to wake this component up four times a second.
  const needsTick = layers.some((l) => l.cue && (l.cue.kind === 'clock' || (l.cue.kind === 'timer' && !l.cue.frozenAt)));

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!needsTick) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [needsTick]);

  /**
   * The overlay's own height, which every size is a percentage of.
   *
   * Measured rather than assumed: on a presentation window it is the viewport, but in the
   * stage editor's preview it is a small box, and the same layer has to look like itself in
   * both. Seeded from the viewport so the first paint is already close on the real thing.
   */
  const rootRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(() => (typeof window !== 'undefined' ? window.innerHeight : 1080));
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setHeight(el.clientHeight || window.innerHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [layers.length]);

  if (layers.length === 0) return null;

  return (
    <div ref={rootRef} style={{ position: 'absolute', inset: 0, zIndex: STAGE_Z_INDEX, pointerEvents: 'none', overflow: 'hidden' }}>
      {layers.map((layer) => (
        <StageLayerView key={layer.id} layer={layer} now={now} height={height} />
      ))}
    </div>
  );
};
