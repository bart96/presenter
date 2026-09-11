/**
 * MixerStripPicker — which channels this device shows on this mix.
 *
 * Per mix, not per device: a drummer's wedge and the singer's in-ears want different
 * strips, and the same phone may well be used to set up both. Kept with the rest of the
 * musician's preferences (`musicianSlice`, one `presenter_musician_settings` key) and
 * never sent anywhere (contract §4.2) — a new phone starts from the full list, and picking
 * six channels again is a ten-second job, not something worth a sync protocol that two
 * people could overwrite for each other mid-service.
 *
 * **A grid rather than a list.** A list spends the full width of the dialog letting one
 * channel say "Git 2", which buys nothing and leaves an X32's forty-eight channels four
 * screens apart. What is being chosen is a column on a console, so laying the choices out
 * as columns shows a whole desk at once and makes the picker read like the mixer it is
 * filling in. Each tile carries the same colour flash, in the same place, as the strip it
 * switches on.
 */
import { useMemo } from 'react';
import { Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Typography } from '@mui/material';
import { Check as CheckIcon, PersonPin as MineIcon, PersonPinOutlined as NotMineIcon } from '@mui/icons-material';
import { useI18nContext } from '@/i18n/i18n-react';
import type { IStrip } from '@/audio/protocol';
import { MINE_COLOUR } from './MixerChannel';

interface MixerStripPickerProps {
  open: boolean;
  onClose: () => void;
  strips: IStrip[];
  mixId: string;
  /** Every channel the desk offers, in order — what "show all" means right now. */
  allIds: string[];
  /**
   * The chosen channels. Always explicit, and empty on a device that has not picked yet:
   * a musician sees nothing until they say what they want, which beats meeting a wall of
   * forty-eight faders. See `visibleStripIds` in `MixerView`.
   */
  selected: string[];
  onChange: (ids: string[]) => void;
  /** Strips marked as this musician. Not per mix — see `mixerMyStrips`. */
  mine: string[];
  onChangeMine: (ids: string[]) => void;
}

export const MixerStripPicker = ({
  open,
  onClose,
  strips,
  mixId,
  allIds,
  selected,
  onChange,
  mine,
  onChangeMine,
}: MixerStripPickerProps) => {
  const { LL } = useI18nContext();
  const mineSet = useMemo(() => new Set(mine), [mine]);

  const toggleMine = (id: string) => {
    const next = new Set(mineSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChangeMine([...next]);
  };

  const chosen = useMemo(() => new Set(selected), [selected]);

  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // Kept in the desk's own order rather than tap order, so the mixer's columns match
    // the channel numbering however the list was built up.
    onChange(allIds.filter((stripId) => next.has(stripId)));
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      scroll="paper"
      // The default margin costs 64px of a 375px phone, which is the difference between
      // two channels across and three. The dialog is a working screen here, not a notice.
      sx={{ '& .MuiDialog-paper': { m: 1.5, width: 'calc(100% - 24px)', maxHeight: 'calc(100% - 24px)' } }}
    >
      <DialogTitle sx={{ pb: 0.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>{LL.MIXER.VISIBLE_STRIPS()}</Box>
          {/* Bare numbers rather than a sentence: it is glanced at mid-service, and
              "9 / 48" needs no translating. */}
          <Chip size="small" label={`${chosen.size} / ${strips.length}`} sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }} />
        </Box>
        <Typography variant="body2" color="text.secondary">
          {LL.MIXER.VISIBLE_STRIPS_HINT({ mix: mixId })}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          {LL.MIXER.MINE_HINT()}
        </Typography>
      </DialogTitle>

      <DialogContent dividers sx={{ p: 1.25 }}>
        <Box
          sx={{
            display: 'grid',
            // Sized so a phone in portrait fits three across with room to spare, and a
            // tablet simply gets more columns rather than wider tiles — which is what
            // keeps a whole desk on one screen instead of stretching six channels over it.
            gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
            gap: 1,
          }}
        >
          {strips.map((strip) => {
            const isChosen = chosen.has(strip.id);
            const isMine = mineSet.has(strip.id);
            return (
              <Box
                key={strip.id}
                component="button"
                type="button"
                onClick={() => toggle(strip.id)}
                aria-pressed={isChosen}
                sx={{
                  position: 'relative',
                  display: 'block',
                  width: '100%',
                  p: 0,
                  pb: 0.75,
                  cursor: 'pointer',
                  textAlign: 'left',
                  overflow: 'hidden',
                  borderRadius: 1.5,
                  border: '1px solid',
                  borderColor: isChosen ? 'primary.main' : 'divider',
                  // Chosen tiles are tinted, not merely ticked, so the shape of the
                  // selection is readable without inspecting a single control.
                  backgroundColor: isChosen ? 'action.selected' : 'transparent',
                  color: 'text.primary',
                  '&:hover': { borderColor: isChosen ? 'primary.main' : 'text.disabled' },
                }}
              >
                {/* The desk's own scribble colour, worn where the strip wears it. */}
                <Box sx={{ height: 4, backgroundColor: strip.color || '#7a8087' }} />

                <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5, px: 0.75, pt: 0.5 }}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography
                      noWrap
                      title={strip.name}
                      sx={{ fontSize: '0.78rem', fontWeight: 600, color: isMine ? MINE_COLOUR : 'inherit' }}
                    >
                      {strip.name}
                    </Typography>
                    <Typography sx={{ fontSize: '0.65rem', color: 'text.secondary', lineHeight: 1.2 }}>{strip.id}</Typography>
                  </Box>

                  {/* Marking a channel as yourself is a different question from whether to
                      show it, so it keeps its own control rather than sharing the tile's.
                      A span, not a nested button, which is invalid inside one — and no
                      tooltip, because the header already says this permanently and a
                      hovering copy of the same sentence covers three tiles on a phone. */}
                  <IconButton
                    component="span"
                    role="button"
                    size="small"
                    aria-label={LL.MIXER.MINE_HINT()}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleMine(strip.id);
                    }}
                    sx={{ mt: -0.25, mr: -0.5, p: 0.25, color: isMine ? MINE_COLOUR : 'text.disabled' }}
                  >
                    {isMine ? <MineIcon fontSize="small" /> : <NotMineIcon fontSize="small" />}
                  </IconButton>
                </Box>

                {/* The tick confirms rather than announces — the tint is what carries at a
                    glance, and this is what settles it when the room is dark. */}
                <CheckIcon
                  fontSize="small"
                  sx={{ position: 'absolute', right: 4, bottom: 2, fontSize: '0.9rem', color: 'primary.main', opacity: isChosen ? 1 : 0 }}
                />
              </Box>
            );
          })}
        </Box>
      </DialogContent>

      <DialogActions>
        <Button onClick={() => onChange(allIds)} size="small">
          {LL.MIXER.SHOW_ALL()}
        </Button>
        {/* The other end of the same shortcut: clearing the lot beats forty-odd taps of
            un-ticking on an X32 when you want to start again from a few. */}
        <Button onClick={() => onChange([])} size="small">
          {LL.MIXER.HIDE_ALL()}
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose} size="small" variant="contained">
          {LL.MIXER.DONE()}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
