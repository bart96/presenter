import { useCallback } from 'react';
import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { useAppDispatch, useAppSelector } from './hooks';
import type { MidiAction } from '@/hooks/useMidi';
import { persistState } from './persist';

type TrackingMaster = 'operator' | 'midi';

export const MUSICIAN_SETTINGS_KEY = 'presenter_musician_settings';

export interface MusicianState {
  musicianName: string;
  musicianBand: string;
  /**
   * Annotation layer selected for editing by default when the PDF annotation toolbar opens.
   * Empty means "my own layer" — the musician name, or `default` when no name is set.
   * Set it to `default` to edit the shared layer everyone sees.
   */
  musicianAnnotationLayer: string;
  musicianPageView: 'two-page' | 'one-page';
  musicianBlockIndicator: boolean;
  musicianTextSize: number;
  musicianTheme: 'dark' | 'light';
  musicianShowFooter: boolean;
  musicianToolbarExpanded: boolean;
  musicianSyncMode: 'off' | 'operator' | 'midi';
  musicianSidebarOpen: boolean;
  musicianLastItemIndex: number;
  /** Auto-apply server updates (show, songs, orders, PDFs, annotations) without asking. */
  musicianAutoRefresh: boolean;
  /** Remote control: MIDI message key (e.g. "cc_64") → action. */
  midiMappings: Record<string, MidiAction>;
  /** Who drives block tracking on the operator side: the operator or the MIDI musician. */
  midiTrackingMaster: TrackingMaster;
  /** Remote control: keyboard combo (e.g. "Ctrl+ArrowRight") → action. */
  musicianKeyboardMappings: Record<string, MidiAction>;
  /**
   * Remote control: ignore a repeat of the SAME action within this many milliseconds.
   * Guards against bouncing footswitches double-triggering a jump. 0 disables the filter.
   */
  musicianRemoteDebounceMs: number;
  /** Monitor mixer: the mix this device was last listening on, restored on reopen. */
  mixerLastMixId: string;
  /**
   * Monitor mixer: which strips this device shows, keyed by mix id. An absent entry means
   * all of them.
   *
   * Device-local by design (audio bridge contract §4.2): the same rig is used by a tech
   * with a tablet and by a guitarist with a phone, and they do not want the same six
   * channels. Syncing it would have them overwrite each other every service, to save a
   * ten-second job on a new device.
   */
  mixerVisibleStrips: Record<string, string[]>;
  /**
   * Monitor mixer: show the *global* strip mutes — the ones that take a channel out of
   * every mix at once, the main included.
   *
   * Off by default, and the operator has to allow them as well. Someone plugging a cable
   * into channel 7 wants to mute it first and should not have to walk to the desk; a
   * guitarist adjusting their own wedge does not need a control that silences them in
   * the house.
   */
  mixerShowStripMutes: boolean;
  /** Monitor mixer: draw level meters. Costs relay bandwidth on this device's connection. */
  mixerShowMeters: boolean;
  /**
   * Monitor mixer: open as a panel across the bottom third rather than full screen.
   *
   * The default, because the usual reason to open it is to nudge one thing and keep
   * playing — and a full-screen mixer takes the music away to do that. It also suits the
   * shape of the device: tablets on a stand are in portrait, where stretching a dozen
   * faders over the whole height buys travel nobody needs and costs the sheet.
   */
  mixerCompact: boolean;
  /**
   * Monitor mixer: height of that bottom panel in pixels, dragged by its grip.
   *
   * 0 means "never adjusted", which falls back to a third of the viewport rather than to a
   * fixed number — so a phone and a tablet each start somewhere sensible. A stored value is
   * capped against the viewport in CSS, so rotating the device cannot leave a panel taller
   * than the screen it is on.
   */
  mixerPanelHeight: number;
  /**
   * Monitor mixer: strips this musician has marked as themselves, outlined so they can be
   * found without reading.
   *
   * Not per mix, unlike `mixerVisibleStrips`: a guitarist is on the same channel whichever
   * wedge they happen to be listening to, and having to mark it again per bus would be a
   * chore with no upside. Device-local for the same reason the visible list is — it is a
   * statement about who is holding the phone.
   */
  mixerMyStrips: string[];
  /**
   * Monitor mixer: which end of the strip the main mute sits on.
   *
   * Above by default, where it is furthest from the per-mix mute inside the strip and
   * hardest to hit by accident. Below suits a tablet held low, or a phone where the thumb
   * never reaches the top of a bottom panel — so it is offered rather than decided, and it
   * stays outside the strip's own frame either way. See `MixerChannel`.
   */
  mixerMainMuteAtBottom: boolean;
}

const defaultMusicianSettings: MusicianState = {
  musicianName: '',
  musicianBand: '',
  musicianAnnotationLayer: '',
  musicianPageView: 'one-page',
  musicianBlockIndicator: true,
  musicianTextSize: 16,
  musicianTheme: 'dark',
  musicianShowFooter: true,
  musicianToolbarExpanded: true,
  musicianSyncMode: 'operator',
  musicianSidebarOpen: true,
  musicianLastItemIndex: 0,
  musicianAutoRefresh: false,
  midiMappings: {},
  midiTrackingMaster: 'operator',
  musicianKeyboardMappings: {},
  musicianRemoteDebounceMs: 0,
  mixerLastMixId: '',
  mixerVisibleStrips: {},
  mixerShowStripMutes: false,
  mixerShowMeters: true,
  mixerCompact: true,
  mixerPanelHeight: 0,
  mixerMyStrips: [],
  mixerMainMuteAtBottom: false,
};

/**
 * Stored musician settings on the current defaults. Runs when the module loads, and again
 * whenever another window of the app rewrites the key (see storageSync).
 */
export const readStoredMusicianSettings = (raw: string | null): MusicianState => {
  try {
    const parsed: Partial<MusicianState> = raw ? JSON.parse(raw) : {};
    const result: MusicianState = { ...defaultMusicianSettings, ...parsed };
    if ((parsed as { musicianSyncMode?: string }).musicianSyncMode === 'midi-ws') {
      result.musicianSyncMode = 'midi';
    }
    return result;
  } catch (e) {
    console.error('Failed to load musician settings', e);
    return { ...defaultMusicianSettings };
  }
};

const readInitialMusicianSettings = (): MusicianState => {
  try {
    return readStoredMusicianSettings(localStorage.getItem(MUSICIAN_SETTINGS_KEY));
  } catch {
    // Storage blocked altogether.
    return { ...defaultMusicianSettings };
  }
};

export const musicianSlice = createSlice({
  name: 'musician',
  initialState: readInitialMusicianSettings(),
  reducers: {
    updateMusicianSetting: (state, action: PayloadAction<{ key: keyof MusicianState; value: MusicianState[keyof MusicianState] }>) => {
      const { key, value } = action.payload;
      (state as any)[key] = value;
      persistState(MUSICIAN_SETTINGS_KEY, state);
    },
    /** Take over what another window stored. Not persisted: it already is (see storageSync). */
    hydrateMusicianSettings: (_state, action: PayloadAction<MusicianState>) => action.payload,
  },
});

export const useGetMusicianSettings = () => useAppSelector((state) => state.musician);
export const useUpdateMusicianSetting = () => {
  const dispatch = useAppDispatch();
  return useCallback(
    <K extends keyof MusicianState>(key: K, value: MusicianState[K]) => {
      dispatch(musicianSlice.actions.updateMusicianSetting({ key, value }));
    },
    [dispatch],
  );
};

export default musicianSlice.reducer;
