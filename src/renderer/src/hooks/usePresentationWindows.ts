/**
 * One view of the presentation windows, shared by the footer and the Window Manager.
 *
 * A window exists in three places at once: the saved configuration (Redux/localStorage,
 * the only part that survives a restart), the bridge registry (which windows this renderer
 * has open), and the main process (hidden / fullscreen / live bounds). Both UIs used to
 * merge those three by hand, each with its own 1-second poll, and each with a slightly
 * different idea of what counted as a window.
 *
 * Here the merge happens once. The poll is a module-level singleton with a subscriber
 * count, so N mounted consumers cost one cycle rather than N.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { type SavedWindowConfig, type WindowConfig, newWindowConfigId, useWindowActions, useWindowConfigs } from '@/store/windowSlice';
import { useGetPresentationSettings } from '@/store/presentationSlice';
import {
  adoptElectronWindow,
  closePresentationWindow,
  getOpenWindows,
  getOpenWindowsSync,
  listScreens,
  openPresentationWindow,
  updateWindowConfigInBridge,
} from '@/utils/presentationBridge';
import { screenIdForBounds, type ScreenInfo } from '@/components/layout/ScreenPicker';

export type WindowBounds = { x: number; y: number; width: number; height: number };

type LiveState = { hidden?: boolean; fullscreen?: boolean; bounds?: WindowBounds };

interface RuntimeSnapshot {
  /** Windows this renderer currently has open, by runtime id. */
  openIds: Set<string>;
  /** Config as the bridge knows it, for windows opened outside the saved rig. */
  openConfigs: Map<string, WindowConfig>;
  states: Record<string, LiveState>;
  screens: ScreenInfo[];
}

const EMPTY_SNAPSHOT: RuntimeSnapshot = {
  openIds: new Set(),
  openConfigs: new Map(),
  states: {},
  screens: [],
};

// ── Module-level poller ───────────────────────────────────────────────────────

let snapshot: RuntimeSnapshot = EMPTY_SNAPSHOT;
const listeners = new Set<() => void>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let cycle = 0;
/** Serialized form of the last snapshot — so an unchanged poll does not re-render anyone. */
let lastSignature = '';

const POLL_INTERVAL_MS = 1000;
/** Displays change rarely; re-reading them every second is pure IPC for nothing. */
const SCREEN_REFRESH_EVERY = 10;

const emit = () => {
  for (const l of listeners) l();
};

const signatureOf = (s: RuntimeSnapshot): string =>
  JSON.stringify([[...s.openIds].sort(), s.states, s.screens.map((sc) => [sc.id, sc.bounds, sc.label, sc.isPrimary])]);

const poll = async (): Promise<void> => {
  if (inFlight) return;
  inFlight = true;
  try {
    let open: Array<{ id: string; config: WindowConfig; closed: boolean }>;
    try {
      open = await getOpenWindows();
    } catch {
      open = getOpenWindowsSync();
    }

    const states: Record<string, LiveState> = {};
    if (window.api?.getWindowStates) {
      try {
        const live = await window.api.getWindowStates();
        for (const s of live as Array<{ id: string } & LiveState>) {
          states[s.id] = { hidden: s.hidden, fullscreen: s.fullscreen, bounds: s.bounds };
        }
      } catch {
        /* main process not reachable — fall back to bridge-only knowledge */
      }
    }

    let screens = snapshot.screens;
    if (cycle % SCREEN_REFRESH_EVERY === 0 || screens.length === 0) {
      try {
        screens = await listScreens();
      } catch {
        /* keep the previous list */
      }
    }
    cycle++;

    const next: RuntimeSnapshot = {
      openIds: new Set(open.filter((w) => !w.closed).map((w) => w.id)),
      openConfigs: new Map(open.filter((w) => !w.closed).map((w) => [w.id, w.config])),
      states,
      screens,
    };

    const sig = signatureOf(next);
    if (sig === lastSignature) return;
    lastSignature = sig;
    snapshot = next;
    emit();
  } finally {
    inFlight = false;
  }
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  if (!pollTimer) {
    pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    void poll();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };
};

/** Force a refresh now, for right after an action the poll would otherwise take a second to notice. */
export const refreshWindowRuntime = (): void => {
  void poll();
};

// ── Hook ──────────────────────────────────────────────────────────────────────

/** A configured window, merged with whatever the runtime knows about it. */
export interface RigWindow {
  /** Stable config id — the thing to key React lists and actions on. */
  id: string;
  config: SavedWindowConfig;
  name: string;
  /** Runtime handle, only while open. */
  runtimeId?: string;
  isOpen: boolean;
  hidden: boolean;
  frozen: boolean;
  bounds?: WindowBounds;
  screen?: ScreenInfo;
  /**
   * A live window with no saved configuration — opened directly over IPC, or left behind by
   * a renderer reload. Shown so it can be controlled, but it has nothing to persist to.
   */
  unmanaged: boolean;
}

export interface PresentationWindows {
  windows: RigWindow[];
  screens: ScreenInfo[];
  openCount: number;
  closedCount: number;
  create: (config: WindowConfig) => Promise<string>;
  open: (id: string) => Promise<void>;
  close: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  openAll: () => Promise<void>;
  closeAll: () => Promise<void>;
  update: (id: string, patch: Partial<WindowConfig>) => Promise<void>;
  setHidden: (id: string, hidden: boolean) => Promise<void>;
  adopt: (runtimeId: string, config: SavedWindowConfig) => void;
}

export const usePresentationWindows = (): PresentationWindows => {
  const configs = useWindowConfigs();
  const actions = useWindowActions();
  const { frozenWindows } = useGetPresentationSettings();
  const runtime = useSyncExternalStore(subscribe, () => snapshot);

  /** Latest configs without making every callback depend on the array identity. */
  const configsRef = useRef(configs);
  configsRef.current = configs;

  const windows = useMemo<RigWindow[]>(() => {
    const entries: RigWindow[] = configs.map((cfg) => {
      const runtimeId = cfg._runtimeId && runtime.openIds.has(cfg._runtimeId) ? cfg._runtimeId : undefined;
      const state = runtimeId ? runtime.states[runtimeId] : undefined;
      const bounds = state?.bounds;
      return {
        id: cfg.id,
        config: cfg,
        name: cfg.name || 'Window',
        runtimeId,
        isOpen: !!runtimeId,
        hidden: !!state?.hidden,
        frozen: frozenWindows.includes(cfg.name || 'Window'),
        bounds,
        screen: runtime.screens.find((s) => s.id === screenIdForBounds(bounds, runtime.screens)),
        unmanaged: false,
      };
    });

    // Live windows nobody has a config for. Without this they would be invisible to the
    // operator yet still projecting.
    const claimed = new Set(entries.map((e) => e.runtimeId).filter(Boolean));
    for (const [runtimeId, config] of runtime.openConfigs) {
      if (claimed.has(runtimeId)) continue;
      const bounds = runtime.states[runtimeId]?.bounds;
      entries.push({
        id: `unmanaged:${runtimeId}`,
        config: { ...config, id: `unmanaged:${runtimeId}` },
        name: config.name || 'Window',
        runtimeId,
        isOpen: true,
        hidden: !!runtime.states[runtimeId]?.hidden,
        frozen: frozenWindows.includes(config.name || 'Window'),
        bounds,
        screen: runtime.screens.find((s) => s.id === screenIdForBounds(bounds, runtime.screens)),
        unmanaged: true,
      });
    }

    return entries;
  }, [configs, runtime, frozenWindows]);

  const findConfig = useCallback((id: string) => configsRef.current.find((c) => c.id === id), []);

  const create = useCallback(
    async (config: WindowConfig): Promise<string> => {
      const id = newWindowConfigId();
      const runtimeId = await openPresentationWindow(config);
      actions.upsert({ ...config, id, _runtimeId: runtimeId });
      refreshWindowRuntime();
      return id;
    },
    [actions],
  );

  const open = useCallback(
    async (id: string): Promise<void> => {
      const cfg = findConfig(id);
      if (!cfg || cfg._runtimeId) return;
      try {
        const runtimeId = await openPresentationWindow(cfg);
        actions.setRuntimeId(id, runtimeId);
        refreshWindowRuntime();
      } catch (e) {
        console.error('Failed to open window:', e);
      }
    },
    [actions, findConfig],
  );

  /** Closing is not forgetting: the configuration stays so the window can be reopened. */
  const close = useCallback(
    async (id: string): Promise<void> => {
      const cfg = findConfig(id);
      if (cfg?._runtimeId) await closePresentationWindow(cfg._runtimeId);
      else if (id.startsWith('unmanaged:')) await closePresentationWindow(id.slice('unmanaged:'.length));
      if (cfg) actions.setRuntimeId(id, null);
      refreshWindowRuntime();
    },
    [actions, findConfig],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      await close(id);
      actions.remove(id);
    },
    [actions, close],
  );

  const openAll = useCallback(async (): Promise<void> => {
    for (const cfg of configsRef.current) {
      if (!cfg._runtimeId) await open(cfg.id);
    }
  }, [open]);

  const closeAll = useCallback(async (): Promise<void> => {
    for (const cfg of configsRef.current) {
      if (cfg._runtimeId) await closePresentationWindow(cfg._runtimeId);
    }
    // Anything still open belongs to no config — close it too, so "Close all" means it.
    for (const runtimeId of snapshot.openIds) {
      await closePresentationWindow(runtimeId);
    }
    actions.clearRuntimeIds();
    refreshWindowRuntime();
  }, [actions]);

  /**
   * Apply a config change everywhere it has to land: the main process (which owns the
   * BrowserWindow), the bridge registry (which resolves the per-window style on the next
   * broadcast), and the saved config (which is what survives a restart). Missing any one
   * of the three is why edits used to appear to do nothing until a reopen.
   */
  const update = useCallback(
    async (id: string, patch: Partial<WindowConfig>): Promise<void> => {
      const cfg = findConfig(id);
      const runtimeId = cfg?._runtimeId ?? (id.startsWith('unmanaged:') ? id.slice('unmanaged:'.length) : undefined);
      if (runtimeId && window.api?.updateWindowConfig) {
        try {
          await window.api.updateWindowConfig(runtimeId, patch as never);
        } catch (e) {
          console.error('Failed to update window config:', e);
        }
      }
      if (runtimeId) updateWindowConfigInBridge(runtimeId, patch);
      if (cfg) actions.upsert({ id, ...patch });
      refreshWindowRuntime();
    },
    [actions, findConfig],
  );

  const setHidden = useCallback(
    async (id: string, hidden: boolean): Promise<void> => {
      const cfg = findConfig(id);
      const runtimeId = cfg?._runtimeId ?? (id.startsWith('unmanaged:') ? id.slice('unmanaged:'.length) : undefined);
      if (!runtimeId) return;
      const fn = hidden ? window.api?.hidePresentationWindow : window.api?.showPresentationWindow;
      if (fn) await fn(runtimeId);
      refreshWindowRuntime();
    },
    [findConfig],
  );

  const adopt = useCallback(
    (runtimeId: string, config: SavedWindowConfig) => {
      adoptElectronWindow(runtimeId, config);
      actions.setRuntimeId(config.id, runtimeId);
      refreshWindowRuntime();
    },
    [actions],
  );

  // Fullscreen can be changed from the window itself (F11, the OS). Mirror it back so the
  // saved config does not disagree with what is on screen.
  useEffect(() => {
    for (const w of windows) {
      if (!w.runtimeId || w.unmanaged) continue;
      const live = runtime.states[w.runtimeId]?.fullscreen;
      if (live !== undefined && live !== w.config.fullscreen) {
        actions.upsert({ id: w.id, fullscreen: live });
      }
    }
  }, [windows, runtime.states, actions]);

  return {
    windows,
    screens: runtime.screens,
    openCount: windows.filter((w) => w.isOpen).length,
    closedCount: windows.filter((w) => !w.isOpen).length,
    create,
    open,
    close,
    remove,
    openAll,
    closeAll,
    update,
    setHidden,
    adopt,
  };
};
