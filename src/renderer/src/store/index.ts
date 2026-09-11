import { configureStore } from '@reduxjs/toolkit';
import { presenterApi } from '@/api/base.api';
import showReducer from './showSlice';
import settingsReducer from './settingsSlice';
import musicianReducer from './musicianSlice';
import windowReducer from './windowSlice';
import presentationReducer from './presentationSlice';
import songsReducer from './songsSlice';
import stageReducer from './stageSlice';
import audioMixerReducer from './audioMixerSlice';
import { startStorageSync } from './storageSync';

export type { MusicianState } from './musicianSlice';
export type { PresentationState } from './presentationSlice';
export type { SettingsState } from './settingsSlice';
export type { ShowState } from './showSlice';
export type { SongsState } from './songsSlice';
export type { StageState } from './stageSlice';
export type { WindowState } from './windowSlice';

export { useAppDispatch, useAppSelector } from './hooks';

export const store = configureStore({
  reducer: {
    [presenterApi.reducerPath]: presenterApi.reducer,
    show: showReducer,
    settings: settingsReducer,
    musician: musicianReducer,
    window: windowReducer,
    presentation: presentationReducer,
    songs: songsReducer,
    stage: stageReducer,
    audioMixer: audioMixerReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredPaths: ['songs.songs'],
        ignoredActions: ['songs/setSongs', 'songs/addSongToStore', 'songs/updateSongInStore', 'songs/loadShowSongs/fulfilled'],
      },
    }).concat(presenterApi.middleware),
});

// Other windows of the app write the same settings keys — re-read them when they do.
startStorageSync(store.dispatch);

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
