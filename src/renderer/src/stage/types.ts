/**
 * Stage-monitor layers, cues, and the payload the presentation windows receive.
 *
 * Kept free of every dependency — no RTK, no MUI, no store — because the presentation
 * window is its own bundle and imports the wire types and the resolver from here.
 * `api/stage.api.ts` re-exports these so callers have one place to import from.
 */
import {
  type ClockFormat,
  type DurationFormat,
  DEFAULT_CLOCK_FORMAT,
  DEFAULT_DURATION_FORMAT,
  clockPattern,
  formatClockPattern,
  formatDuration,
  nextOccurrence,
} from '@/utils/timeFormat';

// ── Cues ──────────────────────────────────────────────────────────────────────

export type StageCueKind = 'clock' | 'countdown' | 'countup' | 'message' | 'blank';

interface StageCueCommon {
  /** Stable within the layer; show-item triggers use it to name a specific cue. */
  id: string;
  /** Optional operator-facing name. The cue list falls back to describing the kind. */
  name?: string;
}

/** Wall-clock time. Never finishes, so it never auto-advances. */
export interface StageClockCue extends StageCueCommon {
  kind: 'clock';
  format: ClockFormat;
}

/**
 * Counts down to zero, from a fixed length or towards a time of day.
 *
 * `onZero` is the interesting part: hold at 0:00, keep counting into overtime (which is
 * what a speaker overrunning looks like), hand over to the next cue, or disappear.
 */
export interface StageCountdownCue extends StageCueCommon {
  kind: 'countdown';
  source: 'duration' | 'timeOfDay';
  /** For `source: 'duration'`. */
  durationSec?: number;
  /** For `source: 'timeOfDay'`, as `HH:mm`; the next occurrence is used. */
  atTime?: string;
  onZero: 'hold' | 'countUp' | 'next' | 'hide';
  format: DurationFormat;
  /** Seconds remaining at which the colour changes. Danger wins over warn. */
  warnSec?: number;
  dangerSec?: number;
  /** Small caption above the digits ("Countdown to service"). */
  label?: string;
}

/** Counts up from the moment it started. */
export interface StageCountupCue extends StageCueCommon {
  kind: 'countup';
  format: DurationFormat;
  label?: string;
}

/** Static text, optionally handing over to the next cue on its own. */
export interface StageMessageCue extends StageCueCommon {
  kind: 'message';
  text: string;
  autoNextSec?: number;
}

/** Shows nothing. A deliberate gap, so Go still has somewhere to land. */
export interface StageBlankCue extends StageCueCommon {
  kind: 'blank';
  autoNextSec?: number;
}

export type StageCue = StageClockCue | StageCountdownCue | StageCountupCue | StageMessageCue | StageBlankCue;

// ── Layers ────────────────────────────────────────────────────────────────────

export type StageAnchor =
  'top left' | 'top center' | 'top right' | 'center left' | 'center' | 'center right' | 'bottom left' | 'bottom center' | 'bottom right';

/** Where on the output the layer sits. Percentages, so it scales to any resolution. */
export interface StagePlacement {
  anchor: StageAnchor;
  /** Width of the band, as a percentage of the output width. */
  widthPct: number;
  /** Distance from the anchored edges, as a percentage of the output's shorter side. */
  marginPct: number;
}

export interface StageLayerStyle {
  fontFamily?: string;
  /** Font size as a percentage of the output *height*, so it scales with the screen. */
  fontSizePct: number;
  color: string;
  bold?: boolean;
  /** Panel behind the text. Omitted = fully transparent. */
  background?: string;
  backgroundOpacity?: number;
  textAlign?: 'left' | 'center' | 'right';
  /** Colours a countdown switches to at its warn / danger thresholds. */
  warnColor?: string;
  dangerColor?: string;
}

export interface StageLayerData {
  placement: StagePlacement;
  style: StageLayerStyle;
  cues: StageCue[];
}

export interface StageLayerEntity {
  id: number;
  name: string;
  enabled: boolean;
  sort_order: number;
  data: StageLayerData;
  created_at?: string;
  updated_at?: string;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

export const DEFAULT_STAGE_PLACEMENT: StagePlacement = { anchor: 'bottom center', widthPct: 60, marginPct: 6 };

export const DEFAULT_STAGE_STYLE: StageLayerStyle = {
  fontSizePct: 12,
  color: '#FFFFFF',
  bold: true,
  backgroundOpacity: 0,
  textAlign: 'center',
  warnColor: '#FFB300',
  dangerColor: '#E53935',
};

export const emptyStageLayerData = (): StageLayerData => ({
  placement: { ...DEFAULT_STAGE_PLACEMENT },
  style: { ...DEFAULT_STAGE_STYLE },
  cues: [],
});

/** Cue ids only need to be unique inside their layer. */
export const newCueId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `cue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** A fresh cue of the given kind, with the defaults an operator would otherwise have to fill in. */
export const newCue = (kind: StageCueKind): StageCue => {
  const id = newCueId();
  switch (kind) {
    case 'clock':
      return { id, kind, format: { ...DEFAULT_CLOCK_FORMAT } };
    case 'countdown':
      return {
        id,
        kind,
        source: 'duration',
        durationSec: 300,
        onZero: 'hold',
        format: { ...DEFAULT_DURATION_FORMAT },
        warnSec: 60,
        dangerSec: 10,
      };
    case 'countup':
      return { id, kind, format: { ...DEFAULT_DURATION_FORMAT } };
    case 'message':
      return { id, kind, text: '' };
    case 'blank':
      return { id, kind };
  }
};

// ── When a cue ends ───────────────────────────────────────────────────────────

/**
 * When the current cue is due to hand over, as an epoch timestamp — or null if it never
 * does. This is what the engine arms a single timer on, and it is the only reason the
 * operator process needs a timer at all: everything else is arithmetic the windows do
 * for themselves.
 */
export const cueEndsAt = (cue: StageCue, startedAt: number): number | null => {
  switch (cue.kind) {
    case 'countdown':
      if (cue.onZero !== 'next' && cue.onZero !== 'hide') return null;
      return countdownTarget(cue, startedAt);
    case 'message':
    case 'blank':
      return cue.autoNextSec && cue.autoNextSec > 0 ? startedAt + cue.autoNextSec * 1000 : null;
    default:
      return null;
  }
};

/** Whether a cue finishes on its own. A clock never does; a countdown that holds does not either. */
export const cueAutoAdvances = (cue: StageCue): boolean => cueEndsAt(cue, 0) !== null;

/**
 * The instant a countdown reaches zero.
 *
 * A time-of-day target resolves against the moment the cue *started*, not against "now",
 * so the target cannot slide forward a day while the cue is already running.
 */
export const countdownTarget = (cue: StageCountdownCue, startedAt: number): number => {
  if (cue.source === 'timeOfDay' && cue.atTime) {
    return nextOccurrence(cue.atTime, startedAt) ?? startedAt;
  }
  return startedAt + (cue.durationSec ?? 0) * 1000;
};

// ── Wire format ───────────────────────────────────────────────────────────────

/**
 * What a presentation window is told about a cue.
 *
 * Only absolute timestamps travel — never a tick and never a rendered value. The window
 * derives the number it shows from `anchor` and its own clock, so a running countdown
 * costs exactly one message when it starts and one when it changes, instead of one per
 * second through the content pipeline.
 */
export type StageCueWire =
  | { kind: 'clock'; pattern: string; locale: string }
  | {
      kind: 'timer';
      direction: 'down' | 'up';
      /** Epoch ms the span is measured against: the zero point for `down`, the start for `up`. */
      anchor: number;
      /** Set while paused — the window renders this instant instead of the current one. */
      frozenAt?: number;
      /** Stop at zero instead of continuing into negative numbers. */
      clampAtZero: boolean;
      format: DurationFormat;
      warnSec?: number;
      dangerSec?: number;
      label?: string;
    }
  | { kind: 'message'; text: string };

export interface StageLayerWire {
  id: number;
  placement: StagePlacement;
  style: StageLayerStyle;
  /** Resolved cue, or absent when the layer currently shows nothing. */
  cue?: StageCueWire;
}

export interface StageOverlayPayload {
  layers: StageLayerWire[];
}

export const EMPTY_STAGE_PAYLOAD: StageOverlayPayload = { layers: [] };

/** Runtime position of one layer, as the store holds it. */
export interface StageCueRuntime {
  cueIndex: number;
  startedAt: number;
  pausedAt?: number;
  hidden: boolean;
}

/**
 * Turn one cue plus its runtime position into the wire form, or null when there is
 * nothing to show (a blank cue, an empty message, a sequence that has run out).
 */
export const resolveCue = (cue: StageCue, runtime: StageCueRuntime, locale: string): StageCueWire | null => {
  switch (cue.kind) {
    case 'clock':
      return { kind: 'clock', pattern: clockPattern(cue.format), locale };

    case 'countdown': {
      const target = countdownTarget(cue, runtime.startedAt);
      return {
        kind: 'timer',
        direction: 'down',
        anchor: target,
        frozenAt: runtime.pausedAt,
        // 'next' and 'hide' are handed over by the engine the moment they hit zero, so
        // whatever they show in the meantime should not go negative either.
        clampAtZero: cue.onZero !== 'countUp',
        format: cue.format,
        warnSec: cue.warnSec,
        dangerSec: cue.dangerSec,
        label: cue.label,
      };
    }

    case 'countup':
      return {
        kind: 'timer',
        direction: 'up',
        anchor: runtime.startedAt,
        frozenAt: runtime.pausedAt,
        clampAtZero: true,
        format: cue.format,
        label: cue.label,
      };

    case 'message':
      return cue.text.trim() ? { kind: 'message', text: cue.text } : null;

    case 'blank':
      return null;
  }
};

/**
 * Build the payload for a set of layers.
 *
 * A layer contributes nothing when it is disabled, hidden, blanked by the global switch,
 * or parked past the end of its cue list — in every case it is simply absent from
 * `layers`, so the window has one rule to follow: draw what you are given.
 */
export const resolveStagePayload = (
  layers: StageLayerEntity[],
  runtimes: Record<number, StageCueRuntime>,
  allHidden: boolean,
  locale: string,
): StageOverlayPayload => {
  if (allHidden) return { layers: [] };

  const wire: StageLayerWire[] = [];
  for (const layer of layers) {
    if (!layer.enabled) continue;
    const runtime = runtimes[layer.id];
    if (!runtime || runtime.hidden) continue;

    const cue = layer.data.cues[runtime.cueIndex];
    if (!cue) continue;

    const resolved = resolveCue(cue, runtime, locale);
    if (!resolved) continue;

    wire.push({ id: layer.id, placement: layer.data.placement, style: layer.data.style, cue: resolved });
  }
  return { layers: wire };
};

/**
 * Render a wire cue at a given instant.
 *
 * Shared so the beamer and the operator's own transport chip cannot disagree: one produces
 * the number the congregation sees, the other the number the operator is reading off, and a
 * second implementation would eventually round differently.
 */
export const renderStageCue = (
  cue: StageCueWire,
  now: number,
  locale?: string,
): { text: string; label?: string; remainingSec: number | null } => {
  if (cue.kind === 'clock') {
    return { text: formatClockPattern(new Date(now), cue.pattern, locale ?? cue.locale), remainingSec: null };
  }
  if (cue.kind === 'message') {
    return { text: cue.text, remainingSec: null };
  }
  // A paused cue reads its frozen instant instead of the live one, so the digits hold.
  const at = cue.frozenAt ?? now;
  const raw = cue.direction === 'down' ? cue.anchor - at : at - cue.anchor;
  const value = cue.clampAtZero ? Math.max(0, raw) : raw;
  return {
    text: formatDuration(value, cue.format),
    label: cue.label,
    // Rounded up, so the display reads 1 for the whole of the last second rather than
    // sitting on 0 while a second still remains.
    remainingSec: cue.direction === 'down' ? Math.ceil(raw / 1000) : null,
  };
};

/** Which threshold a countdown has crossed, if any — drives the colour on every surface. */
export const stageUrgency = (cue: StageCueWire, remainingSec: number | null): 'normal' | 'warn' | 'danger' => {
  if (cue.kind !== 'timer' || cue.direction !== 'down' || remainingSec === null) return 'normal';
  // Danger wins: at 5 seconds left both thresholds are met and the more urgent one is meant.
  if (cue.dangerSec !== undefined && remainingSec <= cue.dangerSec) return 'danger';
  if (cue.warnSec !== undefined && remainingSec <= cue.warnSec) return 'warn';
  return 'normal';
};
