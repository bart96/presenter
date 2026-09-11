/**
 * Stage-monitor clock and duration formatting.
 *
 *   node test/timeformat/run.mjs
 *
 * `src/renderer/src/utils/timeFormat.ts` renders every value the stage monitor puts on a
 * beamer. Its failure mode is quiet: a pattern that means the wrong thing (`HH:MM` is
 * hours-and-months, not hours-and-minutes) still renders something plausible-looking, and
 * nobody notices until it is on the wall in front of a congregation.
 *
 * These checks pin down the LDML subset, the difference between a wall clock and an elapsed
 * span — where `H` is *total* hours and the largest unit present absorbs everything above it
 * — and the validator that catches the minutes-versus-months slip.
 *
 * The module has no imports of its own, so it is bundled straight to plain node.
 */
import { build } from 'esbuild';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const dir = mkdtempSync(join(tmpdir(), 'timeformat-'));

await build({
  entryPoints: ['src/renderer/src/utils/timeFormat.ts'],
  bundle: true,
  format: 'esm',
  outdir: dir,
  platform: 'node',
});

const T = await import(pathToFileURL(join(dir, 'timeFormat.js')).href);

let failed = 0;
const eq = (name, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    failed++;
    console.log(`FAIL ${name}\n  got  ${a}\n  want ${b}`);
  } else {
    console.log(`ok   ${name}`);
  }
};

// A fixed local wall-clock moment: Saturday 4 March 2028, 09:05:07.
// Constructed from local parts on purpose — the formatter reads local getters, so building
// this from a UTC string would make the expectations depend on the runner's timezone.
const d = new Date(2028, 2, 4, 9, 5, 7);
// The same instant in the afternoon, for the 12-hour and day-period cases.
const pm = new Date(2028, 2, 4, 21, 5, 7);

// ── Clock patterns ────────────────────────────────────────────────────────────

eq('24h without seconds', T.formatClockPattern(d, 'HH:mm'), '09:05');
eq('24h with seconds', T.formatClockPattern(d, 'HH:mm:ss'), '09:05:07');
eq('unpadded hour', T.formatClockPattern(d, 'H:mm'), '9:05');
eq('12h morning', T.formatClockPattern(d, 'h:mm'), '9:05');
eq('12h evening wraps', T.formatClockPattern(pm, 'h:mm'), '9:05');
eq('midnight is 12 in 12h', T.formatClockPattern(new Date(2028, 2, 4, 0, 30), 'h:mm'), '12:30');
eq('noon is 12 in 12h', T.formatClockPattern(new Date(2028, 2, 4, 12, 30), 'h:mm'), '12:30');
eq('numeric date', T.formatClockPattern(d, 'dd.MM.yyyy'), '04.03.2028');
eq('two-digit year', T.formatClockPattern(d, 'yy'), '28');
eq('unpadded day and month', T.formatClockPattern(d, 'd.M.'), '4.3.');

// Locale-dependent names come from Intl, so assert against Intl rather than hard-coding
// English — that is exactly the coupling the German UI depends on.
const monthShort = (locale) => new Intl.DateTimeFormat(locale, { month: 'short' }).format(d);
const weekdayShort = (locale) => new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(d);
eq('short month follows locale (en)', T.formatClockPattern(d, 'MMM', 'en'), monthShort('en'));
eq('short month follows locale (de)', T.formatClockPattern(d, 'MMM', 'de'), monthShort('de'));
eq('short weekday follows locale (de)', T.formatClockPattern(d, 'EEE', 'de'), weekdayShort('de'));
eq('long weekday follows locale (de)', T.formatClockPattern(d, 'EEEE', 'de'), new Intl.DateTimeFormat('de', { weekday: 'long' }).format(d));
eq('day period is non-empty', T.formatClockPattern(pm, 'a', 'en').length > 0, true);

// The German date-and-time pattern from the plan, end to end.
eq('composite German pattern', T.formatClockPattern(d, 'EEE dd.MM. HH:mm', 'de'), `${weekdayShort('de')} 04.03. 09:05`);

// ── Quoting ───────────────────────────────────────────────────────────────────

eq('quoted literal is not a token', T.formatClockPattern(d, "HH:mm 'Uhr'"), '09:05 Uhr');
eq('doubled quote is an apostrophe', T.formatClockPattern(d, "HH'''"), "09'");
eq('separators pass through', T.formatClockPattern(d, 'HH-mm/ss'), '09-05/07');
// An unknown letter renders as itself rather than vanishing, so a typo is visible on screen
// instead of silently shortening the output.
eq('unknown letter passes through', T.formatClockPattern(d, 'HH:mm Q'), '09:05 Q');

// ── Presets ───────────────────────────────────────────────────────────────────

eq('preset resolves without seconds', T.clockPattern({ preset: 'time24', seconds: false }), 'HH:mm');
eq('preset resolves with seconds', T.clockPattern({ preset: 'time24', seconds: true }), 'HH:mm:ss');
eq('12h preset carries the day period', T.clockPattern({ preset: 'time12', seconds: false }), 'h:mm a');
eq('custom preset is the pattern itself', T.clockPattern({ preset: 'custom', pattern: 'EEE' }), 'EEE');
eq('formatClock goes through the preset', T.formatClock(d, { preset: 'time24', seconds: true }), '09:05:07');

// ── Durations ─────────────────────────────────────────────────────────────────

const s = (n) => n * 1000;

eq('mm:ss', T.formatDurationPattern(s(272), 'mm:ss'), '04:32');
eq('m:ss unpadded', T.formatDurationPattern(s(272), 'm:ss'), '4:32');
eq('zero', T.formatDurationPattern(0, 'mm:ss'), '00:00');
eq('sub-second rounds down', T.formatDurationPattern(999, 'mm:ss'), '00:00');
eq('exactly one minute', T.formatDurationPattern(s(60), 'mm:ss'), '01:00');
eq('hours split out', T.formatDurationPattern(s(3661), 'HH:mm:ss'), '01:01:01');

// The largest unit in the pattern absorbs everything above it — the property that makes
// `mm:ss` safe to use for a 90-minute timer instead of silently showing 30 minutes.
eq('minutes absorb hours when no hour field', T.formatDurationPattern(s(5400), 'mm:ss'), '90:00');
eq('seconds absorb everything', T.formatDurationPattern(s(125), 'ss'), '125');

// Overtime: a countdown past zero counts up with a minus sign.
eq('negative gets a sign', T.formatDurationPattern(s(-5), 'mm:ss'), '-00:05');
eq('negative hours', T.formatDurationPattern(s(-3661), 'HH:mm:ss'), '-01:01:01');

// `auto` drops the hours group until it is needed — the reason it exists.
eq('auto under an hour', T.formatDuration(s(272), { preset: 'auto' }), '4:32');
eq('auto at exactly one hour', T.formatDuration(s(3600), { preset: 'auto' }), '1:00:00');
eq('auto just under an hour', T.formatDuration(s(3599), { preset: 'auto' }), '59:59');
eq('auto negative past an hour', T.formatDuration(s(-3600), { preset: 'auto' }), '-1:00:00');
eq('auto pattern under an hour', T.durationPattern({ preset: 'auto' }, s(60)), 'm:ss');
eq('auto pattern over an hour', T.durationPattern({ preset: 'auto' }, s(7200)), 'H:mm:ss');

// ── Validation ────────────────────────────────────────────────────────────────

const kinds = (problems) => problems.map((p) => p.kind);

eq('a good clock pattern is clean', kinds(T.validateClockPattern('HH:mm:ss')), []);
eq('HH:MM is flagged', kinds(T.validateClockPattern('HH:MM')), ['minutesVsMonths']);
eq('HH:MM:ss is flagged', kinds(T.validateClockPattern('HH:MM:ss')), ['minutesVsMonths']);
// A real date pattern uses MM legitimately and must not be nagged about it.
eq('dd.MM.yyyy is not flagged', kinds(T.validateClockPattern('dd.MM.yyyy HH:mm')), []);
eq('MMM is not flagged', kinds(T.validateClockPattern('dd. MMM HH:mm')), []);
eq('unknown letters are reported', kinds(T.validateClockPattern('HH:mm Q')), ['unknownTokens']);
eq('which letters', T.validateClockPattern('HH:mm QZ')[0].letters, ['Q', 'Z']);
eq('a pattern with no fields is reported', kinds(T.validateClockPattern("'just text'")), ['noFields']);
// Duration patterns accept a narrower set: a date field in an elapsed span is meaningless.
eq('duration rejects date fields', kinds(T.validateDurationPattern('dd HH:mm')), ['unknownTokens']);
eq('duration accepts H:mm:ss', kinds(T.validateDurationPattern('H:mm:ss')), []);

// ── Time-of-day targets ───────────────────────────────────────────────────────

eq('parses HH:mm', T.parseTimeOfDay('10:30'), { hours: 10, minutes: 30, seconds: 0 });
eq('parses with seconds', T.parseTimeOfDay('10:30:15'), { hours: 10, minutes: 30, seconds: 15 });
eq('tolerates a single-digit hour', T.parseTimeOfDay('9:05'), { hours: 9, minutes: 5, seconds: 0 });
eq('trims', T.parseTimeOfDay(' 10:30 '), { hours: 10, minutes: 30, seconds: 0 });
eq('rejects out-of-range hour', T.parseTimeOfDay('24:00'), null);
eq('rejects out-of-range minute', T.parseTimeOfDay('10:60'), null);
eq('rejects nonsense', T.parseTimeOfDay('half past ten'), null);

const at = (h, m) => new Date(2028, 2, 4, h, m, 0).getTime();
eq('a later time today', T.nextOccurrence('10:00', at(9, 0)), at(10, 0));
// A target already past rolls to tomorrow, so a countdown to 10:00 set at 10:05 means
// tomorrow morning rather than minus five minutes.
eq('a passed time rolls to tomorrow', T.nextOccurrence('10:00', at(10, 5)), at(10, 0) + 24 * 3600 * 1000);
eq('the exact same minute rolls too', T.nextOccurrence('10:00', at(10, 0)), at(10, 0) + 24 * 3600 * 1000);
eq('an unparseable target is null', T.nextOccurrence('nope'), null);

console.log(failed ? `\n${failed} failing` : '\nall passing');
process.exit(failed ? 1 : 0);
