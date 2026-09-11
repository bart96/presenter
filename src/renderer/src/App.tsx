import { useEffect, useMemo, useState, useRef, type ErrorInfo } from 'react';
import { ThemeProvider, CssBaseline } from '@mui/material';
import { getTheme, resolveThemeMode } from './theme';
import { detectLocale } from '@/i18n/i18n-util';
import { navigatorDetector } from 'typesafe-i18n/detectors';
import { loadAllLocales } from '@/i18n/i18n-util.sync';
import TypesafeI18n from '@/i18n/i18n-react';
import SessionExpired from '@/components/SessionExpired';
import { BrowserRouter, Route, Routes, Navigate, useParams } from 'react-router-dom';
import { MainPage } from '@/pages/MainPage';
import { UnauthorizedPage } from '@/pages/UnauthorizedPage';
import ConnectivityChecker from '@/components/settings/ConnectivityChecker';
import { SETTINGS_KEY, useGetSettings } from '@/store/settingsSlice';
import { useMetricSync } from '@/hooks/useMetricSync';
import { ErrorBoundary } from '@/components/common/ErrorBoundary';
import { GlobalErrorHandler } from '@/components/common/GlobalErrorHandler';
import { useMetrics } from '@/hooks/useMetrics';
import { useGetSessionQuery } from '@/api/session.api';
import { AUTO_LOGIN_STARTED_KEY, redirectToLogin } from '@/utils';

// Load all locales upfront so switching is instant
loadAllLocales();

/** Redirect /a/:licenseNumber → /login?license=... so the account is pre-selected */
const AccountLoginRedirect = () => {
  const { licenseNumber } = useParams<{ licenseNumber: string }>();
  return <Navigate to={`/login?license=${encodeURIComponent(licenseNumber ?? '')}`} replace />;
};

/**
 * Hard-navigation redirect to a separate HTML entry point.
 * Passes the current path/search through as a query param so the target app
 * can optionally restore state (e.g. deep-linking into a tab).
 */
const HardRedirect = ({ to }: { to: string }) => {
  useEffect(() => {
    window.location.replace(to);
  }, [to]);
  return null;
};

const App = () => {
  useMetricSync();

  const { themeMode, uiLanguage, offlineMode } = useGetSettings();
  const { trackEvent } = useMetrics();
  const [boundaryError, setBoundaryError] = useState<Error | null>(null);
  const freshStartTracked = useRef(false);

  // Track fresh start — fired when no settings exist yet in localStorage
  useEffect(() => {
    if (freshStartTracked.current) return;
    freshStartTracked.current = true;
    const hasSettings = !!localStorage.getItem(SETTINGS_KEY);
    if (!hasSettings) {
      trackEvent('fresh_start', undefined, undefined, {
        language: navigator.language,
      });
    }
  }, [trackEvent]);

  // Check authentication — skip in offline mode
  const { data: session, isLoading: sessionLoading } = useGetSessionQuery(undefined, { skip: offlineMode });

  // Redirect to dedicated login page when unauthenticated (online mode only)
  useEffect(() => {
    if (offlineMode || sessionLoading) return;
    if (session && !session.isAuthenticated) {
      redirectToLogin();
    } else if (session?.isAuthenticated) {
      // Signed in, so the login page may sign in automatically again next time (see LoginPage).
      try {
        sessionStorage.removeItem(AUTO_LOGIN_STARTED_KEY);
      } catch {
        // Storage unavailable — nothing was stored to clear.
      }
    }
  }, [offlineMode, session, sessionLoading]);

  // Resolve system theme and listen for OS preference changes
  const [resolvedMode, setResolvedMode] = useState(resolveThemeMode(themeMode));

  useEffect(() => {
    setResolvedMode(resolveThemeMode(themeMode));

    if (themeMode === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => setResolvedMode(mq.matches ? 'dark' : 'light');
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
    return undefined;
  }, [themeMode]);

  const muiTheme = useMemo(() => getTheme(resolvedMode), [resolvedMode]);

  // Determine locale: prefer user setting, then browser detection
  const detectedLocale = detectLocale(navigatorDetector);
  const locale = (uiLanguage === 'de' ? 'de' : uiLanguage === 'en' ? 'en' : detectedLocale === 'de' ? 'de' : 'en') as 'en' | 'de';

  return (
    <ThemeProvider theme={muiTheme}>
      <CssBaseline />
      <TypesafeI18n key={locale} locale={locale}>
        <ErrorBoundary onError={(err: Error, _info: ErrorInfo) => setBoundaryError(err)}>
          <GlobalErrorHandler boundaryError={boundaryError} />
          <ConnectivityChecker>
            {!offlineMode && <SessionExpired />}

            <BrowserRouter>
              <Routes>
                <Route path="/login" element={<HardRedirect to="/login" />} />
                <Route path="/a/:licenseNumber" element={<AccountLoginRedirect />} />
                <Route path="/unauthorized" element={<UnauthorizedPage />} />
                <Route path="/admin" element={<HardRedirect to="/admin" />} />
                <Route path="/admin/*" element={<HardRedirect to="/admin" />} />
                <Route path="/notes" element={<HardRedirect to="/notes" />} />
                <Route path="/*" element={<MainPage />} />
              </Routes>
            </BrowserRouter>
          </ConnectivityChecker>
        </ErrorBoundary>
      </TypesafeI18n>
    </ThemeProvider>
  );
};

export default App;
