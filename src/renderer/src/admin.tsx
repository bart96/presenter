import './assets/main.css';

import { useEffect, useMemo, StrictMode } from 'react';
import { mountRoot } from './mountRoot';
import { ThemeProvider, CssBaseline } from '@mui/material';
import { Provider } from 'react-redux';
import { store } from '@/store';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { getTheme, resolveThemeMode } from './theme';
import { loadAllLocales } from '@/i18n/i18n-util.sync';
import TypesafeI18n from '@/i18n/i18n-react';
import { AdminPage } from '@/pages/AdminPage';
import { useGetSettings } from '@/store/settingsSlice';
import { redirectToLogin } from '@/utils';
import { useGetSessionQuery } from '@/api/session.api';

loadAllLocales();

const AdminApp = () => {
  const { themeMode, uiLanguage, offlineMode } = useGetSettings();
  const resolvedMode = resolveThemeMode(themeMode);
  const muiTheme = useMemo(() => getTheme(resolvedMode), [resolvedMode]);

  const { data: session, isLoading: sessionLoading } = useGetSessionQuery(undefined, { skip: offlineMode });

  // Redirect to dedicated login page when unauthenticated (online mode only)
  useEffect(() => {
    if (offlineMode || sessionLoading) return;
    if (session && !session.isAuthenticated) {
      redirectToLogin('admin');
    }
  }, [offlineMode, session, sessionLoading]);

  return (
    <ThemeProvider theme={muiTheme}>
      <CssBaseline />
      <TypesafeI18n locale={uiLanguage}>
        <BrowserRouter>
          <Routes>
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/admin/:tab" element={<AdminPage />} />
            <Route path="*" element={<AdminPage />} />
          </Routes>
        </BrowserRouter>
      </TypesafeI18n>
    </ThemeProvider>
  );
};

mountRoot(
  <StrictMode>
    <Provider store={store}>
      <CssBaseline />
      <AdminApp />
    </Provider>
  </StrictMode>,
);
