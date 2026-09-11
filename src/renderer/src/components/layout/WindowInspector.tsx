/**
 * Everything about one window, as three tabs.
 *
 * This replaces `WindowConfigForm`, which was one ~250-line column rendered twice — once to
 * create and once per window to edit — and which pushed the window list off screen the
 * moment it opened. The split is by question rather than by widget: *where* it is, *what*
 * it shows, and *which stage layers* land on it.
 *
 * The boolean flags are an icon toggle row rather than five switch rows. They are one bit
 * each, they already appear as one-click items in the footer menu, and as switches they
 * cost about 100px of a panel that has a screen map to fit in.
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
  Box,
  Checkbox,
  Chip,
  FormControlLabel,
  MenuItem,
  Select,
  Stack,
  Tab,
  Tabs,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Cast as StreamIcon,
  CropFree as FramelessIcon,
  Fullscreen as FullscreenIcon,
  Monitor as NormalIcon,
  MouseOutlined as MouseIcon,
  Opacity as TransparentIcon,
  Palette as StyleIcon,
  TextFields as HideTextIcon,
  VerticalAlignTop as OnTopIcon,
  Wallpaper as HideBackgroundIcon,
} from '@mui/icons-material';
import { useI18nContext } from '@/i18n/i18n-react';
import type { WindowConfig } from '@/store/windowSlice';
import type { StageLayerEntity } from '@/stage/types';
import { LanguagePicker } from '@/components/common/LanguagePicker';
import { useAccountLanguages } from '@/hooks/useAccountLanguages';
import { ScreenPicker, screenIdForBounds, type ScreenInfo, type ScreenPickerWindow } from './ScreenPicker';

export interface WindowInspectorProps {
  config: WindowConfig;
  onChange: (patch: Partial<WindowConfig>) => void;
  screens: ScreenInfo[];
  openWindows: ScreenPickerWindow[];
  styles: Array<{ id: number; name: string }>;
  stageLayers: StageLayerEntity[];
  /** Live geometry of the window being edited, so the map opens on where it actually is. */
  bounds?: { x: number; y: number; width: number; height: number };
  /** Rendered under the tabs — the Create button, in new-window mode. */
  footer?: ReactNode;
}

/**
 * A number field that only reports a value once the operator has finished with it.
 *
 * Committing on every keystroke would apply the width `1` and then `19` on the way to
 * `1920`, moving the real window twice for no reason.
 */
const CommittedNumberField = ({
  label,
  value,
  onCommit,
  placeholder,
}: {
  label: string;
  value: number | undefined;
  onCommit: (value: number | undefined) => void;
  placeholder?: string;
}) => {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  // Follow the outside world when it changes for other reasons — dragging the window on
  // screen, or selecting a different one.
  useEffect(() => setDraft(value === undefined ? '' : String(value)), [value]);

  const commit = () => {
    const trimmed = draft.trim();
    onCommit(trimmed === '' ? undefined : Number(trimmed));
  };

  return (
    <TextField
      label={label}
      type="number"
      size="small"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      sx={{ flex: 1 }}
    />
  );
};

/** The window's boolean flags, one icon each. */
const FLAGS = [
  { key: 'fullscreen', Icon: FullscreenIcon, labelKey: 'FULLSCREEN' },
  { key: 'frameless', Icon: FramelessIcon, labelKey: 'FRAMELESS' },
  { key: 'alwaysOnTop', Icon: OnTopIcon, labelKey: 'ALWAYS_ON_TOP' },
  { key: 'hideMouse', Icon: MouseIcon, labelKey: 'HIDE_MOUSE' },
  { key: 'transparent', Icon: TransparentIcon, labelKey: 'TRANSPARENT' },
] as const;

export const WindowInspector = ({ config, onChange, screens, openWindows, styles, stageLayers, bounds, footer }: WindowInspectorProps) => {
  const { LL } = useI18nContext();
  const [tab, setTab] = useState(0);
  const { available: availableLanguages } = useAccountLanguages();

  const flagLabel = (key: (typeof FLAGS)[number]['labelKey']): string => (key === 'HIDE_MOUSE' ? LL.FOOTER.HIDE_MOUSE() : LL.WINDOW[key]());

  const activeFlags = FLAGS.filter((f) => (f.key === 'frameless' ? config.frameless !== false : !!config[f.key])).map((f) => f.key);

  const selectedScreenId = screenIdForBounds(bounds ?? boundsFromConfig(config), screens) ?? '';
  const languages = config.languages ?? [];

  return (
    <Stack sx={{ height: '100%', minHeight: 0 }}>
      <Tabs value={tab} onChange={(_e, v) => setTab(v)} variant="fullWidth" sx={{ minHeight: 38, '& .MuiTab-root': { minHeight: 38 } }}>
        <Tab label={LL.WINDOW.TAB_PLACEMENT()} />
        <Tab label={LL.WINDOW.TAB_CONTENT()} />
        <Tab label={LL.WINDOW.TAB_STAGE()} />
      </Tabs>

      <Box sx={{ flex: 1, overflow: 'auto', p: 1.5 }}>
        {tab === 0 && (
          <Stack spacing={1.5}>
            <TextField
              label={LL.WINDOW.NAME()}
              value={config.name ?? ''}
              onChange={(e) => onChange({ name: e.target.value })}
              size="small"
              fullWidth
            />

            <ScreenPicker
              screens={screens}
              value={selectedScreenId}
              windows={openWindows}
              height={150}
              onChange={(screenId) => {
                const target = screens.find((s) => s.id === screenId);
                if (!target) return;
                onChange({
                  positionX: target.bounds.x,
                  positionY: target.bounds.y,
                  width: target.bounds.width,
                  height: target.bounds.height,
                });
              }}
            />

            <Stack direction="row" spacing={1}>
              <CommittedNumberField label={LL.WINDOW.WIDTH()} value={config.width} onCommit={(v) => onChange({ width: v })} />
              <CommittedNumberField label={LL.WINDOW.HEIGHT()} value={config.height} onCommit={(v) => onChange({ height: v })} />
              <CommittedNumberField
                label={LL.WINDOW.POSITION_X()}
                value={config.positionX}
                placeholder="auto"
                onCommit={(v) => onChange({ positionX: v })}
              />
              <CommittedNumberField
                label={LL.WINDOW.POSITION_Y()}
                value={config.positionY}
                placeholder="auto"
                onCommit={(v) => onChange({ positionY: v })}
              />
            </Stack>

            <Stack spacing={0.5}>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {LL.WINDOW.OPTIONS()}
              </Typography>
              <ToggleButtonGroup
                value={activeFlags}
                size="small"
                onChange={(_e, next: string[]) => {
                  // Report only what actually flipped: the group hands back the whole set,
                  // and writing all five every time would churn the window config.
                  for (const flag of FLAGS) {
                    const was = activeFlags.includes(flag.key);
                    const now = next.includes(flag.key);
                    if (was !== now) onChange({ [flag.key]: now } as Partial<WindowConfig>);
                  }
                }}
                sx={{ flexWrap: 'wrap' }}
              >
                {FLAGS.map(({ key, Icon, labelKey }) => (
                  <ToggleButton key={key} value={key} sx={{ px: 1.25, gap: 0.5, textTransform: 'none' }}>
                    <Icon sx={{ fontSize: 16 }} />
                    <Typography variant="caption">{flagLabel(labelKey)}</Typography>
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            </Stack>
          </Stack>
        )}

        {tab === 1 && (
          <Stack spacing={1.5}>
            <ToggleButtonGroup
              value={config.displayMode ?? 'normal'}
              exclusive
              size="small"
              fullWidth
              onChange={(_e, v: 'normal' | 'stream' | null) => v && onChange({ displayMode: v })}
            >
              <ToggleButton value="normal" sx={{ gap: 0.5, textTransform: 'none' }}>
                <NormalIcon sx={{ fontSize: 16 }} />
                {LL.FOOTER.NORMAL_MODE()}
              </ToggleButton>
              <ToggleButton value="stream" sx={{ gap: 0.5, textTransform: 'none' }}>
                <StreamIcon sx={{ fontSize: 16 }} />
                {LL.FOOTER.STREAM_MODE()}
              </ToggleButton>
            </ToggleButtonGroup>

            {/* Only meaningful in stream mode, so it does not sit there confusing anyone in normal mode. */}
            {config.displayMode === 'stream' && (
              <CommittedNumberField
                label={LL.WINDOW.STREAM_LINES()}
                value={config.streamLines}
                onCommit={(v) => onChange({ streamLines: v })}
              />
            )}

            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Tooltip title={LL.STYLE.EDITOR()}>
                <StyleIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
              </Tooltip>
              <Select
                size="small"
                value={config.styleId || 0}
                onChange={(e) => onChange({ styleId: (e.target.value as number) || undefined })}
                sx={{ flex: 1 }}
                displayEmpty
              >
                <MenuItem value={0}>
                  <em>{LL.STYLE.NONE()}</em>
                </MenuItem>
                {styles.map((s) => (
                  <MenuItem key={s.id} value={s.id}>
                    {s.name}
                  </MenuItem>
                ))}
              </Select>
            </Stack>

            <Stack spacing={0.5}>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {LL.WINDOW.LANGUAGES()}
              </Typography>
              <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5, alignItems: 'center' }}>
                {languages.length === 0 && <Chip size="small" variant="outlined" label={LL.WINDOW.LANGUAGES_ALL()} sx={{ height: 22 }} />}
                {languages.map((code) => (
                  <Chip
                    key={code}
                    size="small"
                    label={code}
                    onDelete={() => onChange({ languages: languages.filter((c) => c !== code) })}
                    sx={{ height: 22 }}
                  />
                ))}
                <LanguagePicker
                  selected={languages}
                  suggested={availableLanguages}
                  onAdd={(code) => onChange({ languages: [...languages, code] })}
                />
              </Stack>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {LL.WINDOW.LANGUAGES_HINT()}
              </Typography>
            </Stack>

            <Stack>
              <FormControlLabel
                control={<Checkbox size="small" checked={!!config.hideText} onChange={(e) => onChange({ hideText: e.target.checked })} />}
                label={
                  <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                    <HideTextIcon sx={{ fontSize: 16 }} />
                    <Typography variant="body2">{LL.WINDOW.HIDE_TEXT()}</Typography>
                  </Stack>
                }
              />
              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    checked={!!config.hideBackground}
                    onChange={(e) => onChange({ hideBackground: e.target.checked })}
                  />
                }
                label={
                  <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                    <HideBackgroundIcon sx={{ fontSize: 16 }} />
                    <Typography variant="body2">{LL.WINDOW.HIDE_BACKGROUND()}</Typography>
                  </Stack>
                }
              />
            </Stack>
          </Stack>
        )}

        {tab === 2 && (
          <Stack spacing={1}>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {LL.WINDOW.STAGE_LAYERS_HINT()}
            </Typography>
            {stageLayers.length === 0 ? (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                {LL.WINDOW.STAGE_LAYERS_NONE()}
              </Typography>
            ) : (
              stageLayers.map((layer) => {
                const selected = (config.stageLayerIds ?? []).includes(layer.id);
                return (
                  <FormControlLabel
                    key={layer.id}
                    control={
                      <Checkbox
                        size="small"
                        checked={selected}
                        onChange={(e) => {
                          const current = config.stageLayerIds ?? [];
                          onChange({
                            stageLayerIds: e.target.checked ? [...current, layer.id] : current.filter((id) => id !== layer.id),
                          });
                        }}
                      />
                    }
                    label={
                      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                        <Typography variant="body2">{layer.name}</Typography>
                        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                          {layer.data.cues.length > 0 ? LL.STAGE.CUE_OF({ index: 1, total: layer.data.cues.length }) : LL.STAGE.NO_CUES()}
                        </Typography>
                      </Stack>
                    }
                  />
                );
              })
            )}
          </Stack>
        )}
      </Box>

      {footer && <Box sx={{ p: 1.5, borderTop: 1, borderColor: 'divider' }}>{footer}</Box>}
    </Stack>
  );
};

/** Geometry from the saved config, for a window that is not open to report live bounds. */
const boundsFromConfig = (config: WindowConfig): { x: number; y: number; width: number; height: number } | undefined => {
  const { positionX, positionY, width, height } = config;
  if (positionX === undefined || positionY === undefined || !width || !height) return undefined;
  return { x: positionX, y: positionY, width, height };
};
