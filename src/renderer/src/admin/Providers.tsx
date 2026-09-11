import { useState, useEffect } from 'react';
import {
  Alert,
  Button,
  Chip,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Switch,
  FormControlLabel,
} from '@mui/material';
import { Add as AddIcon, Edit as EditIcon, Delete as DeleteIcon } from '@mui/icons-material';
import { useI18nContext } from '@/i18n/i18n-react';
import {
  useGetAdminProvidersQuery,
  useCreateAdminProviderMutation,
  useUpdateAdminProviderMutation,
  useDeleteAdminProviderMutation,
  type OidcProvider,
  type CreateProviderRequest,
  type UpdateProviderRequest,
} from '@/api/admin.api';

export const Providers = () => {
  const { LL } = useI18nContext();
  const { data: providers = [], isLoading, error } = useGetAdminProvidersQuery();
  const [createProvider] = useCreateAdminProviderMutation();
  const [updateProvider] = useUpdateAdminProviderMutation();
  const [deleteProvider] = useDeleteAdminProviderMutation();

  const [providerDialog, setProviderDialog] = useState<{ open: boolean; provider?: OidcProvider }>({ open: false });
  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean; id?: number; name?: string }>({ open: false });

  const handleSave = async (data: CreateProviderRequest | UpdateProviderRequest) => {
    try {
      if ('id' in data && providerDialog.provider) {
        await updateProvider(data).unwrap();
      } else {
        await createProvider(data as CreateProviderRequest).unwrap();
      }
      setProviderDialog({ open: false });
    } catch (e) {
      console.error('Failed to save provider:', e);
    }
  };

  const handleDelete = async () => {
    if (!deleteDialog.id) return;
    try {
      await deleteProvider({ id: deleteDialog.id }).unwrap();
      setDeleteDialog({ open: false });
    } catch (e) {
      console.error('Failed to delete provider:', e);
    }
  };

  return (
    <Stack sx={{ gap: 2 }}>
      <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography variant="h6">
          {LL.ADMIN.OIDC_PROVIDERS()} ({providers.length})
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setProviderDialog({ open: true })}>
          {LL.ADMIN.ADD_PROVIDER()}
        </Button>
      </Stack>

      {error && <Alert severity="error">{LL.ADMIN.FAILED_TO_LOAD_PROVIDERS()}</Alert>}

      {isLoading ? (
        <Typography>{LL.COMMON.LOADING()}</Typography>
      ) : (
        <TableContainer component={Paper}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>{LL.COMMON.NAME()}</TableCell>
                <TableCell>{LL.ADMIN.DISCOVERY_URL()}</TableCell>
                <TableCell>{LL.ADMIN.CLIENT_ID()}</TableCell>
                <TableCell>{LL.COMMON.STATUS()}</TableCell>
                <TableCell>{LL.COMMON.ACTIONS()}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {providers.map((provider) => (
                <TableRow key={provider.id}>
                  <TableCell>{provider.name}</TableCell>
                  <TableCell sx={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{provider.discovery_url}</TableCell>
                  <TableCell sx={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>{provider.client_id}</TableCell>
                  <TableCell>
                    <Chip
                      label={provider.enabled ? LL.COMMON.ENABLED() : LL.COMMON.DISABLED()}
                      color={provider.enabled ? 'success' : 'default'}
                      size="small"
                    />
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={1}>
                      <IconButton size="small" onClick={() => setProviderDialog({ open: true, provider })}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                      <IconButton
                        size="small"
                        color="error"
                        onClick={() => setDeleteDialog({ open: true, id: provider.id, name: provider.name })}
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <ProviderDialog
        open={providerDialog.open}
        provider={providerDialog.provider}
        onClose={() => setProviderDialog({ open: false })}
        onSave={handleSave}
      />
      <Dialog open={deleteDialog.open} onClose={() => setDeleteDialog({ open: false })} maxWidth="sm" fullWidth>
        <DialogTitle>{LL.ADMIN.CONFIRM_DELETE()}</DialogTitle>
        <DialogContent>
          <Typography>{LL.ADMIN.CONFIRM_DELETE_PROVIDER({ name: deleteDialog.name || '' })}</Typography>
          <Alert severity="warning" sx={{ mt: 2 }}>
            {LL.ADMIN.ACTION_CANNOT_BE_UNDONE()}
          </Alert>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialog({ open: false })}>{LL.COMMON.CANCEL()}</Button>
          <Button onClick={handleDelete} color="error" variant="contained">
            {LL.COMMON.DELETE()}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
};

const ProviderDialog = ({
  open,
  provider,
  onClose,
  onSave,
}: {
  open: boolean;
  provider?: OidcProvider;
  onClose: () => void;
  onSave: (data: CreateProviderRequest | UpdateProviderRequest) => void;
}) => {
  const { LL } = useI18nContext();
  const [formData, setFormData] = useState({
    id: 0,
    name: '',
    discovery_url: '',
    client_id: '',
    client_secret: '',
    scopes: 'openid email profile groups',
    required_group: '',
    enabled: true,
  });

  useEffect(() => {
    if (open) {
      setFormData({
        id: provider?.id || 0,
        name: provider?.name || '',
        discovery_url: provider?.discovery_url || '',
        client_id: provider?.client_id || '',
        client_secret: provider?.client_secret || '',
        scopes: provider?.scopes || 'openid email profile groups',
        required_group: provider?.required_group || '',
        enabled: provider?.enabled ?? true,
      });
    }
  }, [open, provider]);

  const handleSubmit = () => {
    if (provider) {
      onSave({ ...formData, id: formData.id });
    } else {
      const { id: _id, ...createData } = formData;
      onSave(createData);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{provider ? LL.ADMIN.EDIT_PROVIDER() : LL.ADMIN.CREATE_PROVIDER()}</DialogTitle>
      <DialogContent>
        <Stack sx={{ gap: 2, mt: 1 }}>
          <TextField
            label={LL.ADMIN.PROVIDER_NAME()}
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            fullWidth
          />
          <TextField
            label={LL.ADMIN.DISCOVERY_URL()}
            value={formData.discovery_url}
            onChange={(e) => setFormData({ ...formData, discovery_url: e.target.value })}
            fullWidth
            placeholder="https://idp.example.com/.well-known/openid-configuration"
          />
          <TextField
            label={LL.ADMIN.CLIENT_ID()}
            value={formData.client_id}
            onChange={(e) => setFormData({ ...formData, client_id: e.target.value })}
            fullWidth
          />
          <TextField
            label={LL.ADMIN.CLIENT_SECRET()}
            value={formData.client_secret}
            onChange={(e) => setFormData({ ...formData, client_secret: e.target.value })}
            fullWidth
            type="password"
          />
          <TextField
            label={LL.ADMIN.SCOPES()}
            value={formData.scopes}
            onChange={(e) => setFormData({ ...formData, scopes: e.target.value })}
            fullWidth
            helperText={LL.ADMIN.SCOPES_HELP()}
          />
          <TextField
            label={LL.ADMIN.REQUIRED_GROUP_OPTIONAL()}
            value={formData.required_group}
            onChange={(e) => setFormData({ ...formData, required_group: e.target.value })}
            fullWidth
            helperText={LL.ADMIN.REQUIRED_GROUP_HELP()}
          />
          <FormControlLabel
            control={<Switch checked={formData.enabled} onChange={(e) => setFormData({ ...formData, enabled: e.target.checked })} />}
            label={LL.COMMON.ENABLED()}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{LL.COMMON.CANCEL()}</Button>
        <Button onClick={handleSubmit} variant="contained">
          {LL.COMMON.SAVE()}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
