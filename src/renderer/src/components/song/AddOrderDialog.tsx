import { useMemo, useState } from 'react';
import {
  Autocomplete,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  Typography,
  createFilterOptions,
} from '@mui/material';
import { useI18nContext } from '@/i18n/i18n-react';
import { useBands } from '@/hooks/useBands';
import { useGetShow } from '@/store/showSlice';

type Props = {
  open: boolean;
  onClose: () => void;
  orders: { [key: string]: string[] };
  onCreate: (name: string) => void;
};

/**
 * Naming a new block order.
 *
 * Orders are in practice named after the band that plays them, so the account's bands are
 * offered as suggestions — the ones playing the open show first, and that first one is
 * filled in ready to accept. It stays free text: an order may just as well be called
 * "Short" or "Christmas".
 */
const AddOrderDialog = ({ open, onClose, orders, onCreate }: Props) => {
  const { LL } = useI18nContext();
  const { bandNames, resolve } = useBands();
  const { currentShow } = useGetShow();
  const [newOrderName, setNewOrderName] = useState('');

  const showBandNames = useMemo(() => resolve(currentShow?.bandIds).map((band) => band.name), [resolve, currentShow?.bandIds]);

  // Bands of the open show first, then the rest — minus anything this song already has an
  // order for, which could only produce a rejected duplicate.
  const suggestions = useMemo(() => {
    const ordered = [...showBandNames, ...bandNames.filter((name) => !showBandNames.includes(name))];
    return ordered.filter((name) => !orders[name]);
  }, [showBandNames, bandNames, orders]);

  // Opening the dialog offers the show's band as the ready-made answer — done on the
  // open→closed edge during render rather than in an effect, so it can never overwrite
  // what is already being typed.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setNewOrderName(suggestions[0] && showBandNames.includes(suggestions[0]) ? suggestions[0] : '');
  }

  const filter = createFilterOptions<string>();
  const trimmed = newOrderName.trim();
  const exists: boolean = !!trimmed && !!orders[trimmed];

  const submit = () => {
    if (!trimmed || exists) return;
    onCreate(trimmed);
    setNewOrderName('');
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{LL.SONG_EDITOR.ADD_ORDER_TITLE()}</DialogTitle>
      <DialogContent>
        <Autocomplete
          freeSolo
          openOnFocus
          options={suggestions}
          inputValue={newOrderName}
          onInputChange={(_e, value) => setNewOrderName(value)}
          filterOptions={(options, params) => filter(options, params)}
          renderInput={(params) => (
            <TextField
              {...params}
              autoFocus
              margin="dense"
              label={LL.SONG_EDITOR.ORDER_NAME_LABEL()}
              fullWidth
              placeholder={LL.SONG_EDITOR.ORDER_NAME_PLACEHOLDER()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          )}
        />
        {trimmed && exists && (
          <Typography color="error" variant="caption" sx={{ mt: 1, display: 'block' }}>
            {LL.SONG_EDITOR.ORDER_EXISTS()}
          </Typography>
        )}
        {suggestions.length > 0 && !exists && (
          <Typography variant="caption" sx={{ mt: 1, display: 'block', color: 'text.secondary' }}>
            {LL.SONG_EDITOR.ORDER_NAME_BAND_HINT()}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button
          onClick={() => {
            onClose();
            setNewOrderName('');
          }}
        >
          {LL.COMMON.CANCEL()}
        </Button>
        <Button onClick={submit} variant="contained" disabled={!trimmed || exists}>
          {LL.COMMON.ADD()}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default AddOrderDialog;
