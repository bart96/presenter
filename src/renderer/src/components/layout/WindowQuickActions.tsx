/**
 * What a window chip opens.
 *
 * It replaces a twelve-item menu whose *first* entry was the destructive Close, and in
 * which every toggle cost open-read-click-reopen to flip a second one. These are toggles,
 * so they are drawn as toggles: one grid, current state visible at a glance, and the panel
 * stays open while several are flipped.
 *
 * Anything that is not a toggle — renaming, geometry, languages, stage layers — is one
 * click away in the Window Manager rather than duplicated here.
 */
import { Box, Divider, MenuItem, Popover, Select, Stack, ToggleButton, Tooltip, Typography } from '@mui/material';
import {
  AcUnit as FreezeIcon,
  Close as CloseIcon,
  CropFree as FramelessIcon,
  Fullscreen as FullscreenIcon,
  OpenInNew as BringToFrontIcon,
  Palette as StyleIcon,
  Settings as SettingsIcon,
  TextFields as HideTextIcon,
  Tv as ScreenIcon,
  VerticalAlignTop as OnTopIcon,
  VisibilityOff as HideWindowIcon,
  Wallpaper as HideBackgroundIcon,
} from '@mui/icons-material';
import { useI18nContext } from '@/i18n/i18n-react';
import type { RigWindow } from '@/hooks/usePresentationWindows';
import type { WindowConfig } from '@/store/windowSlice';
import type { ScreenInfo } from './ScreenPicker';

export interface WindowQuickActionsProps {
  anchorEl: HTMLElement | null;
  window: RigWindow | undefined;
  styles: Array<{ id: number; name: string }>;
  screens: ScreenInfo[];
  onClose: () => void;
  onUpdate: (patch: Partial<WindowConfig>) => void;
  onToggleFreeze: () => void;
  onToggleHidden: () => void;
  onBringToFront: () => void;
  onCloseWindow: () => void;
  onMoveToScreen: (screen: ScreenInfo) => void;
  onOpenSettings: () => void;
}

/** One square toggle with its label underneath. */
const ActionToggle = ({
  active,
  label,
  icon,
  color,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: React.ReactNode;
  color?: 'primary' | 'warning' | 'error' | 'info';
  onClick: () => void;
}) => (
  <Tooltip title={label}>
    <ToggleButton
      value={label}
      selected={active}
      size="small"
      onChange={onClick}
      color={color}
      sx={{
        flexDirection: 'column',
        gap: 0.25,
        width: 72,
        py: 0.75,
        textTransform: 'none',
        lineHeight: 1.1,
      }}
    >
      {icon}
      <Typography variant="caption" noWrap sx={{ fontSize: '0.6rem', maxWidth: 64 }}>
        {label}
      </Typography>
    </ToggleButton>
  </Tooltip>
);

export const WindowQuickActions = ({
  anchorEl,
  window: win,
  styles,
  screens,
  onClose,
  onUpdate,
  onToggleFreeze,
  onToggleHidden,
  onBringToFront,
  onCloseWindow,
  onMoveToScreen,
  onOpenSettings,
}: WindowQuickActionsProps) => {
  const { LL } = useI18nContext();
  if (!win) return null;

  const cfg = win.config;

  return (
    <Popover
      open={Boolean(anchorEl)}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
      transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      slotProps={{ paper: { sx: { p: 1.5, width: 260 } } }}
    >
      <Stack spacing={1.25}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
          <Typography variant="subtitle2" noWrap sx={{ fontWeight: 700, flex: 1 }}>
            {win.name}
          </Typography>
          {win.screen && (
            <Tooltip title={win.screen.label}>
              <ScreenIcon sx={{ fontSize: 15, color: 'text.secondary' }} />
            </Tooltip>
          )}
        </Stack>

        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
          <ActionToggle
            active={win.frozen}
            color="info"
            label={LL.FOOTER.FREEZE()}
            icon={<FreezeIcon sx={{ fontSize: 18 }} />}
            onClick={onToggleFreeze}
          />
          <ActionToggle
            active={win.hidden}
            color="warning"
            label={LL.FOOTER.HIDE_WINDOW()}
            icon={<HideWindowIcon sx={{ fontSize: 18 }} />}
            onClick={onToggleHidden}
          />
          <ActionToggle
            active={!!cfg.hideText}
            color="warning"
            label={LL.WINDOW.HIDE_TEXT()}
            icon={<HideTextIcon sx={{ fontSize: 18 }} />}
            onClick={() => onUpdate({ hideText: !cfg.hideText })}
          />
          <ActionToggle
            active={!!cfg.hideBackground}
            color="warning"
            label={LL.WINDOW.HIDE_BACKGROUND()}
            icon={<HideBackgroundIcon sx={{ fontSize: 18 }} />}
            onClick={() => onUpdate({ hideBackground: !cfg.hideBackground })}
          />
          <ActionToggle
            active={!!cfg.fullscreen}
            label={LL.WINDOW.FULLSCREEN()}
            icon={<FullscreenIcon sx={{ fontSize: 18 }} />}
            onClick={() => onUpdate({ fullscreen: !cfg.fullscreen })}
          />
          <ActionToggle
            active={cfg.frameless !== false}
            label={LL.WINDOW.FRAMELESS()}
            icon={<FramelessIcon sx={{ fontSize: 18 }} />}
            onClick={() => onUpdate({ frameless: cfg.frameless === false })}
          />
          <ActionToggle
            active={!!cfg.alwaysOnTop}
            label={LL.WINDOW.ALWAYS_ON_TOP()}
            icon={<OnTopIcon sx={{ fontSize: 18 }} />}
            onClick={() => onUpdate({ alwaysOnTop: !cfg.alwaysOnTop })}
          />
          <ActionToggle
            active={false}
            label={LL.FOOTER.BRING_TO_FRONT()}
            icon={<BringToFrontIcon sx={{ fontSize: 18 }} />}
            onClick={onBringToFront}
          />
        </Box>

        {styles.length > 0 && (
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
            <StyleIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
            <Select
              size="small"
              value={cfg.styleId || 0}
              onChange={(e) => onUpdate({ styleId: (e.target.value as number) || undefined })}
              sx={{ flex: 1, fontSize: '0.8rem' }}
              displayEmpty
            >
              <MenuItem value={0} sx={{ fontSize: '0.8rem' }}>
                <em>{LL.STYLE.NONE()}</em>
              </MenuItem>
              {styles.map((s) => (
                <MenuItem key={s.id} value={s.id} sx={{ fontSize: '0.8rem' }}>
                  {s.name}
                </MenuItem>
              ))}
            </Select>
          </Stack>
        )}

        {screens.length > 1 && (
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
            <ScreenIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
            <Select
              size="small"
              value={win.screen?.id ?? ''}
              displayEmpty
              onChange={(e) => {
                const screen = screens.find((s) => s.id === e.target.value);
                if (screen) onMoveToScreen(screen);
              }}
              sx={{ flex: 1, fontSize: '0.8rem' }}
            >
              <MenuItem value="" disabled sx={{ fontSize: '0.8rem' }}>
                <em>{LL.WINDOW.MOVE_TO_SCREEN()}</em>
              </MenuItem>
              {screens.map((s) => (
                <MenuItem key={s.id} value={s.id} sx={{ fontSize: '0.8rem' }}>
                  {s.label}
                  {s.isPrimary ? ` (${LL.WINDOW.PRIMARY_SCREEN()})` : ''}
                </MenuItem>
              ))}
            </Select>
          </Stack>
        )}

        <Divider />

        <Stack direction="row" spacing={1}>
          <Stack
            direction="row"
            spacing={0.5}
            onClick={onOpenSettings}
            sx={{ alignItems: 'center', cursor: 'pointer', flex: 1, color: 'text.secondary', '&:hover': { color: 'text.primary' } }}
          >
            <SettingsIcon sx={{ fontSize: 16 }} />
            <Typography variant="caption">{LL.WINDOW.MORE_SETTINGS()}</Typography>
          </Stack>
          {/* Closing is now reversible — the configuration survives it — so it can sit here
              without a confirmation, but still separated from the toggles above. */}
          <Stack
            direction="row"
            spacing={0.5}
            onClick={onCloseWindow}
            sx={{ alignItems: 'center', cursor: 'pointer', color: 'error.main', opacity: 0.85, '&:hover': { opacity: 1 } }}
          >
            <CloseIcon sx={{ fontSize: 16 }} />
            <Typography variant="caption">{LL.WINDOW.CLOSE()}</Typography>
          </Stack>
        </Stack>
      </Stack>
    </Popover>
  );
};
