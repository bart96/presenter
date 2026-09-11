/**
 * MixerLauncher — the lazy boundary for the monitor mixer.
 *
 * This module is part of the musician page's own bundle and is deliberately tiny: a
 * `lazy()` call and the fallback shown while its chunk downloads. `@/mixer/MixerView` and
 * everything it imports are emitted as a separate chunk that the browser does not fetch
 * until `open` first goes true — so a musician who only ever reads sheet music pays for
 * nothing but these few lines.
 *
 * The mixer is kept mounted once opened, hidden rather than unmounted, because closing it
 * would drop the subscription and cost a fresh snapshot every time someone glances at
 * their sheet and comes back. It is told whether it is actually on screen, though: a
 * hidden mixer must stop asking for meters, or the saving turns into ten frames a second
 * spent animating bars nobody can see.
 */
import { Suspense, lazy, useState } from 'react';
import { Box, CircularProgress } from '@mui/material';
import type { MixerBridge } from '@/hooks/useMixerBridge';
import type { MixerAnnouncement } from '@/audio/protocol';

const MixerView = lazy(() => import('@/mixer/MixerView'));

interface MixerLauncherProps {
  open: boolean;
  bridge: MixerBridge;
  announcement: MixerAnnouncement | null;
  onClose: () => void;
}

export const MixerLauncher = ({ open, bridge, announcement, onClose }: MixerLauncherProps) => {
  /**
   * Whether the chunk has ever been asked for. Rendering `<MixerView>` at all is what
   * triggers the download, so this stays false — and the import untouched — until the
   * musician actually opens the mixer.
   */
  const [everOpened, setEverOpened] = useState(false);
  // Adjusted during render rather than in an effect: an effect would render once with the
  // chunk still unrequested, and the fallback would flash before the import even started.
  if (open && !everOpened) setEverOpened(true);

  if (!everOpened || !announcement) return null;

  return (
    <Box sx={{ display: open ? 'block' : 'none' }}>
      <Suspense
        fallback={
          open ? (
            <Box
              sx={{
                position: 'fixed',
                inset: 0,
                zIndex: 1300,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: '#141618',
              }}
            >
              <CircularProgress />
            </Box>
          ) : null
        }
      >
        <MixerView bridge={bridge} announcement={announcement} onClose={onClose} active={open} />
      </Suspense>
    </Box>
  );
};
