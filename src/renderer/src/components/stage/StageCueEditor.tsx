/**
 * The editor for one cue, and the format control shared by all of them.
 *
 * The format control is the interesting part. Most operators want "a clock, with or without
 * seconds" and should never meet a pattern; a few want `EEE dd.MM. HH:mm` and should not be
 * denied it. So presets and a seconds switch are the surface, and the pattern field only
 * appears once *Custom…* is chosen — pre-filled with the preset that was showing, so expert
 * mode starts from something that already works rather than an empty box.
 */
import { useMemo } from 'react';
import {
  Alert,
  Box,
  Chip,
  FormControlLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { useI18nContext } from '@/i18n/i18n-react';
import type { StageCue } from '@/stage/types';
import {
  DURATION_PRESET_PATTERNS,
  LDML_TOKENS,
  clockPattern,
  formatClockPattern,
  formatDuration,
  parseTimeOfDay,
  validateClockPattern,
  validateDurationPattern,
  type ClockFormat,
  type ClockPreset,
  type DurationFormat,
  type DurationPreset,
} from '@/utils/timeFormat';

type Patch = (patch: Partial<StageCue>) => void;

/**
 * The name of a cue kind. A switch rather than an index into LL, because typesafe-i18n types
 * each key as its own function and a computed key defeats that entirely.
 */
export const cueKindLabel = (kind: StageCue['kind'], LL: ReturnType<typeof useI18nContext>['LL']): string => {
  switch (kind) {
    case 'clock':
      return LL.STAGE.CUE_CLOCK();
    case 'countdown':
      return LL.STAGE.CUE_COUNTDOWN();
    case 'countup':
      return LL.STAGE.CUE_COUNTUP();
    case 'message':
      return LL.STAGE.CUE_MESSAGE();
    case 'blank':
      return LL.STAGE.CUE_BLANK();
  }
};

// ── Format controls ───────────────────────────────────────────────────────────

const CLOCK_PRESETS: Array<{
  value: ClockPreset;
  labelKey: 'PRESET_TIME24' | 'PRESET_TIME12' | 'PRESET_DATE_TIME' | 'PRESET_WEEKDAY_TIME';
}> = [
  { value: 'time24', labelKey: 'PRESET_TIME24' },
  { value: 'time12', labelKey: 'PRESET_TIME12' },
  { value: 'dateTime', labelKey: 'PRESET_DATE_TIME' },
  { value: 'weekdayTime', labelKey: 'PRESET_WEEKDAY_TIME' },
];

const DURATION_PRESETS: Array<{ value: DurationPreset; labelKey: 'DURATION_AUTO' | 'DURATION_MMSS' | 'DURATION_HMMSS' }> = [
  { value: 'auto', labelKey: 'DURATION_AUTO' },
  { value: 'mmss', labelKey: 'DURATION_MMSS' },
  { value: 'hmmss', labelKey: 'DURATION_HMMSS' },
];

/** The pattern cheat-sheet, shown only in custom mode where it is actually needed. */
const TokenReference = () => {
  const { LL } = useI18nContext();
  const meaning = (m: (typeof LDML_TOKENS)[number]['meaning']): string => {
    switch (m) {
      case 'hour24':
        return LL.STAGE.TOKEN_HOUR24();
      case 'hour12':
        return LL.STAGE.TOKEN_HOUR12();
      case 'minute':
        return LL.STAGE.TOKEN_MINUTE();
      case 'second':
        return LL.STAGE.TOKEN_SECOND();
      case 'dayPeriod':
        return LL.STAGE.TOKEN_DAY_PERIOD();
      case 'day':
        return LL.STAGE.TOKEN_DAY();
      case 'month':
        return LL.STAGE.TOKEN_MONTH();
      case 'year':
        return LL.STAGE.TOKEN_YEAR();
      case 'weekday':
        return LL.STAGE.TOKEN_WEEKDAY();
      case 'literal':
        return LL.STAGE.TOKEN_LITERAL();
    }
  };

  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
      {LDML_TOKENS.map((t) => (
        <Tooltip key={t.token} title={`${meaning(t.meaning)} — ${t.example}`}>
          <Chip label={t.token} size="small" variant="outlined" sx={{ height: 20, fontSize: '0.62rem', fontFamily: 'monospace' }} />
        </Tooltip>
      ))}
    </Box>
  );
};

/** Turns the validator's findings into a sentence the operator can act on. */
const PatternWarnings = ({ problems }: { problems: ReturnType<typeof validateClockPattern> }) => {
  const { LL } = useI18nContext();
  if (problems.length === 0) return null;
  return (
    <Stack spacing={0.5}>
      {problems.map((p, i) => (
        <Alert key={i} severity={p.kind === 'minutesVsMonths' ? 'warning' : 'info'} sx={{ py: 0, fontSize: '0.75rem' }}>
          {p.kind === 'minutesVsMonths'
            ? LL.STAGE.WARN_MINUTES_VS_MONTHS()
            : p.kind === 'unknownTokens'
              ? LL.STAGE.WARN_UNKNOWN_TOKENS({ letters: p.letters.join(', ') })
              : LL.STAGE.WARN_NO_FIELDS()}
        </Alert>
      ))}
    </Stack>
  );
};

const ClockFormatControl = ({ format, onChange }: { format: ClockFormat; onChange: (f: ClockFormat) => void }) => {
  const { LL } = useI18nContext();
  const pattern = clockPattern(format);
  const problems = useMemo(() => (format.preset === 'custom' ? validateClockPattern(format.pattern) : []), [format]);
  const preview = useMemo(() => formatClockPattern(new Date(), pattern), [pattern]);

  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Select
          size="small"
          value={format.preset}
          onChange={(e) => {
            const next = e.target.value as ClockPreset | 'custom';
            // Carry the pattern that was showing into custom mode, so switching to expert
            // never means starting from a blank field.
            if (next === 'custom') onChange({ preset: 'custom', pattern });
            else onChange({ preset: next, seconds: format.preset === 'custom' ? false : format.seconds });
          }}
          sx={{ flex: 1 }}
        >
          {CLOCK_PRESETS.map((p) => (
            <MenuItem key={p.value} value={p.value}>
              {LL.STAGE[p.labelKey]()}
            </MenuItem>
          ))}
          <MenuItem value="custom">{LL.STAGE.PRESET_CUSTOM()}</MenuItem>
        </Select>
        {format.preset !== 'custom' && (
          <FormControlLabel
            control={
              <Switch size="small" checked={!!format.seconds} onChange={(e) => onChange({ ...format, seconds: e.target.checked })} />
            }
            label={<Typography variant="caption">{LL.STAGE.SHOW_SECONDS()}</Typography>}
          />
        )}
      </Stack>

      {format.preset === 'custom' && (
        <Stack spacing={1}>
          <TextField
            size="small"
            label={LL.STAGE.CUSTOM_PATTERN()}
            value={format.pattern}
            onChange={(e) => onChange({ preset: 'custom', pattern: e.target.value })}
            helperText={LL.STAGE.PATTERN_HELP()}
            slotProps={{ input: { sx: { fontFamily: 'monospace' } } }}
          />
          <TokenReference />
          <PatternWarnings problems={problems} />
        </Stack>
      )}

      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {LL.STAGE.PATTERN_PREVIEW()}: <strong>{preview}</strong>
      </Typography>
    </Stack>
  );
};

const DurationFormatControl = ({ format, onChange }: { format: DurationFormat; onChange: (f: DurationFormat) => void }) => {
  const { LL } = useI18nContext();
  const problems = useMemo(() => (format.preset === 'custom' ? validateDurationPattern(format.pattern) : []), [format]);
  // Four and a half minutes: long enough to show the shape, short enough that `auto` still
  // demonstrates dropping the hours group.
  const preview = formatDuration(272_000, format);

  return (
    <Stack spacing={1}>
      <Select
        size="small"
        value={format.preset}
        onChange={(e) => {
          const next = e.target.value as DurationPreset | 'custom';
          if (next === 'custom') {
            onChange({ preset: 'custom', pattern: format.preset === 'auto' ? 'm:ss' : DURATION_PRESET_PATTERNS[format.preset] });
          } else {
            onChange({ preset: next });
          }
        }}
      >
        {DURATION_PRESETS.map((p) => (
          <MenuItem key={p.value} value={p.value}>
            {LL.STAGE[p.labelKey]()}
          </MenuItem>
        ))}
        <MenuItem value="custom">{LL.STAGE.PRESET_CUSTOM()}</MenuItem>
      </Select>

      {format.preset === 'custom' && (
        <Stack spacing={1}>
          <TextField
            size="small"
            label={LL.STAGE.CUSTOM_PATTERN()}
            value={format.pattern}
            onChange={(e) => onChange({ preset: 'custom', pattern: e.target.value })}
            slotProps={{ input: { sx: { fontFamily: 'monospace' } } }}
          />
          <PatternWarnings problems={problems} />
        </Stack>
      )}

      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {LL.STAGE.PATTERN_PREVIEW()}: <strong>{preview}</strong>
      </Typography>
    </Stack>
  );
};

// ── Cue editor ────────────────────────────────────────────────────────────────

export const StageCueEditor = ({ cue, onChange }: { cue: StageCue; onChange: Patch }) => {
  const { LL } = useI18nContext();

  const timeError = cue.kind === 'countdown' && cue.source === 'timeOfDay' && !!cue.atTime && parseTimeOfDay(cue.atTime) === null;

  return (
    <Stack spacing={1.5}>
      <TextField
        size="small"
        label={LL.STAGE.CUE_NAME()}
        value={cue.name ?? ''}
        onChange={(e) => onChange({ name: e.target.value || undefined })}
        placeholder={cueKindLabel(cue.kind, LL)}
      />

      {cue.kind === 'clock' && <ClockFormatControl format={cue.format} onChange={(format) => onChange({ format } as Partial<StageCue>)} />}

      {cue.kind === 'countdown' && (
        <>
          <ToggleButtonGroup
            size="small"
            exclusive
            fullWidth
            value={cue.source}
            onChange={(_e, v: 'duration' | 'timeOfDay' | null) => v && onChange({ source: v } as Partial<StageCue>)}
          >
            <ToggleButton value="duration" sx={{ textTransform: 'none' }}>
              {LL.STAGE.SOURCE_DURATION()}
            </ToggleButton>
            <ToggleButton value="timeOfDay" sx={{ textTransform: 'none' }}>
              {LL.STAGE.SOURCE_TIME_OF_DAY()}
            </ToggleButton>
          </ToggleButtonGroup>

          {cue.source === 'duration' ? (
            <Stack direction="row" spacing={1}>
              <TextField
                size="small"
                type="number"
                label={LL.STAGE.MINUTES()}
                value={Math.floor((cue.durationSec ?? 0) / 60)}
                onChange={(e) =>
                  onChange({ durationSec: Math.max(0, Number(e.target.value)) * 60 + ((cue.durationSec ?? 0) % 60) } as Partial<StageCue>)
                }
                sx={{ flex: 1 }}
              />
              <TextField
                size="small"
                type="number"
                label={LL.STAGE.SECONDS()}
                value={(cue.durationSec ?? 0) % 60}
                onChange={(e) =>
                  onChange({
                    durationSec: Math.floor((cue.durationSec ?? 0) / 60) * 60 + Math.max(0, Math.min(59, Number(e.target.value))),
                  } as Partial<StageCue>)
                }
                sx={{ flex: 1 }}
              />
            </Stack>
          ) : (
            <TextField
              size="small"
              label={LL.STAGE.AT_TIME()}
              value={cue.atTime ?? ''}
              placeholder="10:00"
              error={timeError}
              helperText={timeError ? 'HH:mm' : LL.STAGE.AT_TIME_HINT()}
              onChange={(e) => onChange({ atTime: e.target.value } as Partial<StageCue>)}
            />
          )}

          <DurationFormatControl format={cue.format} onChange={(format) => onChange({ format } as Partial<StageCue>)} />

          <Select size="small" value={cue.onZero} onChange={(e) => onChange({ onZero: e.target.value } as Partial<StageCue>)}>
            <MenuItem value="hold">{LL.STAGE.ON_ZERO_HOLD()}</MenuItem>
            <MenuItem value="countUp">{LL.STAGE.ON_ZERO_COUNT_UP()}</MenuItem>
            <MenuItem value="next">{LL.STAGE.ON_ZERO_NEXT()}</MenuItem>
            <MenuItem value="hide">{LL.STAGE.ON_ZERO_HIDE()}</MenuItem>
          </Select>

          <Stack direction="row" spacing={1}>
            <TextField
              size="small"
              type="number"
              label={`${LL.STAGE.WARN_AT()} (s)`}
              value={cue.warnSec ?? ''}
              onChange={(e) => onChange({ warnSec: e.target.value === '' ? undefined : Number(e.target.value) } as Partial<StageCue>)}
              sx={{ flex: 1 }}
            />
            <TextField
              size="small"
              type="number"
              label={`${LL.STAGE.DANGER_AT()} (s)`}
              value={cue.dangerSec ?? ''}
              onChange={(e) => onChange({ dangerSec: e.target.value === '' ? undefined : Number(e.target.value) } as Partial<StageCue>)}
              sx={{ flex: 1 }}
            />
          </Stack>
        </>
      )}

      {cue.kind === 'countup' && (
        <DurationFormatControl format={cue.format} onChange={(format) => onChange({ format } as Partial<StageCue>)} />
      )}

      {(cue.kind === 'countdown' || cue.kind === 'countup') && (
        <TextField
          size="small"
          label={LL.STAGE.LABEL()}
          value={cue.label ?? ''}
          helperText={LL.STAGE.LABEL_HINT()}
          onChange={(e) => onChange({ label: e.target.value || undefined } as Partial<StageCue>)}
        />
      )}

      {cue.kind === 'message' && (
        <TextField
          size="small"
          label={LL.STAGE.TEXT()}
          value={cue.text}
          multiline
          minRows={2}
          onChange={(e) => onChange({ text: e.target.value } as Partial<StageCue>)}
        />
      )}

      {(cue.kind === 'message' || cue.kind === 'blank') && (
        <TextField
          size="small"
          type="number"
          label={`${LL.STAGE.AUTO_NEXT()} (s)`}
          value={cue.autoNextSec ?? ''}
          placeholder={LL.STAGE.AUTO_NEXT_NEVER()}
          onChange={(e) => onChange({ autoNextSec: e.target.value === '' ? undefined : Number(e.target.value) } as Partial<StageCue>)}
        />
      )}
    </Stack>
  );
};
