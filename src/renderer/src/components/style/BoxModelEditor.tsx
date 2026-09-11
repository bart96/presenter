import { useState } from 'react';
import { Box, IconButton, InputBase, MenuItem, Select, Stack, Tooltip, Typography } from '@mui/material';
import { RestartAlt as ResetIcon } from '@mui/icons-material';
import { useI18nContext } from '@/i18n/i18n-react';
import { formatBoxShorthand, parseBoxShorthand, type BoxSides } from '@/utils/cssBox';
import { CSS_UNITS, cssUnitHint, splitLength, stepValue, type CssUnit } from '@/components/style/cssUnits';

/** One nesting level of the box: the slide's own padding, or the padding around a paragraph. */
export type BoxLayer = {
  label: string;
  /** CSS shorthand as stored. */
  value: string;
  /** Whether this style sets it, or inherits it. */
  enabled: boolean;
  onChange: (value: string) => void;
  onReset: () => void;
  /** Shown behind the value when the style does not set it. */
  placeholder: string;
};

/** The unit a side starts in when neither it nor the value it inherits names one. */
const FALLBACK_UNIT: CssUnit = 'vh';
const PLAIN_NUMBER = /^-?\d*\.?\d+$/;

/**
 * One side of one box: its number and its unit, each in a control of its own.
 *
 * Arrow up/down step the number (see `keyboardStep`) and apply at once, so the preview follows
 * while the key is held. A typed value is committed on blur or Enter instead, so a half-typed
 * number is never written into the style. Something that is not a plain length — `auto`,
 * `calc(...)` — can still be typed into the number field and is kept exactly as typed.
 */
const SideInput = ({
  value,
  placeholder,
  dimmed,
  onCommit,
}: {
  /** The side's own value; empty when the style does not set this box. */
  value: string;
  /** The inherited value shown behind an empty side. */
  placeholder: string;
  dimmed: boolean;
  onCommit: (next: string) => void;
}) => {
  const { LL } = useI18nContext();
  /** What is being typed, until it is committed. Null while the field shows the stored value. */
  const [draft, setDraft] = useState<string | null>(null);

  const own = splitLength(value);
  const inherited = splitLength(placeholder);
  const unit: CssUnit = own?.unit ?? inherited?.unit ?? FALLBACK_UNIT;
  const custom = value.trim() !== '' && !own && !PLAIN_NUMBER.test(value.trim());
  const shown = draft ?? (own ? String(own.num) : value.trim());

  /** The number to step or re-unit from: what is typed, else the stored value, else the inherited one. */
  const currentNumber = (): number => {
    const typed = draft?.trim() ?? '';
    if (PLAIN_NUMBER.test(typed)) return parseFloat(typed);
    const typedLength = splitLength(typed);
    if (typedLength) return typedLength.num;
    return own?.num ?? inherited?.num ?? 0;
  };

  const commitTyped = (text: string) => {
    setDraft(null);
    const trimmed = text.trim();
    if (trimmed === '') onCommit(`0${unit}`);
    else onCommit(PLAIN_NUMBER.test(trimmed) ? `${trimmed}${unit}` : trimmed);
  };

  const step = (direction: 1 | -1) => {
    const typedUnit = draft ? splitLength(draft)?.unit : undefined;
    const stepUnit = typedUnit ?? unit;
    // Padding cannot be negative — CSS ignores the whole declaration if it is.
    const next = Math.max(0, stepValue(currentNumber(), stepUnit, direction));
    setDraft(null);
    onCommit(`${next}${stepUnit}`);
  };

  const changeUnit = (nextUnit: CssUnit) => {
    const num = currentNumber();
    setDraft(null);
    onCommit(`${num}${nextUnit}`);
  };

  return (
    <Stack
      direction="row"
      sx={{ alignItems: 'center', bgcolor: 'background.default', borderRadius: 0.5, opacity: dimmed ? 0.55 : 1, pl: 0.5 }}
    >
      <InputBase
        value={shown}
        placeholder={inherited ? String(inherited.num) : placeholder}
        onChange={(event) => setDraft(event.target.value)}
        // Only a real edit is committed: tabbing through an inherited side must not switch the
        // padding on with the values it happened to show.
        onBlur={() => {
          if (draft !== null) commitTyped(draft);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            (event.target as HTMLInputElement).blur();
          } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !custom) {
            event.preventDefault();
            step(event.key === 'ArrowUp' ? 1 : -1);
          }
        }}
        inputProps={{ style: { textAlign: 'right', fontFamily: 'monospace', fontSize: '0.7rem', padding: '2px 0' } }}
        sx={{ width: 34 }}
      />
      <Select
        value={custom ? '' : unit}
        displayEmpty
        disabled={custom}
        onChange={(event) => changeUnit(event.target.value as CssUnit)}
        input={<InputBase />}
        renderValue={(selected) => selected || '—'}
        inputProps={{ 'aria-label': LL.STYLE.UNIT() }}
        sx={{
          fontSize: '0.65rem',
          fontFamily: 'monospace',
          color: 'text.secondary',
          '& .MuiSelect-select': { py: '2px', pl: 0.25, pr: '16px !important' },
          '& .MuiSelect-icon': { fontSize: 14, right: 0 },
        }}
      >
        {CSS_UNITS.map((option) => (
          <MenuItem key={option} value={option} dense sx={{ gap: 1.5 }}>
            <Box component="span" sx={{ fontFamily: 'monospace', fontWeight: 600, minWidth: 34 }}>
              {option}
            </Box>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {cssUnitHint(LL, option)}
            </Typography>
          </MenuItem>
        ))}
      </Select>
    </Stack>
  );
};

/** A single nesting level, drawn as a labelled frame with one value-and-unit input per side. */
const Layer = ({ layer, tint, children }: { layer: BoxLayer; tint: string; children: React.ReactNode }) => {
  const { LL } = useI18nContext();
  const sides = parseBoxShorthand(layer.enabled ? layer.value : '', '');
  const inherited = parseBoxShorthand(layer.placeholder, '0');

  // Editing any side writes the whole shorthand back, and turns the property on: reaching for a
  // value is the same gesture as deciding to set it. The other sides start from what applies now.
  const setSide = (side: keyof BoxSides, next: string) => {
    const merged = { ...parseBoxShorthand(layer.enabled ? layer.value : layer.placeholder, '0'), [side]: next };
    const shorthand = formatBoxShorthand(merged);
    if (shorthand !== layer.value || !layer.enabled) layer.onChange(shorthand);
  };

  const sideInput = (side: keyof BoxSides) => (
    <SideInput value={sides[side]} placeholder={inherited[side]} dimmed={!layer.enabled} onCommit={(next) => setSide(side, next)} />
  );

  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: tint, p: 0.75, pt: 0.25, position: 'relative' }}>
      <Stack direction="row" sx={{ alignItems: 'center', gap: 0.5, mb: 0.25 }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', flexGrow: 1, fontSize: '0.65rem', letterSpacing: 0.4 }}>
          {layer.label}
        </Typography>
        {layer.enabled && (
          <Tooltip title={LL.STYLE.RESET_TO_INHERITED()}>
            <IconButton size="small" onClick={layer.onReset} sx={{ p: 0.25, opacity: 0.4, '&:hover': { opacity: 1 } }}>
              <ResetIcon sx={{ fontSize: 13 }} />
            </IconButton>
          </Tooltip>
        )}
      </Stack>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'auto minmax(0, 1fr) auto',
          gridTemplateRows: 'auto minmax(0, 1fr) auto',
          alignItems: 'center',
          justifyItems: 'center',
          gap: 0.5,
        }}
      >
        <Box />
        {sideInput('top')}
        <Box />

        {sideInput('left')}
        <Box sx={{ width: '100%' }}>{children}</Box>
        {sideInput('right')}

        <Box />
        {sideInput('bottom')}
        <Box />
      </Box>
    </Box>
  );
};

/**
 * The slide's padding and a paragraph's padding, drawn as nested boxes.
 *
 * They were two separate rows — one offering only a vertical and a horizontal value, the other
 * four unlabelled fields — which gave no sense that one sits inside the other. A browser's box
 * model inspector solves exactly this problem, so this borrows its shape: the outer frame is the
 * slide edge, the inner one is the space around each paragraph, and every side is its own field.
 *
 * A side left blank shows the value it inherits behind it, so an unset box still reads as the
 * spacing that will actually apply.
 */
export const BoxModelEditor = ({ outer, inner, contentLabel }: { outer: BoxLayer; inner: BoxLayer; contentLabel: string }) => (
  <Layer layer={outer} tint="action.hover">
    <Layer layer={inner} tint="background.paper">
      <Box
        sx={{
          border: 1,
          borderStyle: 'dashed',
          borderColor: 'divider',
          borderRadius: 0.5,
          py: 0.75,
          textAlign: 'center',
          minWidth: 0,
        }}
      >
        <Typography variant="caption" sx={{ color: 'text.disabled', fontSize: '0.65rem' }}>
          {contentLabel}
        </Typography>
      </Box>
    </Layer>
  </Layer>
);
