/**
 * AudioMixerSection — the operator's side of monitor mixing.
 *
 * Everything here is a device setting rather than an account one, and that is the point:
 * the bridge lives on the venue's LAN, so its address describes *where this laptop is
 * standing*. A second campus with its own desk needs its own answer, and one shared
 * account-wide value would have the two overwrite each other every service.
 *
 * The bus list can only be filled in once the bridge is connected, because the desk is
 * what decides which buses exist and what they are called. That is why the switch comes
 * first and the allow-list is empty until it is on — a picker of remembered names would
 * be a picker of names that may no longer mean anything.
 */
import { Alert, Box, Chip, Divider, FormControlLabel, Stack, Switch, TextField, Typography } from '@mui/material';
import { useI18nContext } from '@/i18n/i18n-react';
import { useGetSettings, useUpdateSetting, type AudioMixerSettings } from '@/store/settingsSlice';
import { useGetAudioMixerStatus } from '@/store/audioMixerSlice';

export const AudioMixerSection = () => {
  const { LL } = useI18nContext();
  const { audioMixer } = useGetSettings();
  const updateSetting = useUpdateSetting();
  const status = useGetAudioMixerStatus();

  const patch = (changes: Partial<AudioMixerSettings>) => updateSetting('audioMixer', { ...audioMixer, ...changes });

  const buses = status.mixes.filter((mix) => mix.kind === 'bus');
  const hasMain = status.mixes.some((mix) => mix.kind === 'main');

  const toggleBus = (id: string) => {
    const next = audioMixer.buses.includes(id) ? audioMixer.buses.filter((bus) => bus !== id) : [...audioMixer.buses, id];
    patch({ buses: next });
  };

  /** One line saying what the link is actually doing, in the operator's own words. */
  const statusLine = (): { severity: 'success' | 'info' | 'warning' | 'error'; text: string } => {
    if (!audioMixer.enabled) return { severity: 'info', text: LL.AUDIO_MIXER.STATUS_OFF() };
    if (status.error === 'secret') return { severity: 'error', text: LL.AUDIO_MIXER.STATUS_SECRET() };
    switch (status.link) {
      case 'connected':
        return {
          severity: 'success',
          text: LL.AUDIO_MIXER.STATUS_CONNECTED({
            model: status.mixer?.model || status.mixer?.type || '?',
            firmware: status.mixer?.firmware || '?',
          }),
        };
      case 'no-desk':
        return { severity: 'warning', text: LL.AUDIO_MIXER.STATUS_NO_DESK() };
      case 'connecting':
        return { severity: 'info', text: LL.AUDIO_MIXER.STATUS_CONNECTING() };
      case 'schema':
        return { severity: 'error', text: LL.AUDIO_MIXER.STATUS_SCHEMA() };
      default:
        return { severity: 'warning', text: LL.AUDIO_MIXER.STATUS_OFFLINE() };
    }
  };

  const state = statusLine();

  const permission = (label: string, description: string, checked: boolean, onChange: (value: boolean) => void, disabled = false) => (
    <Box>
      <FormControlLabel
        control={<Switch size="small" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />}
        label={<Typography variant="body2">{label}</Typography>}
      />
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', ml: 6, mt: -0.75 }}>
        {description}
      </Typography>
    </Box>
  );

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="subtitle2">{LL.SETTINGS.SECTIONS.AUDIO_MIXER()}</Typography>
        <Typography variant="body2" color="text.secondary">
          {LL.SETTINGS.AUDIO_MIXER_DESC()}
        </Typography>
      </Box>

      <FormControlLabel
        control={<Switch checked={audioMixer.enabled} onChange={(event) => patch({ enabled: event.target.checked })} />}
        label={<Typography variant="body2">{LL.AUDIO_MIXER.ENABLED()}</Typography>}
      />

      <Alert severity={state.severity} variant="outlined" sx={{ py: 0.25 }}>
        {state.text}
        {audioMixer.enabled && status.subscribers > 0 && ` · ${LL.AUDIO_MIXER.SUBSCRIBERS({ count: status.subscribers })}`}
      </Alert>

      <Stack direction="row" spacing={1.5}>
        <TextField
          label={LL.AUDIO_MIXER.HOST()}
          size="small"
          fullWidth
          value={audioMixer.host}
          onChange={(event) => patch({ host: event.target.value.trim() })}
          helperText={LL.AUDIO_MIXER.HOST_DESC()}
        />
        <TextField
          label={LL.AUDIO_MIXER.PORT()}
          size="small"
          type="number"
          sx={{ width: 120 }}
          value={audioMixer.port}
          onChange={(event) => patch({ port: Number(event.target.value) || 5003 })}
        />
      </Stack>

      <TextField
        label={LL.AUDIO_MIXER.SECRET()}
        size="small"
        fullWidth
        type="password"
        autoComplete="off"
        value={audioMixer.secret}
        onChange={(event) => patch({ secret: event.target.value })}
        helperText={LL.AUDIO_MIXER.SECRET_DESC()}
      />

      <Divider />

      {/* Which mixes musicians may pick */}
      <Box>
        <Typography variant="subtitle2">{LL.AUDIO_MIXER.BUSES()}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {LL.AUDIO_MIXER.BUSES_DESC()}
        </Typography>
        {buses.length === 0 ? (
          <Typography variant="caption" color="text.secondary">
            {LL.AUDIO_MIXER.NO_BUSES()}
          </Typography>
        ) : (
          <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75 }}>
            {buses.map((bus) => {
              const on = audioMixer.buses.includes(bus.id);
              return (
                <Chip
                  key={bus.id}
                  label={bus.name}
                  size="small"
                  color={on ? 'primary' : 'default'}
                  variant={on ? 'filled' : 'outlined'}
                  onClick={() => toggleBus(bus.id)}
                />
              );
            })}
          </Stack>
        )}
      </Box>

      <Divider />

      <Box>
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          {LL.AUDIO_MIXER.PERMISSIONS()}
        </Typography>
        <Stack spacing={1}>
          {permission(
            LL.AUDIO_MIXER.ALLOW_MAIN(),
            LL.AUDIO_MIXER.ALLOW_MAIN_DESC(),
            audioMixer.allowMain,
            (value) => patch({ allowMain: value }),
            !hasMain,
          )}
          {permission(
            LL.AUDIO_MIXER.ALLOW_MAIN_MUTE(),
            LL.AUDIO_MIXER.ALLOW_MAIN_MUTE_DESC(),
            audioMixer.allowMainMute,
            (value) => patch({ allowMainMute: value }),
            // Meaningless without the mix it mutes, and a switch that does nothing is
            // worse than one that is not there.
            !audioMixer.allowMain,
          )}
          {permission(LL.AUDIO_MIXER.ALLOW_MIX_MUTE(), LL.AUDIO_MIXER.ALLOW_MIX_MUTE_DESC(), audioMixer.allowMixMute, (value) =>
            patch({ allowMixMute: value }),
          )}
          {permission(LL.AUDIO_MIXER.ALLOW_STRIP_MUTES(), LL.AUDIO_MIXER.ALLOW_STRIP_MUTES_DESC(), audioMixer.allowStripMutes, (value) =>
            patch({ allowStripMutes: value }),
          )}
          {permission(LL.AUDIO_MIXER.ALLOW_MUTE_GROUPS(), LL.AUDIO_MIXER.ALLOW_MUTE_GROUPS_DESC(), audioMixer.allowMuteGroups, (value) =>
            patch({ allowMuteGroups: value }),
          )}
          {permission(LL.AUDIO_MIXER.ALLOW_METERS(), LL.AUDIO_MIXER.ALLOW_METERS_DESC(), audioMixer.allowMeters, (value) =>
            patch({ allowMeters: value }),
          )}
        </Stack>
      </Box>
    </Stack>
  );
};
