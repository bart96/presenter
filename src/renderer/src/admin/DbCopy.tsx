import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  LinearProgress,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { CloudDownload as CloudDownloadIcon, SwapHoriz as SwapHorizIcon } from '@mui/icons-material';
import { useI18nContext } from '@/i18n/i18n-react';
import { useGetDbCopyStatusQuery, useRunDbCopyMutation } from '@/api/admin.api';

const mono = { fontFamily: 'monospace' } as const;

/**
 * "Copy from another database" — only rendered when AdminConfig reports the endpoint as
 * available, which needs both api/DbCopy.php (dev builds only) and a copy.config.php on
 * the server. See api/DbCopy.php for what the two halves guard against.
 */
export const DbCopy = () => {
  const { LL } = useI18nContext();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [showTables, setShowTables] = useState(false);

  const { data: status, isLoading, error } = useGetDbCopyStatusQuery();
  const [runCopy, { isLoading: running, data: result, reset }] = useRunDbCopyMutation();

  const start = async (dryRun: boolean) => {
    setConfirmOpen(false);
    reset();
    await runCopy({ dryRun });
  };

  const totalRows = status?.tables.reduce((sum, table) => sum + table.rows, 0) ?? 0;
  const copiedTables = status?.tables.filter((table) => table.mode !== 'excluded').length ?? 0;

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack sx={{ gap: 2 }}>
        <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', gap: 1 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <CloudDownloadIcon />
            <Typography variant="h6">{LL.ADMIN.DB_COPY_TITLE()}</Typography>
          </Stack>
          <Chip label={LL.ADMIN.DB_COPY_DEV_ONLY()} size="small" color="warning" variant="outlined" />
        </Stack>

        {isLoading && <LinearProgress />}

        {/* A misconfigured copy.config.php is the usual cause — the message says which key. */}
        {error != null && <Alert severity="error">{LL.ADMIN.DB_COPY_UNAVAILABLE()}</Alert>}

        {status && (
          <>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <Typography variant="body2" sx={mono}>
                {status.source.host}/{status.source.database}
              </Typography>
              <SwapHorizIcon fontSize="small" color="action" />
              <Typography variant="body2" sx={mono}>
                {status.target.host}/{status.target.database}
              </Typography>
            </Stack>

            <Typography variant="body2" color="text.secondary">
              {LL.ADMIN.DB_COPY_SUMMARY({ tables: copiedTables, rows: totalRows })}
              {' · '}
              {LL.ADMIN.DB_COPY_SCHEMA_VERSIONS({
                source: status.source.schemaVersion ?? 0,
                target: status.target.schemaVersion ?? 0,
              })}
            </Typography>

            {status.replacements.length > 0 && (
              <Box>
                <Typography variant="caption" color="text.secondary">
                  {LL.ADMIN.DB_COPY_REWRITES_LABEL()}
                </Typography>
                {status.replacements.map((replacement) => (
                  <Typography key={replacement.from} variant="caption" component="div" sx={mono}>
                    {replacement.from} → {replacement.to || '∅'}
                  </Typography>
                ))}
              </Box>
            )}

            {status.dataDir.configured && (
              <Typography variant="caption" color={status.dataDir.readable ? 'text.secondary' : 'warning.main'}>
                {status.dataDir.readable
                  ? LL.ADMIN.DB_COPY_DATA_DIR({ path: status.dataDir.source })
                  : LL.ADMIN.DB_COPY_DATA_DIR_UNREADABLE({ path: status.dataDir.source })}
              </Typography>
            )}

            <Alert severity="warning">{LL.ADMIN.DB_COPY_WARNING({ database: status.target.database })}</Alert>

            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
              <Button variant="outlined" disabled={running} onClick={() => start(true)}>
                {LL.ADMIN.DB_COPY_PREVIEW()}
              </Button>
              <Button variant="contained" color="warning" disabled={running} onClick={() => setConfirmOpen(true)}>
                {running ? LL.ADMIN.DB_COPY_RUNNING() : LL.ADMIN.DB_COPY_RUN()}
              </Button>
              <Button size="small" onClick={() => setShowTables((open) => !open)}>
                {showTables ? LL.ADMIN.DB_COPY_HIDE_TABLES() : LL.ADMIN.DB_COPY_SHOW_TABLES()}
              </Button>
            </Stack>

            <Collapse in={showTables}>
              <Paper variant="outlined">
                <List dense disablePadding>
                  {status.tables.map((table) => (
                    <ListItem key={table.name} sx={{ py: 0.25 }}>
                      <ListItemText
                        primary={
                          <Typography variant="caption" sx={mono}>
                            {table.name}
                          </Typography>
                        }
                      />
                      <Typography variant="caption" color="text.secondary">
                        {table.mode === 'data'
                          ? LL.ADMIN.DB_COPY_TABLE_ROWS({ rows: table.rows })
                          : table.mode === 'structure'
                            ? LL.ADMIN.DB_COPY_TABLE_STRUCTURE()
                            : LL.ADMIN.DB_COPY_TABLE_EXCLUDED()}
                      </Typography>
                    </ListItem>
                  ))}
                </List>
              </Paper>
            </Collapse>
          </>
        )}

        {running && <LinearProgress />}

        {result && (
          <Stack spacing={1}>
            <Alert severity={result.dryRun ? 'info' : 'success'}>
              {result.dryRun
                ? LL.ADMIN.DB_COPY_DRY_RUN_RESULT({ tables: result.tables.length, rows: result.rowsCopied })
                : LL.ADMIN.DB_COPY_RESULT({
                    tables: result.tables.length,
                    rows: result.rowsCopied,
                    seconds: Math.round(result.durationMs / 100) / 10,
                  })}
            </Alert>

            {!result.dryRun && result.rowsRewritten > 0 && (
              <Alert severity="info">{LL.ADMIN.DB_COPY_REWRITTEN({ rows: result.rowsRewritten })}</Alert>
            )}

            {!result.dryRun && result.dataFiles !== null && (
              <Alert severity="info">{LL.ADMIN.DB_COPY_FILES({ files: result.dataFiles })}</Alert>
            )}

            {/* The copy brings the source's schema_version along, so anything this build
                added since is now pending in the list below. */}
            {!result.dryRun && <Alert severity="warning">{LL.ADMIN.DB_COPY_SCHEMA_HINT({ version: result.schemaVersion ?? 0 })}</Alert>}
          </Stack>
        )}
      </Stack>

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogTitle>{LL.ADMIN.DB_COPY_CONFIRM_TITLE()}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {LL.ADMIN.DB_COPY_CONFIRM_BODY({
              source: `${status?.source.host}/${status?.source.database}`,
              target: `${status?.target.host}/${status?.target.database}`,
            })}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>{LL.COMMON.CANCEL()}</Button>
          <Button color="warning" variant="contained" onClick={() => start(false)}>
            {LL.ADMIN.DB_COPY_RUN()}
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
};
