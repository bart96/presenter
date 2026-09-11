import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, Card, CardContent, Divider, MenuItem, Stack, TextField, Tooltip, Typography } from '@mui/material';
import { Security as SecurityIcon, WifiOff as WifiOffIcon, Wifi as WifiIcon, Settings as SettingsIcon } from '@mui/icons-material';
import { useLocation } from 'react-router-dom';
import { useI18nContext } from '@/i18n/i18n-react';
import { useGetAccountsQuery, useGetAdminOidcAuthUrlQuery, useGetOidcAuthUrlQuery } from '@/api/session.api';
import { useUpdateSetting, useGetSettings, Account } from '@/store/settingsSlice';
import {
  AUTO_LOGIN_RETRY_MS,
  AUTO_LOGIN_STARTED_KEY,
  getOidcRedirectUrl,
  nextParamToPath,
  isElectronApp,
  electronFileUrl,
  getBackendOrigin,
  isPostLogoutReturn,
} from '@/utils';
import { oidcErrorTitle } from '@/utils/oidcErrors';
import { useBackendConfig } from '@/components/settings/ConnectivityChecker';

const useQueryParam = (name: string): string | null => {
  const { search } = useLocation();
  return useMemo(() => new URLSearchParams(search).get(name), [search, name]);
};

/** True when this page was reached by the provider's post-logout redirect. */
const useCameFromLogout = (): boolean => {
  const { search } = useLocation();
  return useMemo(() => isPostLogoutReturn(new URLSearchParams(search)), [search]);
};

export const LoginPage = () => {
  const { LL } = useI18nContext();
  const { openDialog: openBackendDialog } = useBackendConfig();

  const next = useQueryParam('next') ?? '/';

  const { offlineMode, lastSelectedAccount } = useGetSettings();
  const updateSetting = useUpdateSetting();

  // Notify the main process of the backend origin so it can identify OIDC callbacks
  useEffect(() => {
    if (isElectronApp()) {
      const origin = getBackendOrigin();
      if (origin) {
        (window as { api?: { setBackendOrigin?: (o: string) => void } }).api?.setBackendOrigin?.(origin);
      }
    }
  }, []);

  const licenseParam = useQueryParam('license');
  /**
   * Set by the logout round-trip. The user came here to pick a DIFFERENT account, so
   * restoring the previous one, the Electron auto-proceed and the offline redirect below must
   * all stay out of the way — otherwise the page bounces straight back to the provider (or
   * into the app) and the account select can never be reached.
   *
   * `switch=1` is set by the Electron main process when it catches the return trip; in the
   * browser the marker is the provider's echoed `state=logged_out` instead, because the
   * post-logout redirect URI has to stay free of query parameters to remain registrable.
   */
  const cameFromLogout = useCameFromLogout();
  const switchAccount = useQueryParam('switch') === '1' || cameFromLogout;
  /**
   * An `oidc.*` code the desktop main process brings back when the backend rejected a sign-in that
   * finished in its hidden window. Shown below, and it keeps the automatic sign-in from retrying.
   */
  const loginError = useQueryParam('error');
  /** Set when the automatic sign-in was skipped because the previous one did not end in a session. */
  const [autoLoginStopped, setAutoLoginStopped] = useState(false);

  // In offline mode, redirect immediately to the intended destination — but not at the end of
  // a logout. Forwarding there into an app that fetches nothing is how a device ended up
  // looking signed in while seeing no data, with the offline toggle out of reach.
  useEffect(() => {
    if (offlineMode && !switchAccount) {
      try {
        const dest = decodeURIComponent(next);
        // In Electron, `next` is a bare filename (e.g. "musician.html") and relative navigation is unreliable — build the full file:// URL.
        window.location.replace(isElectronApp() ? electronFileUrl(dest) : dest);
      } catch {
        window.location.replace(isElectronApp() ? electronFileUrl('index.html') : '/');
      }
    }
  }, [offlineMode, next, switchAccount]);

  // License selection - load from localStorage on mount
  const { data: accounts, isLoading: accountsLoading, error: accountsError } = useGetAccountsQuery();
  // Start with '' so the MUI Select never gets an out-of-range value during first render.
  // The saved account is restored once the accounts list has loaded and the value is validated.
  const [selectedLicense, setSelectedLicense] = useState<Account>('');

  // Track whether the current selection was auto-restored from settings (vs. manually chosen).
  // Only when auto-restored do we trigger the automatic OIDC redirect in Electron.
  const autoRestoredRef = useRef(false);

  // Restore saved account after accounts have loaded and validated
  useEffect(() => {
    if (accountsLoading || !accounts) {
      return;
    }

    // URL-supplied license number takes priority over localStorage
    if (licenseParam !== null) {
      if (licenseParam === 'admin') {
        setSelectedLicense('admin');
        return;
      }
      const n = Number(licenseParam);
      if (!isNaN(n) && accounts.some((a) => a.license === n)) {
        setSelectedLicense(n);
        return;
      }
    }

    try {
      if (switchAccount || !lastSelectedAccount) {
        return;
      }
      if (lastSelectedAccount === 'admin') {
        setSelectedLicense('admin');
        autoRestoredRef.current = true;
      } else if (typeof lastSelectedAccount === 'number' && accounts.some((a) => a.license === lastSelectedAccount)) {
        setSelectedLicense(lastSelectedAccount);
        autoRestoredRef.current = true;
      } else {
        updateSetting('lastSelectedAccount', '');
      }
    } catch {
      console.log('Failed to restore last selected account from settings, ignoring');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountsLoading, licenseParam]);

  const redirectUrl = getOidcRedirectUrl(nextParamToPath(next));
  const adminRedirectUrl = getOidcRedirectUrl('/admin');

  // Calculate tenant license number before using it in queries
  const isAdminSelected = selectedLicense === 'admin';
  const isTenantSelected = typeof selectedLicense === 'number';
  const tenantLicenseNumber = isTenantSelected ? selectedLicense : null;

  const {
    data: oidcUrlData,
    isFetching: oidcLoading,
    error: oidcError,
  } = useGetOidcAuthUrlQuery(
    {
      redirect: redirectUrl,
      license: tenantLicenseNumber ?? undefined,
    },
    {
      skip: !isTenantSelected, // Only fetch when tenant is selected
    },
  );

  const {
    data: adminOidcUrlData,
    isFetching: adminOidcLoading,
    error: adminOidcError,
  } = useGetAdminOidcAuthUrlQuery(
    { redirect: adminRedirectUrl },
    {
      skip: !isAdminSelected, // Only fetch when admin is selected
    },
  );

  const [errorText, setErrorText] = useState<string | null>(null);

  // ── Auto-proceed in Electron when last account was auto-restored ──
  // Once the OIDC URL is ready and the account was restored from saved settings,
  // automatically redirect without requiring the user to click the Login button.
  useEffect(() => {
    // A login error means the last attempt was just rejected — signing in again would repeat it.
    if (!isElectronApp() || switchAccount || loginError || !autoRestoredRef.current) return;
    const url =
      isAdminSelected && !adminOidcLoading ? adminOidcUrlData?.url : isTenantSelected && !oidcLoading ? oidcUrlData?.url : undefined;
    if (!url) return;
    autoRestoredRef.current = false;

    // Never twice in a row. Being back here within a minute of the last automatic sign-in means it
    // did not end in a session (App clears the marker once one exists), and trying again would only
    // repeat it — the login page flashing in an endless loop.
    try {
      const last = Number(sessionStorage.getItem(AUTO_LOGIN_STARTED_KEY) || 0);
      if (Date.now() - last < AUTO_LOGIN_RETRY_MS) {
        setAutoLoginStopped(true);
        return;
      }
      sessionStorage.setItem(AUTO_LOGIN_STARTED_KEY, String(Date.now()));
    } catch {
      // Without storage a loop cannot be told apart from a first attempt, so do not risk one.
      return;
    }
    openUrl(url);
  }, [isAdminSelected, isTenantSelected, adminOidcLoading, oidcLoading, adminOidcUrlData, oidcUrlData, loginError]);

  const onSelectLicense = (value: Account) => {
    // User manually selected — disable auto-proceed
    autoRestoredRef.current = false;
    setSelectedLicense(value);
    setErrorText(null);

    // Save to localStorage
    try {
      updateSetting('lastSelectedAccount', value);
    } catch (e) {
      console.error('Failed to save last selected account to settings:', e);
    }
  };

  // Simple navigation helper — the dev proxy rewrites /rest and /oidc to the PHP server.
  const openUrl = (url: string | undefined) => {
    if (!url) return;
    window.location.assign(url);
  };

  return (
    // Flex, not grid: under `place-items: center` the auto column track sizes itself to the
    // card's max-content, so the card's own `maxWidth: '100%'` resolved against 480px and
    // never did anything — on a 375px phone the card hung 121px off the right edge, taking
    // the account dropdown (anchored to its width) with it.
    <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 2 }}>
      <Card sx={{ width: 480, maxWidth: '100%' }}>
        <CardContent>
          <Stack
            sx={{
              gap: 2,
            }}
          >
            <Typography variant="h5">{LL.AUTH.LOGIN()}</Typography>

            {loginError && (
              <Alert severity="error">
                <Typography variant="subtitle2">{oidcErrorTitle(LL, loginError)}</Typography>
                <Typography variant="body2">
                  {LL.AUTH.LOGIN_REJECTED()} ({loginError})
                </Typography>
              </Alert>
            )}
            {autoLoginStopped && !loginError && <Alert severity="info">{LL.AUTH.AUTO_LOGIN_STOPPED()}</Alert>}
            {errorText && <Alert severity="error">{errorText}</Alert>}

            {accountsError && !offlineMode && (
              <Alert
                severity="error"
                action={
                  <Button color="inherit" size="small" startIcon={<SettingsIcon fontSize="small" />} onClick={openBackendDialog}>
                    {LL.CONNECTIVITY.SNACK_CHANGE_BUTTON()}
                  </Button>
                }
              >
                {LL.ERRORS.LOAD_LICENSES()}
              </Alert>
            )}

            {!offlineMode && (
              <>
                <TextField
                  select
                  label={LL.AUTH.ACCOUNT()}
                  value={selectedLicense}
                  disabled={accountsLoading}
                  onChange={(e) => {
                    const v = e.target.value;
                    // '' is the placeholder row, not an account — never commit it.
                    if (v === '') return;
                    onSelectLicense(v === 'admin' ? v : Number(v));
                  }}
                  helperText={LL.AUTH.SELECT_HELP()}
                >
                  {/* Placeholder only — selecting it would store an empty account and leave
                      the page in a state with no account and no way to start a login. */}
                  <MenuItem value="" disabled>
                    {LL.AUTH.SELECT_PROMPT()}
                  </MenuItem>
                  <MenuItem value="admin">{LL.AUTH.ADMIN_LABEL()}</MenuItem>
                  {(accounts ?? []).map((a) => (
                    <MenuItem key={a.license} value={a.license}>
                      {a.name ? a.name : `#${a.license}`}
                    </MenuItem>
                  ))}
                </TextField>

                {selectedLicense === '' && (
                  <Typography
                    variant="body2"
                    sx={{
                      color: 'text.secondary',
                    }}
                  >
                    {LL.AUTH.SELECT_PROMPT()}
                  </Typography>
                )}

                {selectedLicense !== '' && (
                  <Stack
                    sx={{
                      gap: 1,
                    }}
                  >
                    <Button
                      fullWidth
                      variant="contained"
                      startIcon={<SecurityIcon />}
                      disabled={isAdminSelected ? adminOidcLoading : oidcLoading}
                      onClick={() => {
                        setErrorText(null);
                        const url = isAdminSelected ? adminOidcUrlData?.url : oidcUrlData?.url;
                        if (!url) {
                          setErrorText(isAdminSelected ? LL.ERRORS.ADMIN_CONFIG_MISSING() : LL.ERRORS.NO_PROVIDER_FOR_ACCOUNT());
                          return;
                        }
                        openUrl(url);
                      }}
                    >
                      {LL.AUTH.LOGIN()}
                    </Button>

                    {isAdminSelected && adminOidcError && (
                      <Alert severity="error">
                        <Typography variant="subtitle2" gutterBottom>
                          {LL.ERRORS.ADMIN_OIDC_CONFIG()}
                        </Typography>
                        <Typography variant="body2">{LL.ERRORS.LOGIN_UNAVAILABLE()}</Typography>
                      </Alert>
                    )}
                    {isTenantSelected && oidcError && (
                      <Alert severity="error">
                        <Typography variant="subtitle2" gutterBottom>
                          {LL.ERRORS.PROVIDER_CONFIG()}
                        </Typography>
                        <Typography variant="body2">{LL.ERRORS.CONTACT_ADMIN_ASSIGN_PROVIDER()}</Typography>
                      </Alert>
                    )}
                  </Stack>
                )}
              </>
            )}

            <Divider />

            {/* Offline mode toggle */}
            <Stack
              sx={{
                gap: 1,
              }}
            >
              {offlineMode && (
                <Alert severity="info" icon={<WifiOffIcon fontSize="small" />}>
                  {LL.HEADER.OFFLINE_MODE_ON()}
                </Alert>
              )}
              <Tooltip title={offlineMode ? LL.HEADER.OFFLINE_MODE_OFF() : LL.HEADER.OFFLINE_MODE_ON()}>
                <Button
                  size="small"
                  variant={offlineMode ? 'contained' : 'outlined'}
                  color={offlineMode ? 'warning' : 'inherit'}
                  startIcon={offlineMode ? <WifiOffIcon /> : <WifiIcon />}
                  onClick={() => updateSetting('offlineMode', !offlineMode)}
                  fullWidth
                >
                  {offlineMode ? LL.HEADER.OFFLINE_MODE_LABEL_OFF() : LL.HEADER.OFFLINE_MODE_LABEL_ON()}
                </Button>
              </Tooltip>
            </Stack>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
};
