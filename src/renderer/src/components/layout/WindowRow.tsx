/**
 * One configured window, as a single 40px row.
 *
 * The state toggles an operator actually reaches for mid-service — black, freeze, hide —
 * sit on the row itself. Everything else is behind the row menu or in the inspector, so a
 * six-window rig still fits on screen next to the desk.
 */
import { useState, type MouseEvent } from 'react';
import { Chip, IconButton, ListItemIcon, ListItemText, Menu, MenuItem, Stack, Tooltip, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import {
  AcUnit as FreezeIcon,
  Cast as StreamIcon,
  Close as CloseIcon,
  DeleteOutlined as DeleteIcon,
  Monitor as NormalIcon,
  MoreVert as MoreIcon,
  OpenInNew as BringToFrontIcon,
  Palette as StyleIcon,
  PlayArrow as OpenIcon,
  Tv as ScreenIcon,
  Visibility as ShowIcon,
  VisibilityOff as HideIcon,
} from '@mui/icons-material';
import { useI18nContext } from '@/i18n/i18n-react';
import type { RigWindow } from '@/hooks/usePresentationWindows';

export interface WindowRowProps {
  window: RigWindow;
  selected: boolean;
  styleName?: string;
  stageLayerCount: number;
  onSelect: () => void;
  onOpen: () => void;
  onClose: () => void;
  onDelete: () => void;
  onToggleFreeze: () => void;
  onToggleHidden: () => void;
  onBringToFront: () => void;
}

export const WindowRow = ({
  window: win,
  selected,
  styleName,
  stageLayerCount,
  onSelect,
  onOpen,
  onClose,
  onDelete,
  onToggleFreeze,
  onToggleHidden,
  onBringToFront,
}: WindowRowProps) => {
  const { LL } = useI18nContext();
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);

  const openMenu = (e: MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    setMenuAnchor(e.currentTarget);
  };
  const closeMenu = () => setMenuAnchor(null);
  const run = (fn: () => void) => () => {
    closeMenu();
    fn();
  };

  return (
    <>
      <Stack
        direction="row"
        spacing={0.75}
        onClick={onSelect}
        sx={(theme) => ({
          alignItems: 'center',
          px: 1,
          py: 0.5,
          minHeight: 40,
          cursor: 'pointer',
          borderLeft: '3px solid',
          borderLeftColor: selected ? 'primary.main' : 'transparent',
          bgcolor: selected ? alpha(theme.palette.primary.main, 0.08) : 'transparent',
          // A closed window is still a real part of the rig, just dimmed — not hidden away.
          opacity: win.isOpen ? 1 : 0.6,
          borderBottom: 1,
          borderBottomColor: 'divider',
          '&:hover': { bgcolor: alpha(theme.palette.primary.main, selected ? 0.12 : 0.04) },
        })}
      >
        {win.config.displayMode === 'stream' ? (
          <StreamIcon fontSize="small" color="action" />
        ) : (
          <NormalIcon fontSize="small" color="action" />
        )}

        <Typography variant="body2" noWrap sx={{ fontWeight: 600, minWidth: 0, flexShrink: 1 }}>
          {win.name}
        </Typography>

        {!win.isOpen && <Chip label={LL.WINDOW.CLOSED()} size="small" variant="outlined" sx={{ height: 17, fontSize: '0.6rem' }} />}

        {win.unmanaged && (
          <Tooltip title={LL.WINDOW.UNMANAGED_HINT()}>
            <Chip label={LL.WINDOW.UNMANAGED()} size="small" color="warning" variant="outlined" sx={{ height: 17, fontSize: '0.6rem' }} />
          </Tooltip>
        )}

        {win.screen && (
          <Chip
            icon={<ScreenIcon sx={{ fontSize: '0.7rem' }} />}
            label={win.screen.label}
            size="small"
            variant="outlined"
            sx={{ height: 17, fontSize: '0.6rem', maxWidth: 130 }}
          />
        )}

        {styleName && (
          <Chip
            icon={<StyleIcon sx={{ fontSize: '0.7rem' }} />}
            label={styleName}
            size="small"
            variant="outlined"
            sx={{ height: 17, fontSize: '0.6rem', maxWidth: 120 }}
          />
        )}

        {stageLayerCount > 0 && (
          <Tooltip title={LL.WINDOW.STAGE_LAYERS()}>
            <Chip label={`⏱ ${stageLayerCount}`} size="small" variant="outlined" sx={{ height: 17, fontSize: '0.6rem' }} />
          </Tooltip>
        )}

        <div style={{ flexGrow: 1 }} />

        {win.isOpen ? (
          <>
            <Tooltip title={win.hidden ? LL.FOOTER.SHOW_WINDOW() : LL.FOOTER.HIDE_WINDOW()}>
              <IconButton
                size="small"
                color={win.hidden ? 'warning' : 'default'}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleHidden();
                }}
              >
                {win.hidden ? <ShowIcon fontSize="small" /> : <HideIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
            <Tooltip title={win.frozen ? LL.FOOTER.UNFREEZE() : LL.FOOTER.FREEZE()}>
              <IconButton
                size="small"
                color={win.frozen ? 'info' : 'default'}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleFreeze();
                }}
              >
                <FreezeIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </>
        ) : (
          <Tooltip title={LL.WINDOW.OPEN()}>
            <IconButton
              size="small"
              color="primary"
              onClick={(e) => {
                e.stopPropagation();
                onOpen();
              }}
            >
              <OpenIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}

        <IconButton size="small" onClick={openMenu}>
          <MoreIcon fontSize="small" />
        </IconButton>
      </Stack>

      <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={closeMenu}>
        {win.isOpen && (
          <MenuItem onClick={run(onBringToFront)}>
            <ListItemIcon>
              <BringToFrontIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{LL.FOOTER.BRING_TO_FRONT()}</ListItemText>
          </MenuItem>
        )}
        {win.isOpen ? (
          <MenuItem onClick={run(onClose)}>
            <ListItemIcon>
              <CloseIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{LL.WINDOW.CLOSE()}</ListItemText>
          </MenuItem>
        ) : (
          <MenuItem onClick={run(onOpen)}>
            <ListItemIcon>
              <OpenIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{LL.WINDOW.OPEN()}</ListItemText>
          </MenuItem>
        )}
        {/* Deleting is the only destructive action here now that closing is reversible, so
            it sits last and alone rather than at the top of the list. */}
        {!win.unmanaged && (
          <MenuItem onClick={run(onDelete)}>
            <ListItemIcon>
              <DeleteIcon fontSize="small" color="error" />
            </ListItemIcon>
            <ListItemText sx={{ color: 'error.main' }}>{LL.WINDOW.DELETE()}</ListItemText>
          </MenuItem>
        )}
      </Menu>
    </>
  );
};
