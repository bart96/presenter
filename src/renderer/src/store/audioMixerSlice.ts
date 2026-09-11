import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { useAppSelector } from './hooks';
import type { MixerCapabilities, MixerInfo, MixerLink } from '@/audio/protocol';

/**
 * What the operator's link to the audio bridge is doing, for the parts of the app that
 * need to *show* it — the settings panel's status line and its bus picker.
 *
 * Deliberately a summary, not a mirror. The live document (48 strips, every send, meters
 * at 10 Hz) lives in a ref inside `useAudioMixerHost` and never enters Redux: pushing a
 * meter frame through the store ten times a second would re-render the whole operator
 * window to animate a bar nobody is looking at. Only the handful of facts a settings
 * page renders are here, and only when one of them actually changes.
 */
export interface AudioMixerBus {
  id: string;
  name: string;
  kind: 'bus' | 'main';
}

export interface AudioMixerStatus {
  /** False whenever the feature is switched off — nothing else is then meaningful. */
  enabled: boolean;
  link: MixerLink;
  mixer?: MixerInfo;
  capabilities?: MixerCapabilities;
  /** Every mix the desk exposes, allow-list not applied — this is what you pick *from*. */
  mixes: AudioMixerBus[];
  /** Musicians currently holding the mixer open. */
  subscribers: number;
  /** Last error worth showing, e.g. a refused secret or an unknown schema. */
  error?: string;
}

const initialState: AudioMixerStatus = {
  enabled: false,
  link: 'offline',
  mixes: [],
  subscribers: 0,
};

export const audioMixerSlice = createSlice({
  name: 'audioMixer',
  initialState,
  reducers: {
    setAudioMixerStatus: (_state, action: PayloadAction<AudioMixerStatus>) => action.payload,
  },
});

export const { setAudioMixerStatus } = audioMixerSlice.actions;

export const useGetAudioMixerStatus = (): AudioMixerStatus => useAppSelector((state) => state.audioMixer);

export default audioMixerSlice.reducer;
