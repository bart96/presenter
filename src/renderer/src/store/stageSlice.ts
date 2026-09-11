import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { useAppSelector } from './hooks';

/**
 * Where each stage layer currently *is* — which cue is up, when it started, whether it is
 * paused or hidden.
 *
 * Deliberately **not persisted**. The layers and their cues live in the database; this is
 * the transport position, and a countdown that survived a restart and came back showing a
 * stale number would be worse than one that simply is not running.
 *
 * `at` timestamps are passed in by the caller rather than read from `Date.now()` in the
 * reducer: the same instant then drives the state change, the broadcast and the windows'
 * own arithmetic, so nothing drifts by a reducer's worth of milliseconds.
 */

export interface StageLayerRuntime {
  /**
   * Index into the layer's cue list. Equal to the list length means the sequence has run
   * out — the layer shows nothing, and Back steps into the last cue again.
   */
  cueIndex: number;
  /** When the current cue started, epoch ms. Shifted forward on resume to absorb the pause. */
  startedAt: number;
  /** Set while paused; the display holds at the value it had at this instant. */
  pausedAt?: number;
  hidden: boolean;
}

export interface StageState {
  layers: Record<number, StageLayerRuntime>;
  /** One switch that blanks every stage overlay, without disturbing per-layer state. */
  allHidden: boolean;
}

const initialState: StageState = { layers: {}, allHidden: false };

const ensure = (state: StageState, layerId: number, at: number): StageLayerRuntime => {
  let runtime = state.layers[layerId];
  if (!runtime) {
    runtime = { cueIndex: 0, startedAt: at, hidden: false };
    state.layers[layerId] = runtime;
  }
  return runtime;
};

/** Move to a cue and (re)start its clock. */
const enter = (runtime: StageLayerRuntime, cueIndex: number, at: number): void => {
  runtime.cueIndex = Math.max(0, cueIndex);
  runtime.startedAt = at;
  delete runtime.pausedAt;
};

export const stageSlice = createSlice({
  name: 'stage',
  initialState,
  reducers: {
    /** Start (or restart) the layer at its first cue. What a show-item trigger fires. */
    stageStart: (state, action: PayloadAction<{ layerId: number; at: number }>) => {
      const { layerId, at } = action.payload;
      const runtime = ensure(state, layerId, at);
      enter(runtime, 0, at);
      runtime.hidden = false;
    },

    /**
     * Advance one cue. `cueCount` bounds it: stepping off the end parks the layer one past
     * the last cue, which renders as nothing — the natural "sequence finished" state.
     */
    stageGo: (state, action: PayloadAction<{ layerId: number; cueCount: number; at: number }>) => {
      const { layerId, cueCount, at } = action.payload;
      const runtime = ensure(state, layerId, at);
      enter(runtime, Math.min(runtime.cueIndex + 1, cueCount), at);
    },

    stageBack: (state, action: PayloadAction<{ layerId: number; at: number }>) => {
      const { layerId, at } = action.payload;
      const runtime = ensure(state, layerId, at);
      enter(runtime, Math.max(0, runtime.cueIndex - 1), at);
    },

    /** Jump straight to a cue — used by the cue list and by targeted triggers. */
    stageSetCue: (state, action: PayloadAction<{ layerId: number; cueIndex: number; at: number }>) => {
      const { layerId, cueIndex, at } = action.payload;
      enter(ensure(state, layerId, at), cueIndex, at);
    },

    /** Restart the current cue from the top. */
    stageReset: (state, action: PayloadAction<{ layerId: number; at: number }>) => {
      const { layerId, at } = action.payload;
      const runtime = ensure(state, layerId, at);
      enter(runtime, runtime.cueIndex, at);
    },

    /** Back to the beginning of the sequence. */
    stageResetAll: (state, action: PayloadAction<{ layerId: number; at: number }>) => {
      const { layerId, at } = action.payload;
      enter(ensure(state, layerId, at), 0, at);
    },

    stagePause: (state, action: PayloadAction<{ layerId: number; at: number }>) => {
      const runtime = ensure(state, action.payload.layerId, action.payload.at);
      if (runtime.pausedAt === undefined) runtime.pausedAt = action.payload.at;
    },

    /**
     * Resume by moving the start forward by however long the pause lasted, so the elapsed
     * time picks up exactly where it stopped rather than jumping by the pause duration.
     */
    stageResume: (state, action: PayloadAction<{ layerId: number; at: number }>) => {
      const runtime = ensure(state, action.payload.layerId, action.payload.at);
      if (runtime.pausedAt === undefined) return;
      runtime.startedAt += action.payload.at - runtime.pausedAt;
      delete runtime.pausedAt;
    },

    stageTogglePause: (state, action: PayloadAction<{ layerId: number; at: number }>) => {
      const { layerId, at } = action.payload;
      const runtime = ensure(state, layerId, at);
      if (runtime.pausedAt === undefined) {
        runtime.pausedAt = at;
      } else {
        runtime.startedAt += at - runtime.pausedAt;
        delete runtime.pausedAt;
      }
    },

    stageSetHidden: (state, action: PayloadAction<{ layerId: number; hidden: boolean; at: number }>) => {
      ensure(state, action.payload.layerId, action.payload.at).hidden = action.payload.hidden;
    },

    stageToggleHidden: (state, action: PayloadAction<{ layerId: number; at: number }>) => {
      const runtime = ensure(state, action.payload.layerId, action.payload.at);
      runtime.hidden = !runtime.hidden;
    },

    setStageAllHidden: (state, action: PayloadAction<boolean>) => {
      state.allHidden = action.payload;
    },

    toggleStageAllHidden: (state) => {
      state.allHidden = !state.allHidden;
    },

    /** Drop runtime for layers that no longer exist, so the map cannot grow forever. */
    pruneStageLayers: (state, action: PayloadAction<number[]>) => {
      const alive = new Set(action.payload);
      for (const key of Object.keys(state.layers)) {
        if (!alive.has(Number(key))) delete state.layers[Number(key)];
      }
    },
  },
});

export const {
  stageStart,
  stageGo,
  stageBack,
  stageSetCue,
  stageReset,
  stageResetAll,
  stagePause,
  stageResume,
  stageTogglePause,
  stageSetHidden,
  stageToggleHidden,
  setStageAllHidden,
  toggleStageAllHidden,
  pruneStageLayers,
} = stageSlice.actions;

export const useGetStageState = () => useAppSelector((state) => state.stage);

export default stageSlice.reducer;
