import { useState, type ReactNode } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  Typography,
} from '@mui/material';
import { useI18nContext } from '@/i18n/i18n-react';
import { useLogout } from '@/hooks/useLogout';
import { oidcLogoutUrl } from '@/utils';

type Props = {
  open: boolean;
  onClose: () => void;
};

/** A checkbox with a title and an explanation underneath. */
const ResetOption = ({
  checked,
  onChange,
  title,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: ReactNode;
  hint: ReactNode;
}) => (
  <FormControlLabel
    control={<Checkbox checked={checked} onChange={(e) => onChange(e.target.checked)} />}
    label={
      <Stack sx={{ pt: 1 }}>
        <Typography variant="body1">{title}</Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {hint}
        </Typography>
      </Stack>
    }
    sx={{ alignItems: 'flex-start', mr: 0 }}
  />
);

/**
 * "Log out and reset": for a device stuck in a state a plain logout does not clear, such as
 * one that signs straight back in but sees no data. Cookies and local data are separate
 * choices — losing this device's settings is a price not every case needs to pay.
 */
export const LogoutResetDialog = ({ open, onClose }: Props) => {
  const { LL } = useI18nContext();
  const logout = useLogout();
  const [cookies, setCookies] = useState(false);
  const [storage, setStorage] = useState(false);
  const R = LL.AUTH.LOGOUT_RESET;
  const anySelected = cookies || storage;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{R.TITLE()}</DialogTitle>
      <DialogContent>
        <Stack sx={{ gap: 2 }}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {R.INTRO()}
          </Typography>
          <ResetOption checked={cookies} onChange={setCookies} title={R.COOKIES()} hint={R.COOKIES_HINT()} />
          <ResetOption checked={storage} onChange={setStorage} title={R.STORAGE()} hint={R.STORAGE_HINT()} />
          {storage && <Alert severity="warning">{R.STORAGE_WARNING()}</Alert>}
          {anySelected && (
            <Stack sx={{ gap: 0.5 }}>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {R.LINK_HINT()}
              </Typography>
              {/* The same URL the button opens — it works without a session, so it can be
                  sent to a device that cannot get as far as this menu. */}
              <Typography variant="caption" component="code" sx={{ fontFamily: 'monospace', wordBreak: 'break-all', userSelect: 'all' }}>
                {oidcLogoutUrl({ cookies, storage })}
              </Typography>
            </Stack>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit">
          {LL.COMMON.CANCEL()}
        </Button>
        <Button variant="contained" color="error" disabled={!anySelected} onClick={() => logout({ cookies, storage })}>
          {R.CONFIRM()}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
