/**
 * The stage monitor's editor and transport.
 *
 * Same shape as the reworked Window Manager, for the same reason: a list of the things you
 * have on the left, the one you picked on the right, and the transport for it always
 * visible rather than behind an edit mode. The preview renders the real `StageOverlay` at
 * presentation aspect ratio, so what is being designed is literally what goes on the wall.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  Drawer,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Slider,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import {
  Add as AddIcon,
  Close as CloseIcon,
  DeleteOutlined as DeleteIcon,
  DragIndicator as DragIcon,
  HourglassEmpty as BlankIcon,
  Message as MessageIcon,
  Pause as PauseIcon,
  PlayArrow as ResumeIcon,
  Replay as ResetIcon,
  Schedule as ClockIcon,
  SkipNext as GoIcon,
  SkipPrevious as BackIcon,
  Timelapse as CountupIcon,
  Timer as CountdownIcon,
  Visibility as ShowIcon,
  VisibilityOff as HideIcon,
} from '@mui/icons-material';
import { useI18nContext } from '@/i18n/i18n-react';
import { useAppDispatch } from '@/store';
import { useGetSettings } from '@/store/settingsSlice';
import {
  stageBack,
  stageGo,
  stageReset,
  stageResetAll,
  stageSetCue,
  stageSetHidden,
  stageStart,
  stageTogglePause,
} from '@/store/stageSlice';
import {
  useCreateStageLayerMutation,
  useDeleteStageLayerMutation,
  useGetStageLayersQuery,
  useUpdateStageLayerMutation,
} from '@/api/stage.api';
import { useStageStatus } from '@/hooks/useStageEngine';
import { useWindowConfigs } from '@/store/windowSlice';
import {
  emptyStageLayerData,
  newCue,
  resolveCue,
  type StageAnchor,
  type StageCue,
  type StageCueKind,
  type StageLayerData,
  type StageLayerEntity,
} from '@/stage/types';
import { StageOverlay } from '@/presentation/StageOverlay';
import { StageCueEditor, cueKindLabel } from './StageCueEditor';

const CUE_KINDS: Array<{ kind: StageCueKind; Icon: typeof ClockIcon }> = [
  { kind: 'clock', Icon: ClockIcon },
  { kind: 'countdown', Icon: CountdownIcon },
  { kind: 'countup', Icon: CountupIcon },
  { kind: 'message', Icon: MessageIcon },
  { kind: 'blank', Icon: BlankIcon },
];

const ANCHORS: StageAnchor[] = [
  'top left',
  'top center',
  'top right',
  'center left',
  'center',
  'center right',
  'bottom left',
  'bottom center',
  'bottom right',
];

/**
 * The layer as it will actually look, at 16:9.
 *
 * It renders the shipping `StageOverlay` rather than an approximation, so a placement or
 * font size that looks right here cannot look wrong on the beamer.
 */
const LayerPreview = ({ layer, cueIndex, locale }: { layer: StageLayerEntity; cueIndex: number; locale: string }) => {
  const cue = layer.data.cues[cueIndex];
  const wire = cue ? resolveCue(cue, { cueIndex, startedAt: Date.now(), hidden: false }, locale) : null;

  return (
    <Box
      sx={{
        position: 'relative',
        width: '100%',
        aspectRatio: '16 / 9',
        bgcolor: '#000',
        borderRadius: 1,
        overflow: 'hidden',
        // The overlay measures this box and sizes itself against it, so no scaling trickery
        // is needed — what renders here is the same component the beamer runs.
      }}
    >
      {wire && (
        <StageOverlay payload={{ layers: [{ id: layer.id, placement: layer.data.placement, style: layer.data.style, cue: wire }] }} />
      )}
    </Box>
  );
};

const CueRow = ({
  cue,
  index,
  active,
  onSelect,
  onDelete,
  onDragStart,
  onDrop,
}: {
  cue: StageCue;
  index: number;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onDragStart: () => void;
  onDrop: () => void;
}) => {
  const { LL } = useI18nContext();
  const Icon = CUE_KINDS.find((k) => k.kind === cue.kind)?.Icon ?? ClockIcon;

  return (
    <Stack
      direction="row"
      spacing={0.75}
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onClick={onSelect}
      sx={(theme) => ({
        alignItems: 'center',
        px: 1,
        py: 0.5,
        cursor: 'pointer',
        borderRadius: 1,
        bgcolor: active ? alpha(theme.palette.primary.main, 0.12) : 'transparent',
        '&:hover': { bgcolor: alpha(theme.palette.primary.main, active ? 0.16 : 0.05) },
      })}
    >
      <DragIcon sx={{ fontSize: 15, color: 'text.disabled', cursor: 'grab' }} />
      <Icon sx={{ fontSize: 16, color: active ? 'primary.main' : 'text.secondary' }} />
      <Typography variant="body2" noWrap sx={{ flex: 1, fontWeight: active ? 600 : 400 }}>
        {cue.name || cueKindLabel(cue.kind, LL)}
      </Typography>
      {active && (
        <Typography variant="caption" sx={{ color: 'primary.main' }}>
          {LL.STAGE.CUE_ACTIVE()}
        </Typography>
      )}
      <IconButton
        size="small"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        <DeleteIcon sx={{ fontSize: 15 }} />
      </IconButton>
      <Typography variant="caption" sx={{ color: 'text.disabled', width: 16, textAlign: 'right' }}>
        {index + 1}
      </Typography>
    </Stack>
  );
};

export const StagePanel = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const { LL } = useI18nContext();
  const dispatch = useAppDispatch();
  const { uiLanguage } = useGetSettings();
  const locale = uiLanguage || 'en';

  const { data: layers = [] } = useGetStageLayersQuery();
  const [createLayer] = useCreateStageLayerMutation();
  const [updateLayer] = useUpdateStageLayerMutation();
  const [deleteLayer] = useDeleteStageLayerMutation();
  const { statuses } = useStageStatus();
  const windowConfigs = useWindowConfigs();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const [pendingDelete, setPendingDelete] = useState<StageLayerEntity | null>(null);
  const [editingCueIndex, setEditingCueIndex] = useState(0);
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  const selected = layers.find((l) => l.id === selectedId);
  const status = statuses.find((s) => s.layer.id === selectedId);

  // Select something as soon as there is something to select, so the panel never opens on
  // an empty right-hand side when layers do exist.
  useEffect(() => {
    if (open && selectedId === null && layers.length > 0) setSelectedId(layers[0].id);
  }, [open, selectedId, layers]);

  /** How many windows a layer is actually going to appear on — the thing people forget. */
  const windowCountFor = useCallback(
    (layerId: number) => windowConfigs.filter((c) => (c.stageLayerIds ?? []).includes(layerId)).length,
    [windowConfigs],
  );

  const patchData = useCallback(
    (layer: StageLayerEntity, patch: Partial<StageLayerData>) => {
      void updateLayer({ id: layer.id, data: { ...layer.data, ...patch } });
    },
    [updateLayer],
  );

  const patchCue = useCallback(
    (layer: StageLayerEntity, index: number, patch: Partial<StageCue>) => {
      const cues = layer.data.cues.map((c, i) => (i === index ? ({ ...c, ...patch } as StageCue) : c));
      patchData(layer, { cues });
    },
    [patchData],
  );

  const addCue = useCallback(
    (layer: StageLayerEntity, kind: StageCueKind) => {
      const cues = [...layer.data.cues, newCue(kind)];
      patchData(layer, { cues });
      setEditingCueIndex(cues.length - 1);
      setAddAnchor(null);
    },
    [patchData],
  );

  const handleCreateLayer = useCallback(async () => {
    // Names are unique per account in the database, so a fresh one is numbered rather than
    // colliding with the last "Stage layer".
    const base = String(LL.STAGE.NEW_LAYER_NAME());
    const taken = new Set(layers.map((l) => l.name));
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base} ${i}`;

    const created = await createLayer({ name, data: emptyStageLayerData(), sort_order: layers.length }).unwrap();
    if (created?.id) setSelectedId(created.id);
  }, [createLayer, layers, LL]);

  const now = Date.now();

  return (
    <Drawer open={open} anchor="right" onClose={onClose}>
      <Stack sx={{ width: 'min(96vw, 900px)', height: '100%' }}>
        <Stack direction="row" sx={{ alignItems: 'center', p: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>
            {LL.STAGE.PANEL_TITLE()}
          </Typography>
          <Box sx={{ flexGrow: 1 }} />
          <Button size="small" variant="contained" startIcon={<AddIcon />} onClick={() => void handleCreateLayer()}>
            {LL.STAGE.ADD_LAYER()}
          </Button>
          <IconButton onClick={onClose} sx={{ ml: 1 }}>
            <CloseIcon />
          </IconButton>
        </Stack>

        <Stack direction="row" sx={{ flex: 1, minHeight: 0 }}>
          {/* Layers */}
          <Stack sx={{ width: 240, minWidth: 200, overflow: 'auto', borderRight: 1, borderColor: 'divider' }}>
            {layers.length === 0 ? (
              <Stack sx={{ p: 2, gap: 0.5 }}>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  {LL.STAGE.NO_LAYERS()}
                </Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {LL.STAGE.NO_LAYERS_HINT()}
                </Typography>
              </Stack>
            ) : (
              layers.map((layer) => {
                const st = statuses.find((s) => s.layer.id === layer.id);
                const windows = windowCountFor(layer.id);
                return (
                  <Stack
                    key={layer.id}
                    onClick={() => {
                      setSelectedId(layer.id);
                      setEditingCueIndex(0);
                    }}
                    sx={(theme) => ({
                      px: 1.25,
                      py: 0.75,
                      cursor: 'pointer',
                      borderLeft: '3px solid',
                      borderLeftColor: selectedId === layer.id ? 'primary.main' : 'transparent',
                      bgcolor: selectedId === layer.id ? alpha(theme.palette.primary.main, 0.08) : 'transparent',
                      borderBottom: 1,
                      borderBottomColor: 'divider',
                      opacity: layer.enabled ? 1 : 0.5,
                    })}
                  >
                    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                      <Typography variant="body2" noWrap sx={{ fontWeight: 600, flex: 1 }}>
                        {layer.name}
                      </Typography>
                      {st?.hidden && <HideIcon sx={{ fontSize: 14, color: 'warning.main' }} />}
                    </Stack>
                    <Typography variant="caption" sx={{ color: windows === 0 ? 'warning.main' : 'text.secondary' }}>
                      {windows === 0 ? LL.STAGE.ASSIGNED_TO_NONE() : LL.STAGE.ASSIGNED_TO({ count: windows })}
                    </Typography>
                  </Stack>
                );
              })
            )}
          </Stack>

          {/* Selected layer */}
          {selected ? (
            <Stack sx={{ flex: 1, minWidth: 0, overflow: 'auto', p: 1.5, gap: 1.5 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <TextField
                  size="small"
                  label={LL.STAGE.LAYER_NAME()}
                  value={selected.name}
                  onChange={(e) => void updateLayer({ id: selected.id, name: e.target.value })}
                  sx={{ flex: 1 }}
                />
                <Tooltip title={LL.STAGE.ENABLED()}>
                  <Switch
                    size="small"
                    checked={selected.enabled}
                    onChange={(e) => void updateLayer({ id: selected.id, enabled: e.target.checked })}
                  />
                </Tooltip>
                <Tooltip title={LL.STAGE.DELETE_LAYER()}>
                  <IconButton size="small" color="error" onClick={() => setPendingDelete(selected)}>
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>

              {/* Transport — always visible, never behind an edit mode. */}
              <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <Tooltip title={LL.STAGE.START()}>
                  <IconButton size="small" color="primary" onClick={() => dispatch(stageStart({ layerId: selected.id, at: now }))}>
                    <ResumeIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title={LL.STAGE.BACK()}>
                  <IconButton size="small" onClick={() => dispatch(stageBack({ layerId: selected.id, at: now }))}>
                    <BackIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title={LL.STAGE.GO()}>
                  <IconButton
                    size="small"
                    onClick={() => dispatch(stageGo({ layerId: selected.id, cueCount: selected.data.cues.length, at: now }))}
                  >
                    <GoIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title={status?.paused ? LL.STAGE.RESUME() : LL.STAGE.PAUSE()}>
                  <IconButton size="small" onClick={() => dispatch(stageTogglePause({ layerId: selected.id, at: now }))}>
                    {status?.paused ? <ResumeIcon fontSize="small" /> : <PauseIcon fontSize="small" />}
                  </IconButton>
                </Tooltip>
                <Tooltip title={LL.STAGE.RESET()}>
                  <IconButton size="small" onClick={() => dispatch(stageReset({ layerId: selected.id, at: now }))}>
                    <ResetIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title={LL.STAGE.RESET_ALL()}>
                  <IconButton size="small" onClick={() => dispatch(stageResetAll({ layerId: selected.id, at: now }))}>
                    <BackIcon fontSize="small" sx={{ transform: 'scaleX(-1) rotate(180deg)' }} />
                  </IconButton>
                </Tooltip>
                <Tooltip title={status?.hidden ? LL.STAGE.SHOW() : LL.STAGE.HIDE()}>
                  <IconButton
                    size="small"
                    color={status?.hidden ? 'warning' : 'default'}
                    onClick={() => dispatch(stageSetHidden({ layerId: selected.id, hidden: !status?.hidden, at: now }))}
                  >
                    {status?.hidden ? <ShowIcon fontSize="small" /> : <HideIcon fontSize="small" />}
                  </IconButton>
                </Tooltip>
                <Box sx={{ flexGrow: 1 }} />
                {status && selected.data.cues.length > 0 && (
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {status.finished ? LL.STAGE.FINISHED() : LL.STAGE.CUE_OF({ index: status.cueIndex + 1, total: status.cueCount })}
                  </Typography>
                )}
              </Stack>

              <LayerPreview layer={selected} cueIndex={editingCueIndex} locale={locale} />

              {/* Placement */}
              <Stack spacing={0.75}>
                <Typography variant="overline" sx={{ color: 'text.secondary' }}>
                  {LL.STAGE.PLACEMENT()}
                </Typography>
                <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 40px)', gap: 0.5 }}>
                  {ANCHORS.map((anchor) => (
                    <ToggleButton
                      key={anchor}
                      value={anchor}
                      selected={selected.data.placement.anchor === anchor}
                      size="small"
                      onChange={() => patchData(selected, { placement: { ...selected.data.placement, anchor } })}
                      sx={{ height: 30, p: 0 }}
                    >
                      <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'currentColor' }} />
                    </ToggleButton>
                  ))}
                </Box>
                <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
                  <Stack sx={{ flex: 1 }}>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      {LL.STAGE.WIDTH()} · {selected.data.placement.widthPct}%
                    </Typography>
                    <Slider
                      size="small"
                      min={10}
                      max={100}
                      value={selected.data.placement.widthPct}
                      onChange={(_e, v) => patchData(selected, { placement: { ...selected.data.placement, widthPct: v as number } })}
                    />
                  </Stack>
                  <Stack sx={{ flex: 1 }}>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      {LL.STAGE.MARGIN()} · {selected.data.placement.marginPct}%
                    </Typography>
                    <Slider
                      size="small"
                      min={0}
                      max={30}
                      value={selected.data.placement.marginPct}
                      onChange={(_e, v) => patchData(selected, { placement: { ...selected.data.placement, marginPct: v as number } })}
                    />
                  </Stack>
                </Stack>
              </Stack>

              {/* Appearance */}
              <Stack spacing={0.75}>
                <Typography variant="overline" sx={{ color: 'text.secondary' }}>
                  {LL.STAGE.APPEARANCE()}
                </Typography>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <Stack sx={{ flex: 1 }}>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      {LL.STAGE.FONT_SIZE()} · {selected.data.style.fontSizePct}%
                    </Typography>
                    <Slider
                      size="small"
                      min={2}
                      max={40}
                      value={selected.data.style.fontSizePct}
                      onChange={(_e, v) => patchData(selected, { style: { ...selected.data.style, fontSizePct: v as number } })}
                    />
                  </Stack>
                  <Tooltip title={LL.STAGE.COLOR()}>
                    <input
                      type="color"
                      value={selected.data.style.color}
                      onChange={(e) => patchData(selected, { style: { ...selected.data.style, color: e.target.value } })}
                      style={{ width: 34, height: 30, border: 'none', background: 'none', cursor: 'pointer' }}
                    />
                  </Tooltip>
                  <Tooltip title={LL.STAGE.WARN_COLOR()}>
                    <input
                      type="color"
                      value={selected.data.style.warnColor ?? '#FFB300'}
                      onChange={(e) => patchData(selected, { style: { ...selected.data.style, warnColor: e.target.value } })}
                      style={{ width: 34, height: 30, border: 'none', background: 'none', cursor: 'pointer' }}
                    />
                  </Tooltip>
                  <Tooltip title={LL.STAGE.DANGER_COLOR()}>
                    <input
                      type="color"
                      value={selected.data.style.dangerColor ?? '#E53935'}
                      onChange={(e) => patchData(selected, { style: { ...selected.data.style, dangerColor: e.target.value } })}
                      style={{ width: 34, height: 30, border: 'none', background: 'none', cursor: 'pointer' }}
                    />
                  </Tooltip>
                </Stack>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <ToggleButtonGroup
                    size="small"
                    exclusive
                    value={selected.data.style.textAlign ?? 'center'}
                    onChange={(_e, v) => v && patchData(selected, { style: { ...selected.data.style, textAlign: v } })}
                  >
                    <ToggleButton value="left">L</ToggleButton>
                    <ToggleButton value="center">C</ToggleButton>
                    <ToggleButton value="right">R</ToggleButton>
                  </ToggleButtonGroup>
                  <ToggleButton
                    size="small"
                    value="bold"
                    selected={!!selected.data.style.bold}
                    onChange={() => patchData(selected, { style: { ...selected.data.style, bold: !selected.data.style.bold } })}
                    sx={{ fontWeight: 700 }}
                  >
                    {LL.STAGE.BOLD()}
                  </ToggleButton>
                  <Stack sx={{ flex: 1 }}>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      {LL.STAGE.BACKGROUND_OPACITY()}
                    </Typography>
                    <Slider
                      size="small"
                      min={0}
                      max={1}
                      step={0.05}
                      value={selected.data.style.backgroundOpacity ?? 0}
                      onChange={(_e, v) =>
                        patchData(selected, {
                          style: {
                            ...selected.data.style,
                            backgroundOpacity: v as number,
                            // A panel with no colour set would stay invisible however far the
                            // slider is pushed, so give it one the moment it is asked for.
                            background: selected.data.style.background ?? '#000000',
                          },
                        })
                      }
                    />
                  </Stack>
                  <input
                    type="color"
                    value={selected.data.style.background ?? '#000000'}
                    onChange={(e) => patchData(selected, { style: { ...selected.data.style, background: e.target.value } })}
                    style={{ width: 34, height: 30, border: 'none', background: 'none', cursor: 'pointer' }}
                  />
                </Stack>
              </Stack>

              <Divider />

              {/* Cues */}
              <Stack direction="row" sx={{ alignItems: 'center' }}>
                <Typography variant="overline" sx={{ color: 'text.secondary', flex: 1 }}>
                  {LL.STAGE.CUES()}
                </Typography>
                <Button size="small" startIcon={<AddIcon />} onClick={(e) => setAddAnchor(e.currentTarget)}>
                  {LL.STAGE.ADD_CUE()}
                </Button>
              </Stack>

              {selected.data.cues.length === 0 ? (
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  {LL.STAGE.NO_CUES()}
                </Typography>
              ) : (
                <Stack spacing={0.25}>
                  {selected.data.cues.map((cue, index) => (
                    <CueRow
                      key={cue.id}
                      cue={cue}
                      index={index}
                      active={status?.cueIndex === index}
                      onSelect={() => {
                        setEditingCueIndex(index);
                        // Selecting a cue in the list also takes the layer there — an editor
                        // that previews a cue the screen is not showing invites mistakes.
                        dispatch(stageSetCue({ layerId: selected.id, cueIndex: index, at: Date.now() }));
                      }}
                      onDelete={() => patchData(selected, { cues: selected.data.cues.filter((_c, i) => i !== index) })}
                      onDragStart={() => setDragFrom(index)}
                      onDrop={() => {
                        if (dragFrom === null || dragFrom === index) return;
                        const cues = [...selected.data.cues];
                        const [moved] = cues.splice(dragFrom, 1);
                        cues.splice(index, 0, moved);
                        patchData(selected, { cues });
                        setDragFrom(null);
                      }}
                    />
                  ))}
                </Stack>
              )}

              {selected.data.cues[editingCueIndex] && (
                <>
                  <Divider />
                  <StageCueEditor
                    cue={selected.data.cues[editingCueIndex]}
                    onChange={(patch) => patchCue(selected, editingCueIndex, patch)}
                  />
                </>
              )}
            </Stack>
          ) : (
            <Stack sx={{ flex: 1, alignItems: 'center', justifyContent: 'center', p: 3 }}>
              <Typography variant="body2" sx={{ color: 'text.secondary', textAlign: 'center' }}>
                {LL.STAGE.NO_LAYERS_HINT()}
              </Typography>
            </Stack>
          )}
        </Stack>
      </Stack>

      <Menu anchorEl={addAnchor} open={Boolean(addAnchor)} onClose={() => setAddAnchor(null)}>
        {CUE_KINDS.map(({ kind, Icon }) => (
          <MenuItem key={kind} onClick={() => selected && addCue(selected, kind)}>
            <ListItemIcon>
              <Icon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{cueKindLabel(kind, LL)}</ListItemText>
          </MenuItem>
        ))}
      </Menu>

      <Dialog open={!!pendingDelete} onClose={() => setPendingDelete(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{LL.STAGE.DELETE_LAYER()}</DialogTitle>
        <DialogContent>
          <DialogContentText variant="body2">{LL.STAGE.DELETE_LAYER_CONFIRM({ name: pendingDelete?.name ?? '' })}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingDelete(null)}>{LL.COMMON.CANCEL()}</Button>
          <Button
            variant="contained"
            color="error"
            onClick={() => {
              if (pendingDelete) {
                void deleteLayer({ id: pendingDelete.id });
                if (selectedId === pendingDelete.id) setSelectedId(null);
              }
              setPendingDelete(null);
            }}
          >
            {LL.COMMON.DELETE()}
          </Button>
        </DialogActions>
      </Dialog>
    </Drawer>
  );
};
