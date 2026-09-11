import { useEffect, useMemo } from 'react';
import { Alert, Box, Button, Card, CardContent, List, ListItem, ListItemText, Stack, Typography } from '@mui/material';
import { Error as ErrorIcon, ArrowBack as BackIcon } from '@mui/icons-material';
import { useLocation, useNavigate } from 'react-router-dom';
import { useI18nContext } from '@/i18n/i18n-react';
import { oidcErrorTitle } from '@/utils/oidcErrors';

const useQueryParam = (name: string): string | null => {
  const { search } = useLocation();
  return useMemo(() => new URLSearchParams(search).get(name), [search, name]);
};

export const UnauthorizedPage = () => {
  const { LL } = useI18nContext();
  const navigate = useNavigate();

  const error = useQueryParam('error');
  const requiredGroup = useQueryParam('required_group');
  const userGroups = useQueryParam('user_groups');
  const sub = useQueryParam('sub');
  const details = useQueryParam('details');

  useEffect(() => {
    // Log error for debugging
    console.error('[UnauthorizedPage] Error:', error, {
      requiredGroup,
      userGroups,
      sub,
      details,
    });
  }, [error, requiredGroup, userGroups, sub, details]);

  const getErrorTitle = () => oidcErrorTitle(LL, error);

  const getErrorMessage = () => {
    switch (error) {
      case 'oidc.admin_access_denied':
        return (
          <>
            <Typography variant="body1" gutterBottom>
              {LL.ERRORS.ADMIN_ACCESS_DENIED_MESSAGE()}
            </Typography>
            {requiredGroup && (
              <Box sx={{ mt: 2 }}>
                <Typography
                  variant="subtitle2"
                  sx={{
                    color: 'text.secondary',
                  }}
                >
                  {LL.AUTH.REQUIRED_GROUP()}
                </Typography>
                <Typography variant="body2" sx={{ fontFamily: 'monospace', bgcolor: 'action.hover', p: 1, borderRadius: 1 }}>
                  {decodeURIComponent(requiredGroup)}
                </Typography>
              </Box>
            )}
            {userGroups && (
              <Box sx={{ mt: 2 }}>
                <Typography
                  variant="subtitle2"
                  sx={{
                    color: 'text.secondary',
                  }}
                >
                  {LL.AUTH.YOUR_GROUPS()}
                </Typography>
                <List dense sx={{ bgcolor: 'action.hover', borderRadius: 1, mt: 0.5 }}>
                  {decodeURIComponent(userGroups)
                    .split(',')
                    .map((g) => g.trim())
                    .filter((g) => g.length > 0)
                    .map((group, idx) => (
                      <ListItem key={idx}>
                        <ListItemText
                          primary={group}
                          slotProps={{
                            primary: { variant: 'body2', sx: { fontFamily: 'monospace' } },
                          }}
                        />
                      </ListItem>
                    ))}
                </List>
              </Box>
            )}
            <Alert severity="info" sx={{ mt: 2 }}>
              {LL.AUTH.CONTACT_ADMIN()}
            </Alert>
          </>
        );

      case 'oidc.admin_config_missing':
        return (
          <>
            <Typography variant="body1" gutterBottom>
              {LL.ERRORS.ADMIN_OIDC_CONFIG_MISSING_MESSAGE()}
            </Typography>
            <Alert severity="error" sx={{ mt: 2 }}>
              <Typography variant="subtitle2" gutterBottom>
                {LL.ERRORS.ADMIN_OIDC_CONFIG_REQUIRED_TITLE()}
              </Typography>
              <Typography variant="body2" component="pre" sx={{ fontFamily: 'monospace', mt: 1 }}>
                {`define('OIDC_DISCOVERY_URL', '...');
define('OIDC_CLIENT_ID', '...');
define('OIDC_CLIENT_SECRET', '...');
define('OIDC_REDIRECT_URI', '...');
define('OIDC_CLIENT_SCOPES', ['openid', 'email', 'profile']);`}
              </Typography>
            </Alert>
            <Typography
              variant="body2"
              sx={{
                color: 'text.secondary',
                mt: 2,
              }}
            >
              {LL.ERRORS.ADMIN_OIDC_CONFIG_CONTACT()}
            </Typography>
          </>
        );

      case 'oidc.access_denied':
        return (
          <>
            <Typography variant="body1" gutterBottom>
              {LL.ERRORS.ACCESS_DENIED_MESSAGE()}
            </Typography>
            {requiredGroup && (
              <Box sx={{ mt: 2 }}>
                <Typography
                  variant="subtitle2"
                  sx={{
                    color: 'text.secondary',
                  }}
                >
                  {LL.AUTH.REQUIRED_GROUP()}
                </Typography>
                <Typography variant="body2" sx={{ fontFamily: 'monospace', bgcolor: 'action.hover', p: 1, borderRadius: 1 }}>
                  {decodeURIComponent(requiredGroup)}
                </Typography>
              </Box>
            )}
            {userGroups && (
              <Box sx={{ mt: 2 }}>
                <Typography
                  variant="subtitle2"
                  sx={{
                    color: 'text.secondary',
                  }}
                >
                  {LL.AUTH.YOUR_GROUPS()}
                </Typography>
                <List dense sx={{ bgcolor: 'action.hover', borderRadius: 1, mt: 0.5 }}>
                  {decodeURIComponent(userGroups)
                    .split(',')
                    .map((g) => g.trim())
                    .filter((g) => g.length > 0)
                    .map((group, idx) => (
                      <ListItem key={idx}>
                        <ListItemText
                          primary={group}
                          slotProps={{
                            primary: { variant: 'body2', sx: { fontFamily: 'monospace' } },
                          }}
                        />
                      </ListItem>
                    ))}
                </List>
              </Box>
            )}
            <Alert severity="info" sx={{ mt: 2 }}>
              {LL.AUTH.CONTACT_ADMIN()}
            </Alert>
          </>
        );

      case 'oidc.no_account':
        return (
          <>
            <Typography variant="body1" gutterBottom>
              {LL.ERRORS.NO_ACCOUNT_MESSAGE()}
            </Typography>
            {sub && (
              <Box sx={{ mt: 2 }}>
                <Typography
                  variant="subtitle2"
                  sx={{
                    color: 'text.secondary',
                  }}
                >
                  {LL.AUTH.USER_ID()}
                </Typography>
                <Typography variant="body2" sx={{ fontFamily: 'monospace', bgcolor: 'action.hover', p: 1, borderRadius: 1 }}>
                  {decodeURIComponent(sub)}
                </Typography>
              </Box>
            )}
          </>
        );

      case 'oidc.no_license':
        return (
          <>
            <Typography variant="body1" gutterBottom>
              {LL.ERRORS.NO_LICENSE_MESSAGE()}
            </Typography>
            <Alert severity="warning" sx={{ mt: 2 }}>
              {LL.ERRORS.NO_LICENSE_ACTION()}
            </Alert>
          </>
        );

      case 'oidc.invalid_license':
        return (
          <>
            <Typography variant="body1" gutterBottom>
              {LL.ERRORS.INVALID_LICENSE_MESSAGE()}
            </Typography>
            <Alert severity="info" sx={{ mt: 2 }}>
              {LL.AUTH.CONTACT_ADMIN()}
            </Alert>
          </>
        );

      case 'oidc.no_provider':
        return (
          <>
            <Typography variant="body1" gutterBottom>
              {LL.ERRORS.CONTACT_ADMIN_ASSIGN_PROVIDER()}
            </Typography>
            <Alert severity="info" sx={{ mt: 2 }}>
              {LL.ERRORS.CONTACT_ADMIN_ASSIGN_PROVIDER()}
            </Alert>
          </>
        );

      case 'oidc.invalid_state':
        return (
          <>
            <Typography variant="body1" gutterBottom>
              {LL.ERRORS.INVALID_STATE_MESSAGE()}
            </Typography>
            <Alert severity="warning" sx={{ mt: 2 }}>
              {LL.AUTH.PLEASE_TRY_AGAIN()}
            </Alert>
          </>
        );

      case 'oidc.authentication_failed':
        return (
          <>
            <Typography variant="body1" gutterBottom>
              {LL.ERRORS.AUTHENTICATION_FAILED_MESSAGE()}
            </Typography>
            {details && (
              <Box sx={{ mt: 2 }}>
                <Typography
                  variant="subtitle2"
                  sx={{
                    color: 'text.secondary',
                  }}
                >
                  {LL.AUTH.TECHNICAL_DETAILS()}
                </Typography>
                <Typography
                  variant="body2"
                  sx={{ fontFamily: 'monospace', bgcolor: 'action.hover', p: 1, borderRadius: 1, wordBreak: 'break-word' }}
                >
                  {decodeURIComponent(details)}
                </Typography>
              </Box>
            )}
            <Alert severity="warning" sx={{ mt: 2 }}>
              {LL.AUTH.PLEASE_TRY_AGAIN()}
            </Alert>
          </>
        );

      default:
        return (
          <>
            <Typography variant="body1" gutterBottom>
              {LL.ERRORS.UNKNOWN_MESSAGE()}
            </Typography>
            {details && (
              <Box sx={{ mt: 2 }}>
                <Typography
                  variant="subtitle2"
                  sx={{
                    color: 'text.secondary',
                  }}
                >
                  {LL.AUTH.ERROR_CODE()}
                </Typography>
                <Typography
                  variant="body2"
                  sx={{ fontFamily: 'monospace', bgcolor: 'action.hover', p: 1, borderRadius: 1, wordBreak: 'break-word' }}
                >
                  {error || 'unknown'}
                </Typography>
              </Box>
            )}
          </>
        );
    }
  };

  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 2, bgcolor: 'background.default' }}>
      <Card sx={{ width: 720, maxWidth: '100%' }}>
        <CardContent>
          <Stack
            sx={{
              gap: 3,
            }}
          >
            <Stack
              direction="row"
              sx={{
                alignItems: 'center',
                gap: 2,
              }}
            >
              <ErrorIcon color="error" sx={{ fontSize: 48 }} />
              <Typography variant="h4" color="error">
                {getErrorTitle()}
              </Typography>
            </Stack>

            <Box>{getErrorMessage()}</Box>

            <Stack
              direction="row"
              sx={{
                gap: 2,
              }}
            >
              <Button variant="contained" startIcon={<BackIcon />} onClick={() => navigate('/login')} fullWidth>
                {LL.AUTH.BACK_TO_LOGIN()}
              </Button>
            </Stack>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
};
