import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Divider,
  FormControlLabel,
  IconButton,
  InputAdornment,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { Key as KeyIcon, Visibility, VisibilityOff } from '@mui/icons-material';
import { useI18nContext } from '@/i18n/i18n-react';
import { isElectronApp } from '@/utils';
import { useGetSettings, useUpdateSetting } from '@/store/settingsSlice';

export const CredentialsSection = () => {
  const { LL } = useI18nContext();

  const [savedUsername, setSavedUsername] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [encryptionAvailable, setEncryptionAvailable] = useState(true);

  const { autoLogin } = useGetSettings();
  const updateSetting = useUpdateSetting();

  const api = isElectronApp() ? window.api : undefined;

  useEffect(() => {
    if (!api) return;
    api.isEncryptionAvailable?.().then((v) => setEncryptionAvailable(v ?? true));
    api.getCredentialUsername?.().then((u) => {
      const name = u ?? null;
      setSavedUsername(name);
      // Pre-fill username field with the stored value so the user can see / edit it
      if (name) setUsername(name);
    });
  }, []);

  if (!isElectronApp() || !encryptionAvailable) return null;

  const hasExisting = Boolean(savedUsername);
  const canSave = Boolean(username.trim()) && Boolean(password);

  const handleSave = async () => {
    if (!canSave || !api) return;
    const ok = await api.storeCredentials?.(username.trim(), password);
    if (ok) {
      setSavedUsername(username.trim());
      setPassword('');
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 3000);
    }
  };

  const handleClear = async () => {
    if (!api) return;
    await api.deleteCredentials?.();
    setSavedUsername(null);
    setUsername('');
    setPassword('');
  };

  return (
    <Stack spacing={1.5}>
      <Divider />

      {/* Section header */}
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <KeyIcon fontSize="small" sx={{ color: 'text.secondary' }} />
        <Typography variant="body2" sx={{ fontWeight: 600, flex: 1 }}>
          {LL.AUTH.SAVED_CREDENTIALS()}
        </Typography>
        {hasExisting && (
          <Button size="small" color="error" onClick={handleClear}>
            {LL.AUTH.CREDENTIALS_CLEAR()}
          </Button>
        )}
      </Stack>

      <Typography variant="caption" color="text.secondary">
        {LL.AUTH.CREDENTIALS_DESCRIPTION()}
      </Typography>

      {/* Username */}
      <TextField
        size="small"
        fullWidth
        label={LL.AUTH.CREDENTIALS_USERNAME()}
        value={username}
        autoComplete="off"
        onChange={(e) => setUsername(e.target.value)}
      />

      {/* Password — always blank, enter to update */}
      <TextField
        size="small"
        fullWidth
        label={LL.AUTH.CREDENTIALS_PASSWORD()}
        type={showPassword ? 'text' : 'password'}
        value={password}
        autoComplete="new-password"
        placeholder={hasExisting ? '••••••••' : ''}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && canSave) handleSave();
        }}
        slotProps={{
          input: {
            endAdornment: (
              <InputAdornment position="end">
                <IconButton size="small" onClick={() => setShowPassword((v) => !v)} edge="end">
                  {showPassword ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
                </IconButton>
              </InputAdornment>
            ),
          },
        }}
      />

      <Button size="small" variant="contained" disabled={!canSave} onClick={handleSave}>
        {hasExisting ? LL.AUTH.CREDENTIALS_UPDATE() : LL.AUTH.CREDENTIALS_SAVE()}
      </Button>

      {savedOk && (
        <Alert severity="success" sx={{ py: 0 }}>
          {LL.AUTH.CREDENTIALS_SAVED_OK()}
        </Alert>
      )}

      {/* Auto-login — only useful when credentials are stored */}
      {hasExisting && (
        <Tooltip title={LL.AUTH.CREDENTIALS_AUTO_LOGIN_HINT()} placement="top-start">
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={autoLogin}
                onChange={(e) => {
                  updateSetting('autoLogin', e.target.checked);
                  // Mirror to the main process so the IdP auto-fill script can submit
                  // even if the setting is toggled without reloading the page.
                  api?.setAutoLogin?.(e.target.checked);
                }}
              />
            }
            label={<Typography variant="body2">{LL.AUTH.CREDENTIALS_AUTO_LOGIN()}</Typography>}
          />
        </Tooltip>
      )}

      <Typography variant="caption" color="text.secondary">
        {LL.AUTH.CREDENTIALS_HINT()}
      </Typography>
    </Stack>
  );
};
