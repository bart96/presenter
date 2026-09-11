/**
 * The stage monitor's brain, on the operator side.
 *
 * It owns three things:
 *
 * 1. **Resolution** — layers (from the database) × runtime position (from the store) into
 *    the wire payload, pushed to the windows whenever either changes.
 * 2. **Auto-advance** — one timer, armed for whichever cue is due to hand over next. Not
 *    one per layer per second: the windows do their own arithmetic, so the only thing that
 *    has to happen on a schedule here is the handover itself.
 * 3. **Show-item triggers** — firing a layer when the item it is attached to goes live.
 *
 * What it deliberately does NOT do is tick. A running countdown produces no traffic at all
 * between the moment it starts and the moment it changes.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAppDispatch } from '@/store';
import { useGetStageLayersQuery } from '@/api/stage.api';
import { useGetSettings } from '@/store/settingsSlice';
import { useGetShow } from '@/store/showSlice';
import { useGetPresentationSettings } from '@/store/presentationSlice';
import { pruneStageLayers, stageGo, stageSetCue, stageSetHidden, stageStart, useGetStageState } from '@/store/stageSlice';
import { broadcastStage } from '@/utils/presentationBridge';
import { cueEndsAt, resolveStagePayload, type StageCueRuntime, type StageLayerEntity } from '@/stage/types';
import type { StageTrigger } from '@/api/shows.api';

/** How the engine reports a layer to the transport UI in the footer and the stage panel. */
export interface StageLayerStatus {
  layer: StageLayerEntity;
  cueIndex: number;
  cueCount: number;
  /** The cue currently up, or undefined when the sequence has run out. */
  cue?: StageLayerEntity['data']['cues'][number];
  startedAt: number;
  /** Set while paused — the instant the display is holding at. */
  pausedAt?: number;
  paused: boolean;
  hidden: boolean;
  /** True once the layer has been stepped past its last cue. */
  finished: boolean;
}

export interface StageEngine {
  layers: StageLayerEntity[];
  statuses: StageLayerStatus[];
  /** Whether anything is actually on a screen right now — drives the footer's presence. */
  anyLive: boolean;
  allHidden: boolean;
}

/**
 * Read-only view of where every layer currently is.
 *
 * This is what UI reaches for. It runs no timers and sends nothing, so any number of
 * components can call it — unlike `useStageEngine`, of which there must be exactly one.
 */
export const useStageStatus = (): StageEngine => {
  const { data: layers = [] } = useGetStageLayersQuery();
  const stage = useGetStageState();
  const { uiLanguage } = useGetSettings();

  const statuses = useStageStatuses(layers, stage.layers);

  const anyLive = useMemo(
    () => resolveStagePayload(layers, stage.layers, stage.allHidden, uiLanguage || 'en').layers.length > 0,
    [layers, stage.layers, stage.allHidden, uiLanguage],
  );

  return { layers, statuses, anyLive, allHidden: stage.allHidden };
};

/** Shared derivation, so the engine and the read-only view cannot describe a layer differently. */
const useStageStatuses = (layers: StageLayerEntity[], runtimes: Record<number, StageCueRuntime>): StageLayerStatus[] =>
  useMemo(
    () =>
      layers.map((layer) => {
        const runtime = runtimes[layer.id];
        const cueIndex = runtime?.cueIndex ?? 0;
        return {
          layer,
          cueIndex,
          cueCount: layer.data.cues.length,
          cue: layer.data.cues[cueIndex],
          startedAt: runtime?.startedAt ?? 0,
          pausedAt: runtime?.pausedAt,
          paused: runtime?.pausedAt !== undefined,
          hidden: runtime?.hidden ?? false,
          finished: layer.data.cues.length > 0 && cueIndex >= layer.data.cues.length,
        };
      }),
    [layers, runtimes],
  );

/**
 * The engine proper — timers, broadcasting and triggers.
 *
 * **Mount exactly once** (`StageEngineHost`). A second instance would arm the same
 * auto-advance timer and dispatch the same handover twice, stepping a layer two cues on
 * instead of one.
 */
export const useStageEngine = (): StageEngine => {
  const dispatch = useAppDispatch();
  const { data: layers = [] } = useGetStageLayersQuery();
  const stage = useGetStageState();
  const { uiLanguage } = useGetSettings();
  const { currentShow } = useGetShow();
  const { activeItemIndex } = useGetPresentationSettings();

  const locale = uiLanguage || 'en';

  // ── Resolve and push ────────────────────────────────────────────────────────

  const payload = useMemo(
    () => resolveStagePayload(layers, stage.layers, stage.allHidden, locale),
    [layers, stage.layers, stage.allHidden, locale],
  );

  /**
   * Serialized payload as the dep, not the object. `resolveStagePayload` builds a fresh
   * object every time the store touches anything, and an identical payload must not
   * produce another broadcast — the per-window dedupe would swallow it, but the work of
   * getting there is exactly what this channel exists to avoid.
   */
  const payloadKey = useMemo(() => {
    try {
      return JSON.stringify(payload);
    } catch {
      return String(Date.now());
    }
  }, [payload]);

  useEffect(() => {
    void broadcastStage(payload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payloadKey]);

  // A window whose renderer just (re)mounted was told nothing about the stage — the bridge
  // replays it, but only the operator knows the current payload, so re-push here too.
  useEffect(() => {
    const cleanup = window.api?.onPresentationWindowReady?.(() => {
      void broadcastStage(payloadRef.current);
    });
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, []);
  const payloadRef = useRef(payload);
  payloadRef.current = payload;

  // ── Auto-advance ────────────────────────────────────────────────────────────

  const layersRef = useRef(layers);
  layersRef.current = layers;
  const runtimeRef = useRef(stage.layers);
  runtimeRef.current = stage.layers;

  /**
   * The soonest handover across every running layer, and one timer for it.
   *
   * A single timer rather than one per layer keeps this to a single wake-up no matter how
   * many layers are running, and re-deriving it whenever anything changes means a pause, a
   * skip or an edit re-arms it correctly without any bookkeeping.
   */
  const dueList = useMemo(() => {
    const due: Array<{ layerId: number; at: number; cueCount: number }> = [];
    for (const layer of layers) {
      if (!layer.enabled) continue;
      const runtime = stage.layers[layer.id];
      // A paused cue is not counting down, so it is not due for anything.
      if (!runtime || runtime.pausedAt !== undefined) continue;
      const cue = layer.data.cues[runtime.cueIndex];
      if (!cue) continue;
      const at = cueEndsAt(cue, runtime.startedAt);
      if (at !== null) due.push({ layerId: layer.id, at, cueCount: layer.data.cues.length });
    }
    return due;
  }, [layers, stage.layers]);

  const nextDue = useMemo(() => (dueList.length ? dueList.reduce((a, b) => (b.at < a.at ? b : a)) : null), [dueList]);

  useEffect(() => {
    if (!nextDue) return;

    const fire = () => {
      const now = Date.now();
      // Everything that has come due by now, not just the one that armed the timer — a
      // sleeping laptop can wake with several handovers already overdue.
      for (const item of dueList) {
        if (item.at > now) continue;
        const layer = layersRef.current.find((l) => l.id === item.layerId);
        const runtime = runtimeRef.current[item.layerId];
        if (!layer || !runtime) continue;
        const cue = layer.data.cues[runtime.cueIndex];
        if (!cue) continue;

        if (cue.kind === 'countdown' && cue.onZero === 'hide') {
          dispatch(stageSetHidden({ layerId: item.layerId, hidden: true, at: now }));
        } else {
          // The new cue starts at the instant the old one was *due*, not at the instant the
          // timer happened to fire — otherwise a chain of countdowns drifts later by a few
          // milliseconds at every handover.
          dispatch(stageGo({ layerId: item.layerId, cueCount: item.cueCount, at: item.at }));
        }
      }
    };

    const delay = Math.max(0, nextDue.at - Date.now());
    const timer = setTimeout(fire, delay);
    return () => clearTimeout(timer);
  }, [nextDue, dueList, dispatch]);

  // ── Show-item triggers ──────────────────────────────────────────────────────

  const triggersFor = useCallback((index: number): StageTrigger[] => currentShow?.order?.[index]?.stageTriggers ?? [], [currentShow]);

  /**
   * Which item the triggers last ran for.
   *
   * Seeded with the item that is active when a show loads, so loading a show does *not*
   * fire its triggers — otherwise opening the service would start every countdown in it at
   * once. Triggers fire on moving *into* an item, which is what an operator means by
   * "when this item goes live".
   */
  const lastTriggeredItem = useRef<number | null>(null);
  const showTitle = currentShow?.title;
  useEffect(() => {
    lastTriggeredItem.current = null;
  }, [showTitle]);

  useEffect(() => {
    if (lastTriggeredItem.current === activeItemIndex) return;
    const isFirstObservation = lastTriggeredItem.current === null;
    lastTriggeredItem.current = activeItemIndex;
    if (isFirstObservation) return;

    const now = Date.now();
    for (const trigger of triggersFor(activeItemIndex)) {
      const layer = layersRef.current.find((l) => l.id === trigger.layerId);
      if (!layer || !layer.enabled) continue;

      switch (trigger.action) {
        case 'start': {
          // A trigger naming a specific cue jumps there; otherwise the layer runs from the top.
          const cueIndex = trigger.cueId ? layer.data.cues.findIndex((c) => c.id === trigger.cueId) : 0;
          if (cueIndex > 0) {
            dispatch(stageSetCue({ layerId: layer.id, cueIndex, at: now }));
            dispatch(stageSetHidden({ layerId: layer.id, hidden: false, at: now }));
          } else {
            dispatch(stageStart({ layerId: layer.id, at: now }));
          }
          break;
        }
        case 'next':
          dispatch(stageGo({ layerId: layer.id, cueCount: layer.data.cues.length, at: now }));
          break;
        case 'reset':
          dispatch(stageSetCue({ layerId: layer.id, cueIndex: 0, at: now }));
          break;
        case 'hide':
          dispatch(stageSetHidden({ layerId: layer.id, hidden: true, at: now }));
          break;
        case 'show':
          dispatch(stageSetHidden({ layerId: layer.id, hidden: false, at: now }));
          break;
      }
    }
  }, [activeItemIndex, triggersFor, dispatch]);

  // ── Housekeeping ────────────────────────────────────────────────────────────

  const layerIdKey = layers.map((l) => l.id).join(',');
  useEffect(() => {
    // A deleted layer would otherwise keep its runtime entry for the life of the session.
    dispatch(pruneStageLayers(layers.map((l) => l.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerIdKey, dispatch]);

  // ── Status for the UI ───────────────────────────────────────────────────────

  const statuses = useStageStatuses(layers, stage.layers);

  return {
    layers,
    statuses,
    anyLive: payload.layers.length > 0,
    allHidden: stage.allHidden,
  };
};
