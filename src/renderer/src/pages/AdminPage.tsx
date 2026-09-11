import { type SyntheticEvent } from 'react';
import { Box, Button, Card, CardContent, Chip, CircularProgress, GlobalStyles, Stack, Tab, Tabs, Typography, Alert } from '@mui/material';
import { Logout as LogoutIcon, Lock as LockIcon, ArrowBack as ArrowBackIcon } from '@mui/icons-material';
import { useNavigate, useParams } from 'react-router-dom';
import { useI18nContext } from '@/i18n/i18n-react';
import { useGetAdminMigrationsQuery } from '@/api/admin.api';
import { useGetSessionQuery } from '@/api/session.api';
import { useLogout } from '@/hooks/useLogout';
import { Accounts } from '@/admin/Accounts';
import { Providers } from '@/admin/Providers';
import { Songs } from '@/admin/Songs';
import { Metrics } from '@/admin/Metrics';
import { Logs } from '@/admin/Logs';
import { Database } from '@/admin/Database';
import { Config } from '@/admin/Config';
import { WsMonitor } from '@/admin/WsMonitor';

const TAB_SLUGS = ['accounts', 'providers', 'songs', 'metrics', 'logs', 'websocket', 'database', 'config'] as const;
type TabSlug = (typeof TAB_SLUGS)[number];

export const AdminPage = () => {
  const { LL } = useI18nContext();
  const navigate = useNavigate();
  const { tab: tabParam } = useParams<{ tab?: string }>();
  const activeTab = Math.max(0, TAB_SLUGS.indexOf((tabParam ?? 'accounts') as TabSlug));

  const { data: session, isLoading: sessionLoading } = useGetSessionQuery();
  const isAdmin = session?.authType === 'oidc_admin';

  const { data: migrationStatus } = useGetAdminMigrationsQuery(undefined, { skip: !isAdmin });
  const logout = useLogout();

  const handleTabChange = (_: SyntheticEvent, newValue: number) => {
    navigate(`/admin/${TAB_SLUGS[newValue]}`, { replace: true });
  };

  const handleLogout = () => logout();

  return (
    <Box sx={{ minHeight: '100vh', p: 3, bgcolor: 'background.default' }}>
      <GlobalStyles styles={{ 'html, body': { overflow: 'auto !important', height: 'auto !important' } }} />
      {sessionLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
          <CircularProgress size={48} />
        </Box>
      ) : !session || !isAdmin ? (
        <Card sx={{ maxWidth: 480, mx: 'auto', mt: 8 }}>
          <CardContent>
            <Stack spacing={2} sx={{ alignItems: 'center', textAlign: 'center' }}>
              <LockIcon color="error" sx={{ fontSize: 56 }} />
              <Typography variant="h5">{LL.ADMIN.ACCESS_DENIED()}</Typography>
              <Alert severity="error">{LL.ADMIN.ACCESS_DENIED_MESSAGE()}</Alert>
              <Stack direction="row" spacing={1}>
                <Button variant="outlined" startIcon={<ArrowBackIcon />} onClick={() => navigate(-1)}>
                  {LL.COMMON.BACK()}
                </Button>
                <Button variant="outlined" color="error" startIcon={<LogoutIcon />} onClick={handleLogout}>
                  {LL.AUTH.LOGOUT()}
                </Button>
              </Stack>
            </Stack>
          </CardContent>
        </Card>
      ) : (
        <Card sx={{ mb: 3 }}>
          <CardContent sx={{ overflow: 'visible' }}>
            <Stack sx={{ gap: 3 }}>
              {/* Header */}
              <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography variant="h4">{LL.ADMIN.PANEL()}</Typography>
                <Button variant="outlined" color="error" startIcon={<LogoutIcon />} onClick={handleLogout}>
                  {LL.AUTH.LOGOUT()}
                </Button>
              </Stack>

              {/* Sticky tab bar */}
              <Box
                sx={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 10,
                  bgcolor: 'background.paper',
                  mx: -3,
                  px: 3,
                  borderBottom: 1,
                  borderColor: 'divider',
                }}
              >
                <Tabs value={activeTab} onChange={handleTabChange} variant="scrollable" scrollButtons="auto">
                  <Tab label={LL.ADMIN.ACCOUNTS()} />
                  <Tab label={LL.ADMIN.OIDC_PROVIDERS()} />
                  <Tab label={LL.ADMIN_SONGS.NAV_TITLE()} />
                  <Tab label={LL.METRICS.METRICS()} />
                  <Tab label={LL.ADMIN_LOGS.NAV_TITLE()} />
                  <Tab label={LL.ADMIN_WS.NAV_TITLE()} />
                  <Tab
                    label={LL.ADMIN.DATABASE()}
                    icon={
                      migrationStatus && migrationStatus.pendingCount > 0 ? (
                        <Chip label={migrationStatus.pendingCount} color="warning" size="small" />
                      ) : undefined
                    }
                    iconPosition="end"
                  />
                  <Tab label={LL.ADMIN.CONFIG()} />
                </Tabs>
              </Box>

              {/* Tab content */}
              {activeTab === 0 && <Accounts />}
              {activeTab === 1 && <Providers />}
              {activeTab === 2 && <Songs />}
              {activeTab === 3 && <Metrics />}
              {activeTab === 4 && <Logs />}
              {activeTab === 5 && <WsMonitor />}
              {activeTab === 6 && <Database />}
              {activeTab === 7 && <Config />}
            </Stack>
          </CardContent>
        </Card>
      )}
    </Box>
  );
};
