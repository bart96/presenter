import { useEffect, useState, useCallback, useContext, createContext, SyntheticEvent, type ReactNode } from 'react';
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Snackbar,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { Close as CloseIcon, Settings as SettingsIcon, WifiOff as WifiOffIcon, Wifi as WifiIcon } from '@mui/icons-material';
import { useI18nContext } from '@/i18n/i18n-react';
import { useGetSessionQuery, useLazyGetSessionQuery } from '@/api/session.api';
import { presenterApi, getBackendBaseUrl } from '@/api/base.api';
import { useAppDispatch } from '@/store';
import { useUpdateSetting, useGetSettings } from '@/store/settingsSlice';
import { isElectronApp } from '@/utils';

/** Only the desktop app has a backend address of its own to configure. */
const isDesktop = isElectronApp();

/** Context that lets any descendant open the backend-config dialog. */
export const BackendConfigContext = createContext<{ openDialog: () => void }>({ openDialog: () => {} });

/** Hook to open the backend-config dialog from anywhere inside ConnectivityChecker's tree. */
export const useBackendConfig = () => useContext(BackendConfigContext);

/**
 * Monitors backend connectivity via the existing Session endpoint.
 *
 * - Shows a dismissable warning snackbar when the backend cannot be reached.
 * - Offers a settings dialog to change and test the backend URL.
 * - Uses the app's own RTK Query endpoints for testing — no manual fetch.
 * - Because `base.api.ts` resolves the URL dynamically per-request we can
 *   swap the localStorage value and re-dispatch without reloading.
 *
 * Children must be rendered inside this component so that `useBackendConfig`
 * (BackendConfigContext) can open the dialog from anywhere in the app tree.
 */
export const ConnectivityChecker = ({ children }: { children?: ReactNode }) => {
  const { LL } = useI18nContext();
  const dispatch = useAppDispatch();

  const { backendUrl, offlineMode } = useGetSettings();
  const updateSetting = useUpdateSetting();

  // Use the existing Session endpoint to detect connectivity issues
  const { isLoading, isError, refetch } = useGetSessionQuery(undefined, { skip: offlineMode });
  const [testSession] = useLazyGetSessionQuery();

  const [snackOpen, setSnackOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [urlInput, setUrlInput] = useState(backendUrl || '');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Keep the input in sync when the store value changes
  useEffect(() => setUrlInput(backendUrl || ''), [backendUrl]);

  // Show the snackbar when connectivity fails (not in offline mode)
  useEffect(() => {
    if (!offlineMode && !isLoading && isError) setSnackOpen(true);
  }, [isLoading, isError, offlineMode]);

  // ── Test the backend URL using the existing getSession endpoint ──
  const testBackendUrl = useCallback(
    async (url: string) => {
      const normalized = url.trim().replace(/\/+$/, '');
      if (!normalized) return;

      setTesting(true);
      setTestResult(null);

      // Remember previous URL so we can revert on failure
      const previousUrl = backendUrl || getBackendBaseUrl();

      try {
        updateSetting('backendUrl', normalized);

        // Reset the API cache so the next query hits the new URL
        dispatch(presenterApi.util.resetApiState());

        // Dispatch the existing getSession endpoint
        const result = await testSession(undefined, true).unwrap();

        if (result) {
          setTestResult({ ok: true, message: LL.CONNECTIVITY.TEST_SUCCESS() });
        } else {
          throw new Error('Empty response');
        }
      } catch (err: any) {
        // Revert to the previous URL (manual localStorage bypass)
        updateSetting('backendUrl', previousUrl);

        dispatch(presenterApi.util.resetApiState());

        const status = err?.status ?? '';
        const readable = (v: unknown): string => {
          if (v == null) return '';
          if (typeof v === 'string') return v;
          if (typeof v === 'object') {
            const obj = v as Record<string, unknown>;
            if (typeof obj.message === 'string') return obj.message;
            if (typeof obj.error === 'string') return obj.error;
            return JSON.stringify(v);
          }
          return String(v);
        };
        // RTK Query error shapes:
        //   HTTP error    → { status: number, data: any }
        //   FETCH_ERROR   → { status: 'FETCH_ERROR', error: string }
        //   PARSING_ERROR → { status: 'PARSING_ERROR', error: string, data: string }
        const message = (readable(err?.error) || readable(err?.data) || readable(err?.message) || String(err)).slice(0, 200);
        setTestResult({ ok: false, message: `${status ? status + ' — ' : ''}${message}` });
      } finally {
        setTesting(false);
      }
    },
    [dispatch, LL],
  );

  // ── Apply the successfully-tested URL ──
  const applyUrl = useCallback(() => {
    const normalized = urlInput.trim().replace(/\/+$/, '');
    updateSetting('backendUrl', normalized);
    setDialogOpen(false);
    setSnackOpen(false);
    setTestResult(null);
    // Refetch the session with the new URL already active
    refetch();
  }, [urlInput, dispatch, refetch]);

  // ── Snackbar close handler — ignore clickaway ──
  const handleSnackClose = (_event?: SyntheticEvent | Event, reason?: string) => {
    if (reason === 'clickaway') return;
    setSnackOpen(false);
  };

  return (
    <BackendConfigContext.Provider value={{ openDialog: () => setDialogOpen(true) }}>
      {/* ── Warning snackbar ── */}
      <Snackbar
        open={snackOpen}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
        onClose={handleSnackClose}
        autoHideDuration={null}
      >
        <Alert
          severity="warning"
          variant="filled"
          sx={{ width: '100%', alignItems: 'center' }}
          action={
            <Stack
              direction="row"
              spacing={0.5}
              sx={{
                alignItems: 'center',
              }}
            >
              <Tooltip title={LL.CONNECTIVITY.SNACK_CHANGE_BUTTON()}>
                <IconButton size="small" color="inherit" onClick={() => setDialogOpen(true)}>
                  <SettingsIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title={LL.CONNECTIVITY.SNACK_DISMISS()}>
                <IconButton size="small" color="inherit" onClick={() => setSnackOpen(false)}>
                  <CloseIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          }
        >
          {LL.CONNECTIVITY.SNACK_MESSAGE()}
        </Alert>
      </Snackbar>
      {/* ── Backend URL dialog ── */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{LL.CONNECTIVITY.TITLE()}</DialogTitle>

        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Typography
              variant="body2"
              sx={{
                color: 'text.secondary',
              }}
            >
              {isDesktop ? LL.CONNECTIVITY.MESSAGE() : LL.CONNECTIVITY.MESSAGE_WEB()}
            </Typography>

            {/* Only the desktop app has a backend address to change — the browser build always
                talks to the server it was loaded from (see getBackendBaseUrl). */}
            {isDesktop && (
              <>
                <TextField
                  label={LL.SETTINGS.OPTIONS.BACKEND_URL.TITLE()}
                  value={urlInput}
                  onChange={(e) => {
                    setUrlInput(e.target.value);
                    setTestResult(null);
                  }}
                  fullWidth
                  autoFocus
                  placeholder="https://example.com"
                  helperText={LL.SETTINGS.OPTIONS.BACKEND_URL.DESCRIPTION()}
                />

                {testResult && (
                  <Alert severity={testResult.ok ? 'success' : 'error'} variant="outlined">
                    {testResult.message}
                  </Alert>
                )}

                <Divider />
              </>
            )}

            <Stack
              direction="row"
              sx={{
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <Typography variant="body2">{offlineMode ? LL.HEADER.OFFLINE_MODE_OFF() : LL.HEADER.OFFLINE_MODE_ON()}</Typography>
              <Button
                variant={offlineMode ? 'contained' : 'outlined'}
                color={offlineMode ? 'warning' : 'inherit'}
                size="small"
                startIcon={offlineMode ? <WifiOffIcon /> : <WifiIcon />}
                onClick={() => updateSetting('offlineMode', !offlineMode)}
              >
                {offlineMode ? LL.HEADER.OFFLINE_MODE_OFF() : LL.HEADER.OFFLINE_MODE_ON()}
              </Button>
            </Stack>
          </Stack>
        </DialogContent>

        <DialogActions>
          <Button onClick={() => setDialogOpen(false)} color="inherit">
            {LL.COMMON.CANCEL()}
          </Button>
          {isDesktop && (
            <>
              <Button
                onClick={() => testBackendUrl(urlInput)}
                disabled={testing || !urlInput.trim()}
                startIcon={testing ? <CircularProgress size={16} /> : undefined}
              >
                {LL.CONNECTIVITY.TEST()}
              </Button>
              <Button onClick={applyUrl} variant="contained" disabled={!testResult?.ok}>
                {LL.CONNECTIVITY.APPLY_AND_RELOAD()}
              </Button>
            </>
          )}
        </DialogActions>
      </Dialog>
      {children}
    </BackendConfigContext.Provider>
  );
};

export default ConnectivityChecker;
