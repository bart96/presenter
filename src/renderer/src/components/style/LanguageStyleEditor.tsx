import { IconButton, Slider, Stack, Switch, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material';
import {
  FormatAlignCenter as AlignCenterIcon,
  FormatAlignLeft as AlignLeftIcon,
  FormatAlignRight as AlignRightIcon,
  FormatBold as BoldIcon,
  FormatItalic as ItalicIcon,
  FormatUnderlined as UnderlineIcon,
  RestartAlt as ResetIcon,
} from '@mui/icons-material';
import type { useI18nContext } from '@/i18n/i18n-react';
import type { LanguageStyleEntry } from '@/api/styles.api';
import { ColorSwatchButton } from '@/components/style/ColorPicker';
import { CssUnitInput } from '@/components/style/CssUnitInput';
import { StylePropRow } from '@/components/style/StyleFormPrimitives';
import type { InheritedSource } from '@/components/style/styleFormContext';
import { DEFAULT_NEXT_LINE_COLOR, DEFAULT_NEXT_LINE_OPACITY, DEFAULT_STYLE } from '@/utils/styleUtils';

/** Per-language typography settings editor with per-property enable toggles. */
export const LanguageStyleEditor = ({
  entry,
  onChange,
  inheritedFor,
  isMainSlot = false,
  LL,
}: {
  entry: LanguageStyleEntry;
  onChange: (patch: Partial<LanguageStyleEntry>) => void;
  /**
   * Where a field's value comes from when this slot does not set it — the main slot, then the
   * app default. Supplied by the caller, which is the only place that can see the sibling slots.
   */
  inheritedFor?: (field: keyof LanguageStyleEntry) => InheritedSource[];
  /** Slot 1 — the only slot whose next-line preview settings are read. */
  isMainSlot?: boolean;
  LL: ReturnType<typeof useI18nContext>['LL'];
}) => {
  const shadowParts = (entry.textShadow || '2px 2px 4px').split(/\s+/);
  const sx = shadowParts[0] || '2px';
  const sy = shadowParts[1] || '2px';
  const sb = shadowParts[2] || '4px';
  const strokeMatch = (entry.textStroke || '1px black').match(/^(-?\d*\.?\d+\s*(?:px|pt|em|rem|vh|vw|vmin|vmax|%))\s+(.+)$/i);
  const sw = strokeMatch ? strokeMatch[1] : '1px';
  const sc = strokeMatch ? strokeMatch[2] : 'black';

  /**
   * Write a value AND switch its property on.
   *
   * The main style rows already do this (`updateProp(key, { enabled: true, value })`), but
   * the language rows only wrote the value — so picking a colour or size here changed
   * nothing on screen, because `langEntryToCss` skips any property whose `*Enabled` flag
   * is not set. The row's toggle still turns it back off.
   */
  const setEnabled = (patch: Partial<LanguageStyleEntry>, enableKey: keyof LanguageStyleEntry) => onChange({ ...patch, [enableKey]: true });

  return (
    <Stack spacing={1}>
      <StylePropRow
        label={LL.STYLE.FONT_COLOR()}
        inherited={inheritedFor?.('fontColor')}
        enabled={entry.fontColorEnabled ?? false}
        onToggle={(e) => onChange({ fontColorEnabled: e })}
      >
        <ColorSwatchButton value={entry.fontColor || '#FFFFFF'} onChange={(c) => setEnabled({ fontColor: c }, 'fontColorEnabled')} />
      </StylePropRow>
      <StylePropRow
        label={LL.STYLE.FONT_SIZE()}
        inherited={inheritedFor?.('fontSize')}
        enabled={entry.fontSizeEnabled ?? false}
        onToggle={(e) => onChange({ fontSizeEnabled: e })}
      >
        <CssUnitInput value={entry.fontSize || '4vh'} onChange={(v) => setEnabled({ fontSize: v }, 'fontSizeEnabled')} />
      </StylePropRow>
      <StylePropRow
        label={LL.STYLE.FONT_BOLD_ITALIC()}
        inherited={inheritedFor?.('fontBold')}
        enabled={entry.fontStyleEnabled ?? false}
        onToggle={(e) => onChange({ fontStyleEnabled: e })}
      >
        <ToggleButtonGroup size="small">
          <ToggleButton
            value="bold"
            selected={entry.fontBold || false}
            onClick={() => setEnabled({ fontBold: !entry.fontBold }, 'fontStyleEnabled')}
          >
            <BoldIcon />
          </ToggleButton>
          <ToggleButton
            value="italic"
            selected={entry.fontItalic || false}
            onClick={() => setEnabled({ fontItalic: !entry.fontItalic }, 'fontStyleEnabled')}
          >
            <ItalicIcon />
          </ToggleButton>
          <ToggleButton
            value="underline"
            selected={entry.fontUnderline || false}
            onClick={() => setEnabled({ fontUnderline: !entry.fontUnderline }, 'fontStyleEnabled')}
          >
            <UnderlineIcon />
          </ToggleButton>
        </ToggleButtonGroup>
      </StylePropRow>
      <StylePropRow
        label={LL.STYLE.LETTER_SPACING()}
        inherited={inheritedFor?.('letterSpacing')}
        enabled={entry.letterSpacingEnabled ?? false}
        onToggle={(e) => onChange({ letterSpacingEnabled: e })}
      >
        <CssUnitInput value={entry.letterSpacing || '0px'} onChange={(v) => setEnabled({ letterSpacing: v }, 'letterSpacingEnabled')} />
      </StylePropRow>
      <StylePropRow
        block
        label={LL.STYLE.TEXT_SHADOW()}
        inherited={inheritedFor?.('textShadow')}
        enabled={entry.textShadowEnabled ?? false}
        onToggle={(e) => onChange({ textShadowEnabled: e })}
      >
        <Stack
          direction="row"
          spacing={1}
          sx={{
            alignItems: 'flex-start',
          }}
        >
          <CssUnitInput
            value={sx}
            onChange={(v) => setEnabled({ textShadow: `${v} ${sy} ${sb}` }, 'textShadowEnabled')}
            label={LL.STYLE.SHADOW_X()}
          />
          <CssUnitInput
            value={sy}
            onChange={(v) => setEnabled({ textShadow: `${sx} ${v} ${sb}` }, 'textShadowEnabled')}
            label={LL.STYLE.SHADOW_Y()}
          />
          <CssUnitInput
            value={sb}
            onChange={(v) => setEnabled({ textShadow: `${sx} ${sy} ${v}` }, 'textShadowEnabled')}
            label={LL.STYLE.SHADOW_BLUR()}
          />
          <Stack
            sx={{
              alignItems: 'center',
            }}
          >
            <Typography
              variant="caption"
              sx={{
                color: 'text.secondary',
                mb: 0.25,
              }}
            >
              {LL.STYLE.SHADOW_COLOR()}
            </Typography>
            <ColorSwatchButton
              value={entry.textShadowColor || '#000000'}
              onChange={(c) => setEnabled({ textShadowColor: c }, 'textShadowEnabled')}
            />
          </Stack>
        </Stack>
      </StylePropRow>
      <StylePropRow
        block
        label={LL.STYLE.TEXT_STROKE()}
        inherited={inheritedFor?.('textStroke')}
        enabled={entry.textStrokeEnabled ?? false}
        onToggle={(e) => onChange({ textStrokeEnabled: e })}
      >
        <Stack
          direction="row"
          spacing={1}
          sx={{
            alignItems: 'flex-start',
          }}
        >
          <CssUnitInput
            value={sw}
            onChange={(v) => setEnabled({ textStroke: `${v} ${sc}` }, 'textStrokeEnabled')}
            label={LL.STYLE.STROKE_WIDTH()}
          />
          <Stack
            sx={{
              alignItems: 'center',
            }}
          >
            <Typography
              variant="caption"
              sx={{
                color: 'text.secondary',
                mb: 0.25,
              }}
            >
              {LL.STYLE.STROKE_COLOR()}
            </Typography>
            <ColorSwatchButton value={sc} onChange={(c) => setEnabled({ textStroke: `${sw} ${c}` }, 'textStrokeEnabled')} />
          </Stack>
        </Stack>
      </StylePropRow>
      <StylePropRow
        label={LL.STYLE.OPACITY()}
        inherited={inheritedFor?.('opacity')}
        enabled={entry.opacityEnabled ?? false}
        onToggle={(e) => onChange({ opacityEnabled: e })}
      >
        <Slider
          min={0}
          max={1}
          step={0.05}
          value={entry.opacity ?? 1}
          onChange={(_, v) => setEnabled({ opacity: v as number }, 'opacityEnabled')}
          valueLabelDisplay="auto"
          sx={{ width: 200 }}
        />
      </StylePropRow>
      {/* The preview follows the main slot only (see resolveNextLinePreview), so offering the row
          on the other slots was a switch that could never do anything. */}
      {isMainSlot && (
        <StylePropRow
          block
          label={LL.STYLE.NEXT_LINE_PREVIEW()}
          enabled={entry.nextLinePreviewEnabled ?? false}
          // Overriding the row keeps the preview on, as it was while inherited. Enabling it with no
          // value of its own read as "off", so opening the row to adjust the layout hid the preview.
          onToggle={(e) =>
            onChange(
              e && entry.nextLinePreview === undefined
                ? { nextLinePreviewEnabled: true, nextLinePreview: true }
                : { nextLinePreviewEnabled: e },
            )
          }
        >
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Switch
                size="small"
                // Not set here means the app default applies, which shows the preview. Rendering that
                // as "off" made the first click turn it ON, so switching it off took two clicks and
                // looked like it could not be done.
                checked={entry.nextLinePreviewEnabled ? entry.nextLinePreview === true : true}
                onChange={(e2) => setEnabled({ nextLinePreview: e2.target.checked }, 'nextLinePreviewEnabled')}
              />
              <ColorSwatchButton
                value={entry.nextLinePreviewColor || DEFAULT_NEXT_LINE_COLOR}
                onChange={(c) => setEnabled({ nextLinePreviewColor: c }, 'nextLinePreviewEnabled')}
              />
              <Stack spacing={0} sx={{ alignItems: 'center' }}>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {LL.STYLE.NEXT_LINE_OPACITY()}
                </Typography>
                <Slider
                  min={0}
                  max={1}
                  step={0.05}
                  value={entry.nextLinePreviewOpacity ?? DEFAULT_NEXT_LINE_OPACITY}
                  onChange={(_, v) => setEnabled({ nextLinePreviewOpacity: v as number }, 'nextLinePreviewEnabled')}
                  valueLabelDisplay="auto"
                  valueLabelFormat={(v) => `${Math.round((v as number) * 100)}%`}
                  sx={{ width: 80 }}
                />
              </Stack>
            </Stack>

            {/* The strip's own layout. Its size used to follow the lyrics with no way to change it, while
                the editor preview quietly drew it at 70% — so the two never agreed. */}
            <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 2, rowGap: 1.5, alignItems: 'flex-end' }}>
              <Stack spacing={0.25}>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {LL.STYLE.NEXT_LINE_SIZE()}
                  {!entry.nextLinePreviewFontSize && ` · ${LL.STYLE.NEXT_LINE_SIZE_SAME()}`}
                </Typography>
                <Stack direction="row" sx={{ alignItems: 'center' }}>
                  <CssUnitInput
                    width={130}
                    value={entry.nextLinePreviewFontSize || (entry.fontSizeEnabled && entry.fontSize) || DEFAULT_STYLE.fontSize || '4vw'}
                    onChange={(v) => setEnabled({ nextLinePreviewFontSize: v }, 'nextLinePreviewEnabled')}
                  />
                  {entry.nextLinePreviewFontSize && (
                    <Tooltip title={LL.STYLE.NEXT_LINE_SIZE_RESET()}>
                      <IconButton size="small" onClick={() => onChange({ nextLinePreviewFontSize: undefined })}>
                        <ResetIcon sx={{ fontSize: 16 }} />
                      </IconButton>
                    </Tooltip>
                  )}
                </Stack>
              </Stack>

              <Stack spacing={0.25}>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {LL.STYLE.NEXT_LINE_POSITION()}
                </Typography>
                <ToggleButtonGroup
                  size="small"
                  exclusive
                  value={entry.nextLinePreviewPosition ?? 'below'}
                  onChange={(_, v) => v && setEnabled({ nextLinePreviewPosition: v }, 'nextLinePreviewEnabled')}
                >
                  <ToggleButton value="below" sx={{ textTransform: 'none', py: 0.5 }}>
                    {LL.STYLE.NEXT_LINE_POSITION_BELOW()}
                  </ToggleButton>
                  <ToggleButton value="bottom" sx={{ textTransform: 'none', py: 0.5 }}>
                    {LL.STYLE.NEXT_LINE_POSITION_BOTTOM()}
                  </ToggleButton>
                </ToggleButtonGroup>
              </Stack>

              <Stack spacing={0.25}>
                <Tooltip title={LL.STYLE.NEXT_LINE_SPACING_HINT()} placement="top-start">
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {LL.STYLE.NEXT_LINE_SPACING()}
                  </Typography>
                </Tooltip>
                <CssUnitInput
                  width={130}
                  value={entry.nextLinePreviewSpacing || '0vh'}
                  onChange={(v) => setEnabled({ nextLinePreviewSpacing: v }, 'nextLinePreviewEnabled')}
                />
              </Stack>

              <Stack spacing={0.25}>
                <Tooltip title={LL.STYLE.NEXT_LINE_ALIGN_HINT()} placement="top-start">
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {LL.STYLE.NEXT_LINE_ALIGN()}
                  </Typography>
                </Tooltip>
                <ToggleButtonGroup
                  size="small"
                  exclusive
                  value={entry.nextLinePreviewTextAlign ?? null}
                  // Deselecting the active button goes back to following the lyrics' alignment.
                  onChange={(_, v) => setEnabled({ nextLinePreviewTextAlign: v ?? undefined }, 'nextLinePreviewEnabled')}
                >
                  <ToggleButton value="left">
                    <AlignLeftIcon fontSize="small" />
                  </ToggleButton>
                  <ToggleButton value="center">
                    <AlignCenterIcon fontSize="small" />
                  </ToggleButton>
                  <ToggleButton value="right">
                    <AlignRightIcon fontSize="small" />
                  </ToggleButton>
                </ToggleButtonGroup>
              </Stack>
            </Stack>
          </Stack>
        </StylePropRow>
      )}
    </Stack>
  );
};
