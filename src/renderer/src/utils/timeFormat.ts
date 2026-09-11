/**
 * Clock and duration formatting for the stage monitor.
 *
 * Patterns follow the **Unicode LDML date field symbols** (tr35) — the same spelling
 * date-fns, ICU and Java use, so `HH:mm:ss` means what an operator who has met any of
 * those expects. Only a documented subset is implemented; see `LDML_TOKENS`.
 *
 * Deliberately dependency-free. The project ships no date library, and this module is
 * imported by the presentation window, which is its own bundle and must stay small. It
 * also runs on a 250 ms tick, so every `Intl` formatter is created once and cached.
 */

// ── Public format shapes ──────────────────────────────────────────────────────

export type ClockPreset = 'time24' | 'time12' | 'dateTime' | 'weekdayTime';
export type DurationPreset = 'auto' | 'mmss' | 'hmmss';

export type ClockFormat = { preset: ClockPreset; seconds?: boolean } | { preset: 'custom'; pattern: string };

export type DurationFormat = { preset: DurationPreset } | { preset: 'custom'; pattern: string };

export const DEFAULT_CLOCK_FORMAT: ClockFormat = { preset: 'time24', seconds: false };
export const DEFAULT_DURATION_FORMAT: DurationFormat = { preset: 'auto' };

/**
 * Presets, as the patterns they stand for. The operator who just wants a clock picks one
 * of these plus the seconds switch; the pattern is what "Custom…" starts from, so moving
 * to expert mode never begins from a blank field.
 */
export const CLOCK_PRESET_PATTERNS: Record<ClockPreset, { base: string; withSeconds: string }> = {
  time24: { base: 'HH:mm', withSeconds: 'HH:mm:ss' },
  time12: { base: 'h:mm a', withSeconds: 'h:mm:ss a' },
  dateTime: { base: 'dd.MM.yyyy HH:mm', withSeconds: 'dd.MM.yyyy HH:mm:ss' },
  weekdayTime: { base: 'EEE HH:mm', withSeconds: 'EEE HH:mm:ss' },
};

export const DURATION_PRESET_PATTERNS: Record<Exclude<DurationPreset, 'auto'>, string> = {
  mmss: 'mm:ss',
  hmmss: 'HH:mm:ss',
};

/** Resolve a clock format to its pattern. */
export const clockPattern = (format: ClockFormat): string =>
  format.preset === 'custom' ? format.pattern : CLOCK_PRESET_PATTERNS[format.preset][format.seconds ? 'withSeconds' : 'base'];

/**
 * Resolve a duration format to its pattern. `auto` is resolved against the value, because
 * its whole point is to drop the hours group until there are hours to show — a 5-minute
 * countdown reads `04:32`, not `00:04:32`.
 */
export const durationPattern = (format: DurationFormat, ms: number): string => {
  if (format.preset === 'custom') return format.pattern;
  if (format.preset === 'auto') return Math.abs(ms) >= 3_600_000 ? 'H:mm:ss' : 'm:ss';
  return DURATION_PRESET_PATTERNS[format.preset];
};

// ── Token reference (also rendered as the editor's cheat-sheet) ────────────────

export interface LdmlToken {
  token: string;
  /** i18n key suffix under STAGE.TOKEN_* — kept out of this module so it stays UI-free. */
  meaning: 'hour24' | 'hour12' | 'minute' | 'second' | 'dayPeriod' | 'day' | 'month' | 'year' | 'weekday' | 'literal';
  example: string;
}

export const LDML_TOKENS: LdmlToken[] = [
  { token: 'H, HH', meaning: 'hour24', example: '9, 09' },
  { token: 'h, hh', meaning: 'hour12', example: '9, 09' },
  { token: 'm, mm', meaning: 'minute', example: '5, 05' },
  { token: 's, ss', meaning: 'second', example: '7, 07' },
  { token: 'a', meaning: 'dayPeriod', example: 'AM' },
  { token: 'd, dd', meaning: 'day', example: '4, 04' },
  { token: 'M, MM, MMM, MMMM', meaning: 'month', example: '3, 03, Mar, March' },
  { token: 'y, yy, yyyy', meaning: 'year', example: '2026, 26, 2026' },
  { token: 'E, EEE, EEEE', meaning: 'weekday', example: 'Sat, Saturday' },
  { token: "'text'", meaning: 'literal', example: "'Uhr' → Uhr" },
];

// ── Cached Intl formatters ────────────────────────────────────────────────────

const intlCache = new Map<string, Intl.DateTimeFormat>();

const intl = (locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => {
  const key = `${locale}|${JSON.stringify(options)}`;
  let fmt = intlCache.get(key);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat(locale, options);
    } catch {
      fmt = new Intl.DateTimeFormat('en', options);
    }
    intlCache.set(key, fmt);
  }
  return fmt;
};

const namedPart = (date: Date, locale: string, options: Intl.DateTimeFormatOptions, part: Intl.DateTimeFormatPartTypes): string =>
  intl(locale, options)
    .formatToParts(date)
    .find((p) => p.type === part)?.value ?? '';

const pad = (n: number, width: number): string => String(Math.abs(n)).padStart(width, '0');

// ── Tokenizer ─────────────────────────────────────────────────────────────────

type Chunk = { kind: 'token'; letter: string; count: number } | { kind: 'literal'; text: string };

/**
 * Split a pattern into runs of the same letter, quoted literals and pass-through text.
 *
 * LDML quoting rules: `'…'` is a literal, and `''` is a literal apostrophe (both inside and
 * outside a quoted run).
 */
export const tokenizePattern = (pattern: string): Chunk[] => {
  const chunks: Chunk[] = [];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "'") {
      if (pattern[i + 1] === "'") {
        chunks.push({ kind: 'literal', text: "'" });
        i += 2;
        continue;
      }
      let text = '';
      i++;
      while (i < pattern.length) {
        if (pattern[i] === "'") {
          if (pattern[i + 1] === "'") {
            text += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        text += pattern[i++];
      }
      chunks.push({ kind: 'literal', text });
      continue;
    }

    if (/[A-Za-z]/.test(ch)) {
      let count = 0;
      while (pattern[i] === ch) {
        count++;
        i++;
      }
      chunks.push({ kind: 'token', letter: ch, count });
      continue;
    }

    chunks.push({ kind: 'literal', text: ch });
    i++;
  }
  return chunks;
};

// ── Clock formatting ──────────────────────────────────────────────────────────

const formatClockToken = (date: Date, letter: string, count: number, locale: string): string | null => {
  const h24 = date.getHours();
  switch (letter) {
    case 'H':
      return pad(h24, count);
    case 'h': {
      const h = h24 % 12 === 0 ? 12 : h24 % 12;
      return pad(h, count);
    }
    case 'm':
      return pad(date.getMinutes(), count);
    case 's':
      return pad(date.getSeconds(), count);
    case 'a':
      return namedPart(date, locale, { hour: 'numeric', hour12: true }, 'dayPeriod');
    case 'd':
      return pad(date.getDate(), count);
    case 'M':
      if (count <= 2) return pad(date.getMonth() + 1, count);
      return namedPart(date, locale, { month: count === 3 ? 'short' : count === 4 ? 'long' : 'narrow' }, 'month');
    case 'y':
      return count === 2 ? pad(date.getFullYear() % 100, 2) : String(date.getFullYear());
    case 'E':
      return namedPart(date, locale, { weekday: count <= 3 ? 'short' : count === 4 ? 'long' : 'narrow' }, 'weekday');
    default:
      return null;
  }
};

/**
 * Render a wall-clock time. Unknown letters are passed through verbatim rather than
 * dropped, so a typo shows up on screen instead of silently vanishing.
 */
export const formatClockPattern = (date: Date, pattern: string, locale = 'en'): string =>
  tokenizePattern(pattern)
    .map((chunk) => {
      if (chunk.kind === 'literal') return chunk.text;
      return formatClockToken(date, chunk.letter, chunk.count, locale) ?? chunk.letter.repeat(chunk.count);
    })
    .join('');

export const formatClock = (date: Date, format: ClockFormat, locale = 'en'): string =>
  formatClockPattern(date, clockPattern(format), locale);

// ── Duration formatting ───────────────────────────────────────────────────────

/**
 * Render an elapsed or remaining span.
 *
 * The token letters are the same, but they mean something different from a wall clock:
 * `H` is *total* hours in the span, not the hour of the day, and the largest unit present
 * in the pattern absorbs everything above it — `mm:ss` on 90 minutes gives `90:00`, not
 * `30:00`. Negative spans (a countdown running into overtime) get a leading minus.
 */
export const formatDurationPattern = (ms: number, pattern: string): string => {
  const negative = ms < 0;
  const total = Math.floor(Math.abs(ms) / 1000);

  const chunks = tokenizePattern(pattern);
  const present = new Set(chunks.filter((c): c is Extract<Chunk, { kind: 'token' }> => c.kind === 'token').map((c) => c.letter));
  const hasHours = present.has('H') || present.has('h');
  const hasMinutes = present.has('m');

  const hours = hasHours ? Math.floor(total / 3600) : 0;
  const minutes = hasMinutes ? Math.floor((total - hours * 3600) / 60) : 0;
  const seconds = total - hours * 3600 - minutes * 60;

  const body = chunks
    .map((chunk) => {
      if (chunk.kind === 'literal') return chunk.text;
      switch (chunk.letter) {
        case 'H':
        case 'h':
          return pad(hours, chunk.count);
        case 'm':
          return pad(minutes, chunk.count);
        case 's':
          return pad(seconds, chunk.count);
        default:
          return chunk.letter.repeat(chunk.count);
      }
    })
    .join('');

  return negative ? `-${body}` : body;
};

export const formatDuration = (ms: number, format: DurationFormat): string => formatDurationPattern(ms, durationPattern(format, ms));

// ── Validation for the custom-pattern field ───────────────────────────────────

export type PatternProblem =
  /** `MM` where minutes were almost certainly meant — `mm` is minutes, `MM` is months. */
  | { kind: 'minutesVsMonths' }
  /** Letters that are not in the supported subset; they will render as themselves. */
  | { kind: 'unknownTokens'; letters: string[] }
  /** Nothing but literals — the cue would show a constant string. */
  | { kind: 'noFields' };

const CLOCK_LETTERS = new Set(['H', 'h', 'm', 's', 'a', 'd', 'M', 'y', 'E']);
const DURATION_LETTERS = new Set(['H', 'h', 'm', 's']);

const analyse = (pattern: string, allowed: Set<string>): PatternProblem[] => {
  const chunks = tokenizePattern(pattern);
  const tokens = chunks.filter((c): c is Extract<Chunk, { kind: 'token' }> => c.kind === 'token');
  const problems: PatternProblem[] = [];

  if (tokens.length === 0) problems.push({ kind: 'noFields' });

  const unknown = [...new Set(tokens.filter((t) => !allowed.has(t.letter)).map((t) => t.letter))];
  if (unknown.length > 0) problems.push({ kind: 'unknownTokens', letters: unknown });

  // The classic slip: writing the minutes field as `MM` because that is how it looks in a
  // sentence. It parses fine and quietly renders the month, so it is worth calling out.
  if (/[Hh]{1,2}\s*[:.]\s*M{1,2}(?![M])/.test(pattern) || /M{1,2}\s*[:.]\s*s{1,2}(?![s])/.test(pattern)) {
    problems.push({ kind: 'minutesVsMonths' });
  }

  return problems;
};

export const validateClockPattern = (pattern: string): PatternProblem[] => analyse(pattern, CLOCK_LETTERS);
export const validateDurationPattern = (pattern: string): PatternProblem[] => analyse(pattern, DURATION_LETTERS);

// ── Time-of-day helpers (countdown targets) ───────────────────────────────────

/** Parse `HH:mm` / `HH:mm:ss`. Returns null on anything else. */
export const parseTimeOfDay = (value: string): { hours: number; minutes: number; seconds: number } | null => {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  const seconds = m[3] ? Number(m[3]) : 0;
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return { hours, minutes, seconds };
};

/**
 * The next occurrence of a wall-clock time, as an epoch timestamp.
 *
 * A target that has already passed today rolls to tomorrow — a countdown to 10:00 set at
 * 10:05 means tomorrow morning, not minus five minutes.
 */
export const nextOccurrence = (value: string, from = Date.now()): number | null => {
  const parsed = parseTimeOfDay(value);
  if (!parsed) return null;
  const base = new Date(from);
  const target = new Date(base);
  target.setHours(parsed.hours, parsed.minutes, parsed.seconds, 0);
  if (target.getTime() <= from) target.setDate(target.getDate() + 1);
  return target.getTime();
};
