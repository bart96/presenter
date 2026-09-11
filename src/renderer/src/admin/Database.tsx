import {
  Alert,
  Box,
  Button,
  Chip,
  LinearProgress,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { CheckCircle as CheckCircleIcon, RadioButtonUnchecked as PendingIcon, Storage as StorageIcon } from '@mui/icons-material';
import { useI18nContext } from '@/i18n/i18n-react';
import { useGetAdminConfigQuery, useGetAdminMigrationsQuery, useRunAdminMigrationsMutation } from '@/api/admin.api';
import { DbCopy } from './DbCopy';

export const Database = () => {
  const { LL } = useI18nContext();
  const { data: migrationStatus, isLoading: migrationsLoading } = useGetAdminMigrationsQuery();
  // The copy endpoint only exists on a dev build that also has a copy.config.php. Asking
  // AdminConfig keeps this off the 404 path on every other deployment.
  const { data: config } = useGetAdminConfigQuery();
  const [runMigrations, { isLoading: migrationsRunning, data: migrationResult, reset: resetMigrationResult }] =
    useRunAdminMigrationsMutation();

  return (
    <Stack sx={{ gap: 2 }}>
      {config?.devTools?.dbCopy && <DbCopy />}

      <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <StorageIcon />
          <Typography variant="h6">{LL.ADMIN.MIGRATIONS_TITLE()}</Typography>
        </Stack>
        {migrationStatus && (
          <Chip
            label={
              migrationStatus.pendingCount === 0
                ? LL.ADMIN.MIGRATIONS_UP_TO_DATE()
                : LL.ADMIN.MIGRATIONS_PENDING({ count: migrationStatus.pendingCount })
            }
            color={migrationStatus.pendingCount === 0 ? 'success' : 'warning'}
            size="small"
          />
        )}
      </Stack>

      {migrationStatus && (
        <Typography variant="body2" color="text.secondary">
          {LL.ADMIN.MIGRATIONS_CURRENT_VERSION({ version: migrationStatus.currentVersion })}
          {' · '}
          {LL.ADMIN.MIGRATIONS_VERSION({ version: migrationStatus.latestVersion })} latest
        </Typography>
      )}

      {migrationStatus && migrationStatus.pendingCount > 0 && (
        <Box>
          <Button
            variant="contained"
            color="warning"
            disabled={migrationsRunning}
            onClick={async () => {
              resetMigrationResult();
              await runMigrations();
            }}
          >
            {migrationsRunning ? LL.ADMIN.MIGRATIONS_RUNNING() : LL.ADMIN.MIGRATIONS_RUN()}
          </Button>
        </Box>
      )}

      {migrationsRunning && <LinearProgress />}

      {migrationResult && (
        <Stack spacing={1}>
          {migrationResult.errors?.length > 0 ? (
            migrationResult.errors.map((e) => (
              <Alert key={e.version} severity="error">
                {LL.ADMIN.MIGRATIONS_ERROR({ version: e.version, error: e.error })}
              </Alert>
            ))
          ) : (
            <Alert severity="success">{LL.ADMIN.MIGRATIONS_SUCCESS({ count: migrationResult.applied?.length ?? 0 })}</Alert>
          )}
          {migrationResult.applied
            ?.map((a) => a.output)
            .filter(Boolean)
            .map((out, i) => (
              <Paper key={i} variant="outlined" sx={{ p: 1 }}>
                <Typography variant="caption" sx={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
                  {out}
                </Typography>
              </Paper>
            ))}
        </Stack>
      )}

      {migrationsLoading ? (
        <LinearProgress />
      ) : migrationStatus ? (
        <Paper variant="outlined">
          <List dense disablePadding>
            {migrationStatus.migrations.map((m, idx) => (
              <ListItem key={m.version} divider={idx < migrationStatus.migrations.length - 1} sx={{ gap: 1 }}>
                <ListItemIcon sx={{ minWidth: 32 }}>
                  {m.applied ? <CheckCircleIcon fontSize="small" color="success" /> : <PendingIcon fontSize="small" color="warning" />}
                </ListItemIcon>
                <ListItemText
                  primary={
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 600, minWidth: 28 }}>
                        v{m.version}
                      </Typography>
                      <Typography variant="body2">{m.description}</Typography>
                    </Stack>
                  }
                  secondary={
                    m.applied && m.appliedAt
                      ? LL.ADMIN.MIGRATIONS_APPLIED_AT({ date: new Date(m.appliedAt).toLocaleString() })
                      : LL.ADMIN.MIGRATIONS_PENDING_BADGE()
                  }
                />
                <Chip
                  label={m.applied ? LL.ADMIN.MIGRATIONS_APPLIED_BADGE() : LL.ADMIN.MIGRATIONS_PENDING_BADGE()}
                  color={m.applied ? 'success' : 'warning'}
                  size="small"
                  variant="outlined"
                />
              </ListItem>
            ))}
          </List>
        </Paper>
      ) : null}
    </Stack>
  );
};
