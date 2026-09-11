import './assets/main.css';
import 'react-pdf/dist/Page/TextLayer.css';
import 'react-pdf/dist/Page/AnnotationLayer.css';

import { StrictMode, useMemo, useEffect, useState, type ErrorInfo } from 'react';
import { mountRoot } from './mountRoot';
import { ThemeProvider, CssBaseline, Box, CircularProgress } from '@mui/material';
import { Provider } from 'react-redux';
import { store } from '@/store';
import { getTheme } from './theme';
import { MusicianPage } from '@/musician/MusicianPage';
import { loadAllLocales } from '@/i18n/i18n-util.sync';
import TypesafeI18n from '@/i18n/i18n-react';
import { useGetMusicianSettings } from '@/store/musicianSlice';
import { useGetSettings } from '@/store/settingsSlice';
import { useGetSessionQuery } from '@/api/session.api';
import SessionExpired from '@/components/SessionExpired';
import { useMetricSync } from '@/hooks/useMetricSync';
import { redirectToLogin } from '@/utils';
import { ErrorBoundary } from '@/components/common/ErrorBoundary';
import { GlobalErrorHandler } from '@/components/common/GlobalErrorHandler';

loadAllLocales();

/** Wrapper that reads the musician-specific theme from Redux */
const MusicianApp = () => {
  const { uiLanguage, offlineMode } = useGetSettings();
  const { musicianTheme } = useGetMusicianSettings();
  const muiTheme = useMemo(() => getTheme(musicianTheme), [musicianTheme]);
  const [boundaryError, setBoundaryError] = useState<Error | null>(null);

  // Flush any queued offline metrics on mount
  useMetricSync();

  // Check authentication — skip in offline mode
  const { data: session, isLoading: sessionLoading } = useGetSessionQuery(undefined, { skip: offlineMode });

  useEffect(() => {
    if (offlineMode || sessionLoading) return;
    if (session && !session.isAuthenticated) {
      redirectToLogin('notes');
    }
  }, [offlineMode, session, sessionLoading]);

  // While the session check is in flight, show a centred spinner so the
  // MusicianPage doesn't fire its API calls unauthenticated.
  const isAuthPending = !offlineMode && (sessionLoading || (session && !session.isAuthenticated));

  return (
    <ThemeProvider theme={muiTheme}>
      <CssBaseline />
      <TypesafeI18n locale={uiLanguage}>
        <ErrorBoundary onError={(err: Error, _info: ErrorInfo) => setBoundaryError(err)}>
          <GlobalErrorHandler boundaryError={boundaryError} />
          {/* Session-expired snackbar — active whenever the token lapses */}
          {!offlineMode && <SessionExpired />}

          {isAuthPending ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
              <CircularProgress />
            </Box>
          ) : (
            <MusicianPage />
          )}
        </ErrorBoundary>
      </TypesafeI18n>
    </ThemeProvider>
  );
};

mountRoot(
  <StrictMode>
    <Provider store={store}>
      <MusicianApp />
    </Provider>
  </StrictMode>,
);
