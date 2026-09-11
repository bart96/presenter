import { Autocomplete, Chip, Stack, TextField, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import { Group as BandIcon } from '@mui/icons-material';
import { useI18nContext } from '@/i18n/i18n-react';
import { useBands } from '@/hooks/useBands';
import type { Band } from '@/api/bands.api';

/**
 * Assigning bands to a show or a set list, and showing which ones are assigned.
 *
 * Both are multi-select: two bands sharing one service is normal, and a set list is often
 * worked from by a whole team. A band's own colour tints its chip so the same band is
 * recognisable at a glance wherever it appears.
 */

/** A band's chip tint: its own colour as a wash, or the theme default when it has none. */
const bandChipSx = (color: string | null) =>
  color
    ? {
        bgcolor: alpha(color, 0.18),
        borderColor: alpha(color, 0.6),
        color: 'text.primary',
      }
    : undefined;

export const BandChip = ({ band, size = 'small', onDelete }: { band: Band; size?: 'small' | 'medium'; onDelete?: () => void }) => (
  <Chip
    size={size}
    variant="outlined"
    icon={<BandIcon sx={{ fontSize: '0.9rem' }} />}
    label={band.name}
    onDelete={onDelete}
    sx={{ maxWidth: 180, ...bandChipSx(band.color) }}
  />
);

/**
 * Read-only display of an assignment. Renders nothing at all when there is none, so callers
 * can drop it into a row without guarding it themselves.
 */
export const BandChips = ({ bandIds, max = 3 }: { bandIds?: number[]; max?: number }) => {
  const { resolve } = useBands();
  const bands = resolve(bandIds);

  if (bands.length === 0) return null;

  const shown = bands.slice(0, max);
  const rest = bands.length - shown.length;

  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', flexShrink: 0, minWidth: 0 }}>
      {shown.map((band) => (
        <BandChip key={band.id} band={band} />
      ))}
      {rest > 0 && (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          +{rest}
        </Typography>
      )}
    </Stack>
  );
};

interface BandPickerProps {
  /** Currently assigned band ids. */
  value: number[];
  onChange: (bandIds: number[]) => void;
  label?: string;
  disabled?: boolean;
  /** Shown under the field when the account has no bands yet. */
  emptyHint?: boolean;
}

export const BandPicker = ({ value, onChange, label, disabled, emptyHint = true }: BandPickerProps) => {
  const { LL } = useI18nContext();
  const { bands, resolve } = useBands();

  // Bands whose id no longer resolves are dropped rather than shown as blanks — the row is
  // already gone from the server's answer, so keeping it would only offer a broken chip.
  const selected = resolve(value);

  if (bands.length === 0 && emptyHint) {
    return (
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {LL.BANDS.NONE_YET()}
      </Typography>
    );
  }

  return (
    <Autocomplete
      multiple
      size="small"
      disabled={disabled}
      options={bands}
      value={selected}
      isOptionEqualToValue={(option, chosen) => option.id === chosen.id}
      getOptionLabel={(band) => band.name}
      onChange={(_e, next) => onChange(next.map((band) => band.id))}
      renderValue={(chosen, getItemProps) =>
        chosen.map((band, index) => {
          const { key, ...itemProps } = getItemProps({ index });
          return (
            <Chip
              key={key}
              {...itemProps}
              size="small"
              variant="outlined"
              icon={<BandIcon sx={{ fontSize: '0.9rem' }} />}
              label={band.name}
              sx={bandChipSx(band.color)}
            />
          );
        })
      }
      renderOption={(props, band) => (
        // The members double as the disambiguator when two bands are named alike.
        <li {...props} key={band.id}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
            <BandChip band={band} />
            {band.members.length > 0 && (
              <Typography variant="caption" noWrap sx={{ color: 'text.secondary', minWidth: 0 }}>
                {band.members.join(', ')}
              </Typography>
            )}
          </Stack>
        </li>
      )}
      renderInput={(params) => (
        <TextField {...params} label={label ?? LL.BANDS.ASSIGN_LABEL()} placeholder={LL.BANDS.ASSIGN_PLACEHOLDER()} />
      )}
    />
  );
};
