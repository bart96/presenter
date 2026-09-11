import type { Dispatch } from '@reduxjs/toolkit';
import { SETTINGS_KEY, readStoredSettings, settingsSlice } from './settingsSlice';
import { MUSICIAN_SETTINGS_KEY, readStoredMusicianSettings, musicianSlice } from './musicianSlice';

/**
 * Keeps this window's copy of the settings in step with the app's other windows.
 *
 * Every page with a store — the main window, the musician window, a second browser tab —
 * reads the settings once when it loads and then writes its WHOLE copy back on each change.
 * A window that loaded earlier therefore puts its stale copy back the next time anything
 * changes there (the musician window does on every item change), silently reverting what
 * was set elsewhere in the meantime — which only shows after a restart. The `storage` event
 * fires in every other same-origin document when a key changes, so each window re-reads
 * the key, and its next write starts from the current values.
 *
 * Show state is deliberately left out: pushing one window's open show into another would
 * switch shows under the operator.
 */
export const startStorageSync = (dispatch: Dispatch): void => {
  window.addEventListener('storage', (event) => {
    try {
      if (event.storageArea !== localStorage) return;
    } catch {
      return; // storage blocked — nothing to sync
    }
    // `key` is null when another window cleared everything ("Log out and reset").
    const cleared = event.key === null;
    if (cleared || event.key === SETTINGS_KEY) {
      dispatch(settingsSlice.actions.hydrateSettings(readStoredSettings(cleared ? null : event.newValue)));
    }
    if (cleared || event.key === MUSICIAN_SETTINGS_KEY) {
      dispatch(musicianSlice.actions.hydrateMusicianSettings(readStoredMusicianSettings(cleared ? null : event.newValue)));
    }
  });
};
