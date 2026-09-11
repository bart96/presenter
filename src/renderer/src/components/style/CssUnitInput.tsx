import { useState, useCallback, useRef } from 'react';
import {
  Box,
  ClickAwayListener,
  InputAdornment,
  MenuItem,
  Paper,
  Popper,
  Select,
  Slider,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { Straighten as StraightenIcon } from '@mui/icons-material';
import { useI18nContext } from '@/i18n/i18n-react';
import { CSS_UNITS, cssUnitHint, splitLength, stepValue, type CssUnit } from '@/components/style/cssUnits';

/** Parse a CSS value like "4vh" into { num: 4, unit: 'vh' }. */
const parseCssValue: (value: string) => { num: number; unit: CssUnit } = (value) => {
  const split = splitLength(value);
  if (split) return split;
  const num = parseFloat(value);
  if (!isNaN(num)) return { num, unit: 'px' };
  return { num: 0, unit: 'px' };
};

/** Default slider range per unit. */
const getDefaultRange: (unit: CssUnit) => { min: number; max: number; step: number } = (unit) => {
  switch (unit) {
    case 'px':
      return { min: 0, max: 200, step: 1 };
    case 'pt':
      return { min: 0, max: 144, step: 1 };
    case 'em':
      return { min: 0, max: 10, step: 0.1 };
    case 'rem':
      return { min: 0, max: 10, step: 0.1 };
    case 'vh':
    case 'vw':
    case 'vmin':
    case 'vmax':
      return { min: 0, max: 100, step: 0.5 };
    case '%':
      return { min: 0, max: 100, step: 1 };
    default:
      return { min: 0, max: 200, step: 1 };
  }
};

interface CssUnitInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Restrict available units. Default: all. */
  units?: CssUnit[];
  /** Width of the whole component */
  width?: number;
  placeholder?: string;
  /** Optional label shown above the input */
  label?: string;
  /** Custom range overrides per unit, e.g. { vmin: { min: 0, max: 50 } } */
  unitRanges?: Partial<Record<CssUnit, { min?: number; max?: number; step?: number }>>;
}

/**
 * Compact CSS size input: [number field + tune icon endadornment] [unit selector]
 * Clicking the tune icon opens a vertical slider Popper (no background).
 */
export const CssUnitInput = ({
  value,
  onChange,
  units = [...CSS_UNITS],
  width = 150,
  placeholder,
  label,
  unitRanges,
}: CssUnitInputProps) => {
  const { LL } = useI18nContext();
  const [sliderOpen, setSliderOpen] = useState(false);
  const tuneRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Read straight from `value` on every render. The number and unit used to be copied into state
  // and kept in step by an effect, which set state again after every single change — holding an
  // arrow key queued those updates faster than they could render, until React gave up with
  // "Maximum update depth exceeded".
  const { num, unit } = parseCssValue(value);

  /** The last value sent up, and the `value` it was worked out from. */
  const sentRef = useRef<{ from: string; to: string } | null>(null);

  /**
   * What an edit starts from. Key repeat can outrun rendering, so while a change is still on its
   * way up and `value` has not caught up, that change is the base — otherwise every press in the
   * burst would start from the same stale number and only the last one would count.
   */
  const current = () => parseCssValue(sentRef.current && sentRef.current.from === value ? sentRef.current.to : value);

  const emit = useCallback(
    (n: number, u: CssUnit) => {
      const formatted = Number.isInteger(n) ? `${n}${u}` : `${parseFloat(n.toFixed(2))}${u}`;
      sentRef.current = { from: value, to: formatted };
      onChange(formatted);
    },
    [onChange, value],
  );

  const handleNumChange = (n: number) => emit(n, current().unit);
  const handleUnitChange = (u: CssUnit) => emit(current().num, u);

  const defaults = getDefaultRange(unit);
  const overrides = unitRanges?.[unit] ?? {};
  const range = { min: overrides.min ?? defaults.min, max: overrides.max ?? defaults.max, step: overrides.step ?? defaults.step };

  return (
    <Stack
      spacing={0}
      sx={{
        alignItems: 'center',
        width,
        display: 'inline-flex',
      }}
    >
      {label && (
        <Typography
          variant="caption"
          sx={{
            color: 'text.secondary',
            mb: 0.25,
            display: 'block',
            textAlign: 'center',
          }}
        >
          {label}
        </Typography>
      )}
      <Stack direction="row" spacing={0} sx={{ width: '100%' }}>
        <TextField
          ref={inputRef}
          size="small"
          type="number"
          value={num}
          onChange={(e) => handleNumChange(parseFloat(e.target.value) || 0)}
          onKeyDown={(e) => {
            // Arrow keys step by the unit's own increment (see keyboardStep). Left to the native
            // number input they would use the slider step and snap to its grid instead.
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            e.preventDefault();
            const base = current();
            emit(stepValue(base.num, base.unit, e.key === 'ArrowUp' ? 1 : -1), base.unit);
          }}
          placeholder={placeholder}
          slotProps={{
            htmlInput: { step: range.step },
            input: {
              endAdornment: (
                <InputAdornment position="end">
                  <Box
                    ref={tuneRef}
                    component="span"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSliderOpen((v) => !v);
                    }}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      cursor: 'pointer',
                      color: 'text.secondary',
                      visibility: sliderOpen ? 'hidden' : 'visible',
                      '&:hover': { color: 'primary.main' },
                    }}
                  >
                    <StraightenIcon sx={{ fontSize: 16 }} />
                  </Box>
                </InputAdornment>
              ),
            },
          }}
          sx={{
            flex: 1,
            minWidth: 80,
            '& .MuiOutlinedInput-root': { borderTopRightRadius: 0, borderBottomRightRadius: 0 },
            '& input::-webkit-outer-spin-button, & input::-webkit-inner-spin-button': { WebkitAppearance: 'none', margin: 0 },
            '& input[type=number]': { MozAppearance: 'textfield' },
          }}
        />
        <Select
          size="small"
          value={unit}
          onChange={(e) => handleUnitChange(e.target.value as CssUnit)}
          sx={{
            minWidth: 62,
            '& .MuiOutlinedInput-notchedOutline': { borderLeft: 0, borderTopLeftRadius: 0, borderBottomLeftRadius: 0 },
          }}
          renderValue={(v) => (
            <Typography
              variant="caption"
              sx={{
                fontWeight: 600,
              }}
            >
              {v}
            </Typography>
          )}
        >
          {units.map((u) => (
            <MenuItem key={u} value={u} sx={{ fontSize: '0.8rem', gap: 1.5 }}>
              <Box component="span" sx={{ fontWeight: 600, minWidth: 34 }}>
                {u}
              </Box>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {cssUnitHint(LL, u)}
              </Typography>
            </MenuItem>
          ))}
        </Select>
      </Stack>
      <Popper open={sliderOpen} anchorEl={tuneRef.current} placement="top-end" style={{ zIndex: 1400 }}>
        <ClickAwayListener onClickAway={() => setSliderOpen(false)}>
          <Paper elevation={0} sx={{ bgcolor: 'transparent', p: 0 }}>
            <Box sx={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', mx: -1, my: -1 }}>
              <Slider
                orientation="vertical"
                size="small"
                min={range.min}
                max={range.max}
                step={range.step}
                value={num}
                onChange={(_, v) => handleNumChange(v as number)}
                valueLabelDisplay="auto"
                valueLabelFormat={(v) => `${v}${unit}`}
                sx={{ height: '100%' }}
              />
            </Box>
          </Paper>
        </ClickAwayListener>
      </Popper>
    </Stack>
  );
};
