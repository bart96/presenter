import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { useAppSelector, useAppDispatch } from './hooks';
import { useCallback, useMemo } from 'react';
import { persistState } from './persist';

export const WINDOWS_KEY = 'presenter_windows';

export interface WindowConfig {
  name?: string;
  top?: number;
  left?: number;
  positionX?: number;
  positionY?: number;
  width?: number;
  height?: number;
  displayMode?: 'normal' | 'stream';
  languages?: string[];
  streamLines?: number;
  fullscreen?: boolean;
  frameless?: boolean;
  alwaysOnTop?: boolean;
  transparent?: boolean;
  hideMouse?: boolean;
  hideText?: boolean;
  hideBackground?: boolean;
  /** Optional preset (style entity id) applied to this window only. */
  styleId?: number;
  /** Stage-monitor layers this window subscribes to (stage_layers ids). */
  stageLayerIds?: number[];
}

export interface SavedWindowConfig extends WindowConfig {
  /**
   * Stable identity of the *configuration*, not of the open window. Survives closing, so a
   * rig ("Beamer", "Stage", "Stream") can be set up once and opened per service.
   */
  id: string;
  /** Runtime handle while the window is actually open; cleared on close. */
  _runtimeId?: string;
}

export interface WindowState {
  windowConfigs: SavedWindowConfig[];
  windowPresets: Record<string, object>;
}

const defaultState: WindowState = {
  windowConfigs: [],
  windowPresets: {},
};

/** Ids only have to be unique within this browser profile; `randomUUID` needs a secure context. */
export const newWindowConfigId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `win-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Bring stored configs up to the current shape.
 *
 * Configs written before windows had a stable identity are keyed only by `_runtimeId`, a
 * handle that dies with the process — so they are given an `id` here. Nothing is dropped:
 * under the old rules closing a window deleted its config, so every stored entry is one
 * the operator still wanted.
 *
 * `_runtimeId` is deliberately NOT preserved. It names a window in a process that has
 * since exited; keeping it would make a config look open when it is not.
 */
const migrateConfigs = (raw: unknown): SavedWindowConfig[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map((cfg) => {
      const { _runtimeId, id, ...rest } = cfg;
      // `_runtimeId` names a window in a process that has since exited, so it is dropped
      // rather than carried over — keeping it would make a config look open when it is not.
      void _runtimeId;
      return { ...(rest as WindowConfig), id: typeof id === 'string' && id ? id : newWindowConfigId() };
    });
};

let initialState: WindowState = defaultState;
try {
  const windows = localStorage.getItem(WINDOWS_KEY);
  if (windows) {
    const parsed = JSON.parse(windows);
    initialState = {
      ...defaultState,
      ...parsed,
      windowConfigs: migrateConfigs(parsed?.windowConfigs),
    };
  }
} catch (e) {
  console.error('Failed to load windows from localStorage', e);
}

export const windowSlice = createSlice({
  name: 'window',
  initialState,
  reducers: {
    updateWindowSetting: (state, action: PayloadAction<{ key: keyof WindowState; value: unknown }>) => {
      const { key, value } = action.payload;
      (state as any)[key] = value;
      persistState(WINDOWS_KEY, state);
    },

    /**
     * Create or patch one window config by its stable id. Replaces the hand-rolled
     * find-index-splice-persist dance that each call site used to repeat.
     */
    upsertWindowConfig: (state, action: PayloadAction<{ id: string } & Partial<SavedWindowConfig>>) => {
      const { id, ...patch } = action.payload;
      const idx = state.windowConfigs.findIndex((c) => c.id === id);
      if (idx >= 0) {
        state.windowConfigs[idx] = { ...state.windowConfigs[idx], ...patch, id };
      } else {
        state.windowConfigs.push({ ...patch, id });
      }
      persistState(WINDOWS_KEY, state);
    },

    /** Forget a window entirely. Closing one does NOT go through here. */
    removeWindowConfig: (state, action: PayloadAction<string>) => {
      state.windowConfigs = state.windowConfigs.filter((c) => c.id !== action.payload);
      persistState(WINDOWS_KEY, state);
    },

    /**
     * Attach or detach the runtime handle. `runtimeId: null` is what closing a window does
     * — the configuration stays, it is simply not open any more.
     */
    setWindowRuntimeId: (state, action: PayloadAction<{ id: string; runtimeId: string | null }>) => {
      const cfg = state.windowConfigs.find((c) => c.id === action.payload.id);
      if (!cfg) return;
      if (action.payload.runtimeId) cfg._runtimeId = action.payload.runtimeId;
      else delete cfg._runtimeId;
      persistState(WINDOWS_KEY, state);
    },

    /** Clear every runtime handle — used when all windows are closed at once. */
    clearWindowRuntimeIds: (state) => {
      for (const cfg of state.windowConfigs) delete cfg._runtimeId;
      persistState(WINDOWS_KEY, state);
    },

    /** Persist a drag-reordered chip order. */
    reorderWindowConfigs: (state, action: PayloadAction<string[]>) => {
      const byId = new Map(state.windowConfigs.map((c) => [c.id, c]));
      const ordered = action.payload.map((id) => byId.get(id)).filter((c): c is SavedWindowConfig => !!c);
      // Anything the caller did not mention keeps its relative position at the end, so a
      // stale id list can never drop a window.
      const mentioned = new Set(action.payload);
      state.windowConfigs = [...ordered, ...state.windowConfigs.filter((c) => !mentioned.has(c.id))];
      persistState(WINDOWS_KEY, state);
    },
  },
});

export const { upsertWindowConfig, removeWindowConfig, setWindowRuntimeId, clearWindowRuntimeIds, reorderWindowConfigs } =
  windowSlice.actions;

export const useGetWindows = () => useAppSelector((state) => state.window);

/** The configured windows, in operator order. */
export const useWindowConfigs = (): SavedWindowConfig[] => useAppSelector((state) => state.window.windowConfigs);

/** Look up a config by the runtime handle a bridge/IPC callback hands back. */
export const configIdForRuntimeId = (configs: SavedWindowConfig[], runtimeId: string): string | undefined =>
  configs.find((c) => c._runtimeId === runtimeId)?.id;

export const useUpdateWindows = () => {
  const dispatch = useAppDispatch();
  return useCallback(
    <K extends keyof WindowState>(key: K, value: WindowState[K]) => {
      dispatch(windowSlice.actions.updateWindowSetting({ key, value }));
    },
    [dispatch],
  );
};

/** The id-keyed actions, bound to dispatch — what new code should reach for. */
export const useWindowActions = () => {
  const dispatch = useAppDispatch();
  return useMemo(
    () => ({
      upsert: (patch: { id: string } & Partial<SavedWindowConfig>) => dispatch(upsertWindowConfig(patch)),
      remove: (id: string) => dispatch(removeWindowConfig(id)),
      setRuntimeId: (id: string, runtimeId: string | null) => dispatch(setWindowRuntimeId({ id, runtimeId })),
      clearRuntimeIds: () => dispatch(clearWindowRuntimeIds()),
      reorder: (ids: string[]) => dispatch(reorderWindowConfigs(ids)),
    }),
    [dispatch],
  );
};

export default windowSlice.reducer;
