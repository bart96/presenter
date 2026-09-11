import { useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
  createFilterOptions,
} from '@mui/material';
import {
  Add as AddIcon,
  DeleteOutlined as DeleteIcon,
  Group as BandIcon,
  KeyboardArrowDown as MoveDownIcon,
  KeyboardArrowUp as MoveUpIcon,
} from '@mui/icons-material';
import { useI18nContext } from '@/i18n/i18n-react';
import { useGetSettings } from '@/store/settingsSlice';
import { ColorSwatchButton } from '@/components/style/ColorPicker';
import { CommittedInput } from '@/components/settings/SettingRow';
import {
  useCreateBandMutation,
  useDeleteBandMutation,
  useGetBandsQuery,
  useReorderBandsMutation,
  useUpdateBandMutation,
  type Band,
} from '@/api/bands.api';

/**
 * The account's bands: who plays, what colour they get, and who is on them.
 *
 * A band was only ever an order name before ("Youth Band [G]"), so it could not be renamed
 * or listed anywhere. Naming it here is what makes it assignable to shows and set lists, and
 * what puts its name and its members into the autocompletes on the musician page, the
 * order-name dialog and the set list tag editor.
 *
 * Every edit saves immediately — there is no form to submit, matching the rest of the panel.
 */

/** The colour a band starts out with, so its chips are distinguishable before anyone picks one. */
const DEFAULT_BAND_COLOR = '#1976d2';

const BandRow = ({
  band,
  memberSuggestions,
  isFirst,
  isLast,
  disabled,
  onMove,
}: {
  band: Band;
  memberSuggestions: string[];
  isFirst: boolean;
  isLast: boolean;
  disabled: boolean;
  onMove: (delta: -1 | 1) => void;
}) => {
  const { LL } = useI18nContext();
  const [updateBand] = useUpdateBandMutation();
  const [deleteBand] = useDeleteBandMutation();
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Suggest the names other bands already use, so the same person is spelled the same way
  // on each of them — but freeSolo, because a new member has to be typeable.
  const filter = createFilterOptions<string>();

  return (
    <Box sx={{ py: 1, borderBottom: 1, borderColor: 'divider' }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <ColorSwatchButton
          value={band.color ?? DEFAULT_BAND_COLOR}
          onChange={(color) => updateBand({ id: band.id, color })}
          onClear={band.color ? () => updateBand({ id: band.id, color: null }) : undefined}
          ariaLabel={LL.BANDS.COLOR()}
          size={24}
        />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <CommittedInput
            value={band.name}
            type="text"
            onCommit={(name) => {
              const trimmed = name.trim();
              if (trimmed && trimmed !== band.name) updateBand({ id: band.id, name: trimmed });
            }}
          />
        </Box>
        <Tooltip title={LL.BANDS.MOVE_UP()}>
          <span>
            <IconButton size="small" disabled={isFirst || disabled} onClick={() => onMove(-1)}>
              <MoveUpIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={LL.BANDS.MOVE_DOWN()}>
          <span>
            <IconButton size="small" disabled={isLast || disabled} onClick={() => onMove(1)}>
              <MoveDownIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={LL.BANDS.DELETE()}>
          <IconButton size="small" color="error" onClick={() => setConfirmDelete(true)} disabled={disabled}>
            <DeleteIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      <Box sx={{ pt: 1, pl: 4 }}>
        <Autocomplete
          multiple
          freeSolo
          size="small"
          options={memberSuggestions.filter((name) => !band.members.includes(name))}
          value={band.members}
          onChange={(_e, members) => updateBand({ id: band.id, members: members.map((m) => m.trim()).filter(Boolean) })}
          filterOptions={(options, params) => {
            const filtered = filter(options, params);
            const input = params.inputValue.trim();
            // Offer the typed name itself, so adding someone new needs no separate button.
            if (input && !options.includes(input) && !band.members.includes(input)) filtered.push(input);
            return filtered;
          }}
          renderValue={(members, getItemProps) =>
            members.map((member, index) => {
              const { key, ...itemProps } = getItemProps({ index });
              return <Chip key={key} {...itemProps} size="small" label={member} />;
            })
          }
          renderInput={(params) => <TextField {...params} label={LL.BANDS.MEMBERS()} placeholder={LL.BANDS.MEMBERS_PLACEHOLDER()} />}
        />
      </Box>

      {confirmDelete && (
        <Alert
          severity="warning"
          sx={{ mt: 1 }}
          action={
            <Stack direction="row" spacing={1}>
              <Button size="small" onClick={() => setConfirmDelete(false)}>
                {LL.COMMON.CANCEL()}
              </Button>
              <Button
                size="small"
                color="error"
                variant="contained"
                onClick={() => {
                  setConfirmDelete(false);
                  deleteBand({ id: band.id });
                }}
              >
                {LL.COMMON.DELETE()}
              </Button>
            </Stack>
          }
        >
          {LL.BANDS.DELETE_CONFIRM({ name: band.name })}
        </Alert>
      )}
    </Box>
  );
};

export const BandsSection = () => {
  const { LL } = useI18nContext();
  const { offlineMode } = useGetSettings();
  const { data: bands = [], isLoading } = useGetBandsQuery(undefined, { skip: offlineMode });
  const [createBand] = useCreateBandMutation();
  const [reorderBands] = useReorderBandsMutation();

  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Names already on any band — the pool the member field suggests from.
  const memberSuggestions = Array.from(new Set(bands.flatMap((band) => band.members))).sort((a, b) => a.localeCompare(b));

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setNewName('');
    setError(null);
    try {
      await createBand({ name, color: DEFAULT_BAND_COLOR }).unwrap();
    } catch (e) {
      const message = (e as { data?: { error?: string }; message?: string })?.data?.error ?? (e as Error)?.message;
      setError(message || LL.BANDS.CREATE_FAILED());
    }
  };

  const handleMove = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= bands.length) return;
    const next = [...bands];
    [next[index], next[target]] = [next[target], next[index]];
    reorderBands({ order: next.map((band) => band.id) });
  };

  if (offlineMode) {
    return (
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {LL.BANDS.OFFLINE()}
      </Typography>
    );
  }

  return (
    <Stack spacing={1} sx={{ pt: 0.5 }}>
      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {!isLoading && bands.length === 0 && (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {LL.BANDS.NONE_YET()}
        </Typography>
      )}

      <Box>
        {bands.map((band, index) => (
          <BandRow
            key={band.id}
            band={band}
            memberSuggestions={memberSuggestions}
            isFirst={index === 0}
            isLast={index === bands.length - 1}
            disabled={isLoading}
            onMove={(delta) => handleMove(index, delta)}
          />
        ))}
      </Box>

      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', pt: 0.5 }}>
        <TextField
          size="small"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={LL.BANDS.NEW_PLACEHOLDER()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void handleCreate();
            }
          }}
          slotProps={{ input: { startAdornment: <BandIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} /> } }}
          sx={{ flex: 1 }}
        />
        <Button size="small" variant="outlined" startIcon={<AddIcon />} disabled={!newName.trim()} onClick={() => void handleCreate()}>
          {LL.COMMON.ADD()}
        </Button>
      </Stack>
    </Stack>
  );
};
