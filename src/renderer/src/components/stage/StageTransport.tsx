/**
 * The stage monitor's transport, as it appears in the operator footer.
 *
 * One chip per live layer showing the same value the beamer is showing, with Go, Skip and
 * Hide on it. During a service the countdown is the thing the operator is watching, so it
 * belongs on the always-visible strip rather than behind a panel.
 *
 * It ticks locally, exactly like the overlay does — the operator's number comes from the
 * same absolute anchors and the same renderer, so the two cannot drift apart.
 */
import { useEffect, useState } from 'react';
import { Chip, IconButton, Stack, Tooltip } from '@mui/material';
import {
  Pause as PauseIcon,
  PlayArrow as ResumeIcon,
  SkipNext as GoIcon,
  Timer as StageIcon,
  Visibility as ShowIcon,
  VisibilityOff as HideIcon,
} from '@mui/icons-material';
import { useI18nContext } from '@/i18n/i18n-react';
import { useAppDispatch } from '@/store';
import { stageGo, stageSetHidden, stageTogglePause } from '@/store/stageSlice';
import { useGetSettings } from '@/store/settingsSlice';
import { renderStageCue, resolveCue, stageUrgency } from '@/stage/types';
import type { StageLayerStatus } from '@/hooks/useStageEngine';

/** Same cadence as the overlay: fast enough that a seconds digit never appears to skip. */
const TICK_MS = 250;

export interface StageTransportProps {
  statuses: StageLayerStatus[];
  allHidden: boolean;
  onOpenPanel: () => void;
}

const StageChip = ({ status, locale }: { status: StageLayerStatus; locale: string }) => {
  const { LL } = useI18nContext();
  const dispatch = useAppDispatch();
  const [now, setNow] = useState(() => Date.now());

  const wire = status.cue
    ? resolveCue(
        status.cue,
        { cueIndex: status.cueIndex, startedAt: status.startedAt, pausedAt: status.pausedAt, hidden: status.hidden },
        locale,
      )
    : null;
  const live = !!wire && (wire.kind === 'clock' || (wire.kind === 'timer' && !status.paused));

  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [live]);

  if (!status.cue) return null;

  const rendered = wire ? renderStageCue(wire, now, locale) : null;
  const urgency = wire && rendered ? stageUrgency(wire, rendered.remainingSec) : 'normal';
  // A blank or empty-message cue has nothing to render but is still a real position in the
  // sequence, so the chip shows the layer name and Go still works.
  const value = rendered?.text || status.layer.name;

  return (
    <Stack direction="row" spacing={0.25} sx={{ alignItems: 'center' }}>
      <Tooltip title={`${status.layer.name} — ${LL.STAGE.CUE_OF({ index: status.cueIndex + 1, total: status.cueCount })}`}>
        <Chip
          size="small"
          icon={<StageIcon sx={{ fontSize: 14 }} />}
          label={value}
          variant={status.hidden ? 'outlined' : 'filled'}
          color={urgency === 'danger' ? 'error' : urgency === 'warn' ? 'warning' : 'default'}
          onClick={() => dispatch(stageTogglePause({ layerId: status.layer.id, at: Date.now() }))}
          sx={{
            fontSize: '0.72rem',
            // Tabular figures so the strip does not jitter as the digits change width.
            fontVariantNumeric: 'tabular-nums',
            opacity: status.hidden ? 0.5 : 1,
            cursor: 'pointer',
          }}
        />
      </Tooltip>
      <Tooltip title={status.paused ? LL.STAGE.RESUME() : LL.STAGE.PAUSE()}>
        <IconButton size="small" onClick={() => dispatch(stageTogglePause({ layerId: status.layer.id, at: Date.now() }))}>
          {status.paused ? <ResumeIcon sx={{ fontSize: 15 }} /> : <PauseIcon sx={{ fontSize: 15 }} />}
        </IconButton>
      </Tooltip>
      <Tooltip title={LL.STAGE.GO()}>
        <IconButton size="small" onClick={() => dispatch(stageGo({ layerId: status.layer.id, cueCount: status.cueCount, at: Date.now() }))}>
          <GoIcon sx={{ fontSize: 15 }} />
        </IconButton>
      </Tooltip>
      <Tooltip title={status.hidden ? LL.STAGE.SHOW() : LL.STAGE.HIDE()}>
        <IconButton
          size="small"
          color={status.hidden ? 'warning' : 'default'}
          onClick={() => dispatch(stageSetHidden({ layerId: status.layer.id, hidden: !status.hidden, at: Date.now() }))}
        >
          {status.hidden ? <ShowIcon sx={{ fontSize: 15 }} /> : <HideIcon sx={{ fontSize: 15 }} />}
        </IconButton>
      </Tooltip>
    </Stack>
  );
};

export const StageTransport = ({ statuses, allHidden, onOpenPanel }: StageTransportProps) => {
  const { LL } = useI18nContext();
  const { uiLanguage } = useGetSettings();

  // Only layers with something up. A layer parked past its last cue, or disabled, is not
  // part of what is happening right now and would only take space on the strip.
  const running = statuses.filter((s) => s.layer.enabled && s.cue);
  if (running.length === 0) return null;

  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', opacity: allHidden ? 0.4 : 1 }}>
      <Tooltip title={LL.STAGE.OPEN_PANEL()}>
        <IconButton size="small" onClick={onOpenPanel}>
          <StageIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      {running.map((status) => (
        <StageChip key={status.layer.id} status={status} locale={uiLanguage || 'en'} />
      ))}
    </Stack>
  );
};
