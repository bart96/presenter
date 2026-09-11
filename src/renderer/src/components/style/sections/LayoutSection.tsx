import { Box, MenuItem, Select, Stack, ToggleButton, ToggleButtonGroup, Tooltip } from '@mui/material';
import {
  FormatAlignLeft as AlignLeftIcon,
  FormatAlignCenter as AlignCenterIcon,
  FormatAlignRight as AlignRightIcon,
  FormatAlignJustify as AlignJustifyIcon,
  VerticalAlignTop as VAlignTopIcon,
  VerticalAlignCenter as VAlignMidIcon,
  VerticalAlignBottom as VAlignBotIcon,
} from '@mui/icons-material';
import { CssUnitInput } from '@/components/style/CssUnitInput';
import { CardGrid, PropCard, StylePropRow } from '@/components/style/StyleFormPrimitives';
import { BoxModelEditor } from '@/components/style/BoxModelEditor';
import type { StyleFormCtx } from '@/components/style/styleFormContext';
import { DEFAULT_STYLE } from '@/utils/styleUtils';

/** Layout: where the text block sits on the screen and how much room it gets. */
export const LayoutSection = ({ ctx }: { ctx: StyleFormCtx }) => {
  const { LL, getProp, updateProp, togglePropEnabled } = ctx;

  return (
    <CardGrid>
      <PropCard>
        <StylePropRow
          label={LL.STYLE.ALIGNMENT()}
          enabled={getProp<string>('textAlign').enabled || getProp<string>('verticalAlign').enabled}
          onToggle={(e) => {
            togglePropEnabled('textAlign', e);
            togglePropEnabled('verticalAlign', e);
          }}
          propKeys={['textAlign', 'verticalAlign']}
        >
          <Stack
            direction="row"
            spacing={1.5}
            sx={{
              alignItems: 'center',
            }}
          >
            <ToggleButtonGroup
              size="small"
              exclusive
              value={getProp<string>('textAlign').value || 'center'}
              onChange={(_, val) => val && updateProp('textAlign', { enabled: true, value: val })}
            >
              <ToggleButton value="left">
                <AlignLeftIcon />
              </ToggleButton>
              <ToggleButton value="center">
                <AlignCenterIcon />
              </ToggleButton>
              <ToggleButton value="right">
                <AlignRightIcon />
              </ToggleButton>
              <ToggleButton value="justify">
                <AlignJustifyIcon />
              </ToggleButton>
            </ToggleButtonGroup>
            <Box sx={{ width: 1, height: 28, bgcolor: 'divider' }} />
            <ToggleButtonGroup
              size="small"
              exclusive
              value={getProp<string>('verticalAlign').value || 'center'}
              onChange={(_, val) => val && updateProp('verticalAlign', { enabled: true, value: val })}
            >
              <Tooltip title={`${LL.STYLE.VERTICAL_ALIGN()}: ${LL.STYLE.VERTICAL_ALIGN_TOP()}`}>
                <ToggleButton value="top">
                  <VAlignTopIcon />
                </ToggleButton>
              </Tooltip>
              <Tooltip title={`${LL.STYLE.VERTICAL_ALIGN()}: ${LL.STYLE.VERTICAL_ALIGN_CENTER()}`}>
                <ToggleButton value="center">
                  <VAlignMidIcon />
                </ToggleButton>
              </Tooltip>
              <Tooltip title={`${LL.STYLE.VERTICAL_ALIGN()}: ${LL.STYLE.VERTICAL_ALIGN_BOTTOM()}`}>
                <ToggleButton value="bottom">
                  <VAlignBotIcon />
                </ToggleButton>
              </Tooltip>
            </ToggleButtonGroup>
          </Stack>
        </StylePropRow>
        <StylePropRow
          label={LL.STYLE.TRANSFORM()}
          enabled={getProp<string>('textTransform').enabled}
          onToggle={(e) => togglePropEnabled('textTransform', e)}
          propKeys={['textTransform']}
        >
          <Select
            size="small"
            value={getProp<string>('textTransform').value || 'none'}
            onChange={(e) => updateProp('textTransform', { enabled: true, value: e.target.value as never })}
            sx={{ width: 150 }}
          >
            <MenuItem value="none">{LL.STYLE.TRANSFORM_NONE()}</MenuItem>
            {/* The remaining options are written the way they transform, so they explain themselves in any language. */}
            <MenuItem value="uppercase">UPPERCASE</MenuItem>
            <MenuItem value="lowercase">lowercase</MenuItem>
            <MenuItem value="capitalize">Capitalize</MenuItem>
          </Select>
        </StylePropRow>
        <StylePropRow
          label={LL.STYLE.LINE_HEIGHT()}
          enabled={getProp<string>('lineHeight').enabled}
          onToggle={(e) => togglePropEnabled('lineHeight', e)}
          propKeys={['lineHeight']}
        >
          <CssUnitInput
            value={getProp<string>('lineHeight').value || '1.4'}
            onChange={(v) => updateProp('lineHeight', { enabled: true, value: v })}
            units={['em', 'px', 'rem', '%']}
          />
        </StylePropRow>
        {/* Slide padding and paragraph padding are one nested shape, not two unrelated rows. */}
        <Box sx={{ px: 1, py: 0.5 }}>
          <BoxModelEditor
            contentLabel={LL.STYLE.BOX_CONTENT()}
            outer={{
              label: LL.STYLE.PADDING(),
              value: getProp<string>('padding').value || '',
              enabled: getProp<string>('padding').enabled,
              // What actually applies when the style leaves it unset. This read "5% 10%" and
              // "1vh 0px", neither of which the presentation ever used.
              placeholder: DEFAULT_STYLE.padding ?? '0',
              onChange: (value) => updateProp('padding', { enabled: true, value }),
              onReset: () => togglePropEnabled('padding', false),
            }}
            inner={{
              label: LL.STYLE.PARAGRAPH_PADDING(),
              value: getProp<string>('paragraphPadding').value || '',
              enabled: getProp<string>('paragraphPadding').enabled,
              placeholder: DEFAULT_STYLE.paragraphPadding ?? '0',
              onChange: (value) => updateProp('paragraphPadding', { enabled: true, value }),
              onReset: () => togglePropEnabled('paragraphPadding', false),
            }}
          />
        </Box>
      </PropCard>
    </CardGrid>
  );
};
