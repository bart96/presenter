import type { PresentationContent } from '@/presentation/types';
import type { LanguageStyleEntry } from '@/api/styles.api';
import { WindowConfig } from '@/store/windowSlice';
import { languagesForStyle } from '@/utils/languageSlots';
import { EMPTY_STAGE_PAYLOAD, type StageOverlayPayload } from '@/stage/types';

interface PresentationWindowEntry {
  id: string;
  config: WindowConfig;
  window: Window | null; // null when using Electron IPC
  closed: boolean;
  isElectron: boolean;
  /**
   * JSON snapshot of the LAST payload sent to this window. Used to short-circuit
   * the structured-clone cost of `ipcRenderer.send` when the active block/line
   * change hasn't actually altered what this particular window would render —
   * e.g. when a stream window only shows the current line so a *block* change
   * with the same first line produces an identical payload.
   *
   * This is the single biggest perf fix for the "controller lags during fast
   * key auto-repeat" issue in Electron — without it every key produces a fresh
   * structured-clone of the entire content for EVERY presentation window on
   * the controller's renderer thread, blocking paint.
   */
  lastSentSerialized?: string;
  /** Same idea for the stage overlay, which travels on its own channel. */
  lastSentStage?: string;
}

/** Registry of open presentation windows */
const openWindows: Map<string, PresentationWindowEntry> = new Map();
let windowCounter = 0;

/** Last broadcast content — sent to newly opened windows for initial display */
let lastBroadcastContent: PresentationContent | null = null;

/**
 * Module-level guard: the "restore saved windows on mount" logic in Footer
 * must run at most once per renderer process lifetime. A component-level ref
 * resets on every remount (HMR, route change, parent unmount) which previously
 * caused duplicate presentation BrowserWindows to be opened on top of the ones
 * that were already alive in the main process.
 */
let _hasRestoredSavedWindows = false;
export function getHasRestoredSavedWindows(): boolean {
  return _hasRestoredSavedWindows;
}
export function markRestoredSavedWindows(): void {
  _hasRestoredSavedWindows = true;
}

/**
 * Adopt an already-live Electron presentation window into the bridge registry
 * WITHOUT creating a new BrowserWindow.  Used during the restore-on-mount pass
 * so that BrowserWindows that survived a renderer reload are reused instead of
 * spawning duplicates.
 */
export function adoptElectronWindow(id: string, config: WindowConfig): void {
  if (openWindows.has(id)) return; // already tracked
  openWindows.set(id, {
    id,
    config,
    window: null,
    closed: false,
    isElectron: true,
  });

  // Push the last known content immediately so the window doesn't stay blank
  // after a renderer reload (race between data loading and window adoption).
  if (lastBroadcastContent) {
    setTimeout(() => sendContent(id, lastBroadcastContent!), 100);
  }
  // Same for the stage overlay: a window adopted mid-countdown has to pick the timer back
  // up, not sit blank until the next cue change.
  setTimeout(() => replayStage(id), 100);
}

/**
 * Optional resolver supplied by usePresentationSync that, given a window id and
 * its config, returns the per-window resolved style to merge into the content
 * before broadcasting. When undefined, no per-window style override is applied.
 */
type WindowStyleResolver = (id: string, config: WindowConfig) => unknown | undefined;
let windowStyleResolver: WindowStyleResolver | undefined;

export function setWindowStyleResolver(fn: WindowStyleResolver | undefined): void {
  windowStyleResolver = fn;
}

/**
 * Check if Electron API is available.
 */
function isElectron(): boolean {
  return !!(window as unknown as { api?: { createPresentationWindow?: unknown } }).api?.createPresentationWindow;
}

/**
 * Open a new presentation window.
 * In browser mode: uses window.open.
 * In Electron mode: uses IPC to create a BrowserWindow via the main process.
 */
export async function openPresentationWindow(config: WindowConfig = {}): Promise<string> {
  if (isElectron()) {
    return openPresentationWindowElectron(config);
  }
  return openPresentationWindowBrowser(config);
}

/**
 * Open a presentation window via Electron IPC (§7.2, §12).
 */
async function openPresentationWindowElectron(config: WindowConfig): Promise<string> {
  const electronConfig = {
    name: config.name || 'Presentation',
    displayMode: config.displayMode || 'normal',
    languages: config.languages?.join(',') || 'all',
    positionX: config.positionX ?? config.left,
    positionY: config.positionY ?? config.top,
    width: config.width || 1920,
    height: config.height || 1080,
    fullscreen: config.fullscreen || false,
    frameless: config.frameless ?? true,
    alwaysOnTop: config.alwaysOnTop || false,
    hideMouse: config.hideMouse || false,
    hideText: config.hideText || false,
    hideBackground: config.hideBackground || false,
    frozen: false,
    streamLines: config.streamLines,
    streamTransparentBg: config.transparent || false,
  };

  const id = await window.api.createPresentationWindow(electronConfig);

  const entry: PresentationWindowEntry = {
    id,
    config,
    window: null,
    closed: false,
    isElectron: true,
  };

  openWindows.set(id, entry);

  // Push current content to the new window so it doesn't start black
  if (lastBroadcastContent) {
    setTimeout(() => sendContent(id, lastBroadcastContent!), 500);
  }

  // A window opened while a countdown is running joins it in progress.
  setTimeout(() => replayStage(id), 500);

  return id;
}

/**
 * Open a presentation window in browser mode (window.open).
 */
function openPresentationWindowBrowser(config: WindowConfig): string {
  const id = `presentation-${++windowCounter}`;

  // Browser mode: open a popup window
  const params: Record<string, string | number> = {
    scrollbars: 'no',
    resizable: 'yes',
    status: 'no',
    location: 'no',
    toolbar: 'no',
    menubar: 'no',
    top: config.top ?? 0,
    left: config.left ?? -1920,
    width: config.width ?? 1920,
    height: config.height ?? 1080,
  };

  const windowFeatures = Object.entries(params)
    .map(([key, value]) => `${key}=${value}`)
    .join(',');

  // Build URL with query params for display mode config
  const queryParams = new URLSearchParams();
  if (config.displayMode) queryParams.set('mode', config.displayMode);
  if (config.name) queryParams.set('name', config.name);
  if (config.streamLines) queryParams.set('lines', String(config.streamLines));
  if (config.languages && config.languages.length > 0) {
    queryParams.set('languages', config.languages.join(','));
  }
  if (config.transparent) {
    queryParams.set('transparent', '1');
  }

  // The popup announces itself with this id once its message listener is live — see
  // the PRESENTATION_READY handler below.
  queryParams.set('wid', id);

  const queryString = queryParams.toString();
  const url = `./presentation.html${queryString ? `?${queryString}` : ''}`;

  const win = window.open(url, id, windowFeatures);

  const entry: PresentationWindowEntry = {
    id,
    config,
    window: win,
    closed: false,
    isElectron: false,
  };

  openWindows.set(id, entry);

  // Monitor for window close
  if (win) {
    const checkClosed = setInterval(() => {
      if (win.closed) {
        entry.closed = true;
        openWindows.delete(id);
        clearInterval(checkClosed);
      }
    }, 1000);
  }

  // Nothing is pushed here on purpose. The popup tells US when it is ready
  // (PRESENTATION_READY, handled below) — see that handler for why.

  return id;
}

/**
 * A browser presentation window reporting that its message listener is attached.
 *
 * The opener cannot observe this for itself. A `load` listener registered on the popup
 * is registered against the about:blank global the popup starts on, and is thrown away
 * when it navigates to presentation.html — so the content pushed from it usually never
 * arrived, and the window sat black until the operator changed the block, which was the
 * first thing to produce a fresh broadcast.
 *
 * So the popup announces itself instead, exactly as the Electron window does via
 * `signalReady()`. Both the immediate push and the force-broadcast are wanted: the push
 * makes it instant, and the broadcast covers a window opened before there was any
 * content to send and re-resolves the per-window style cascade.
 */
function handlePresentationReady(event: MessageEvent): void {
  if (event.data?.type !== 'PRESENTATION_READY') return;

  // Prefer the id the popup was opened with; fall back to matching the source window,
  // which also catches a popup the user reloaded by hand.
  let entry = typeof event.data.id === 'string' ? openWindows.get(event.data.id) : undefined;
  if (!entry) {
    for (const [, candidate] of openWindows) {
      if (!candidate.isElectron && candidate.window && candidate.window === event.source) {
        entry = candidate;
        break;
      }
    }
  }
  if (!entry || entry.isElectron) return;

  // Whatever we "already sent" went to a document that no longer exists.
  entry.lastSentSerialized = undefined;
  if (lastBroadcastContent) void sendContent(entry.id, lastBroadcastContent);
  replayStage(entry.id);
  window.dispatchEvent(new CustomEvent('presenter:force-broadcast'));
}

if (typeof window !== 'undefined') {
  window.addEventListener('message', handlePresentationReady);
}

/**
 * Close a presentation window by ID.
 */
export async function closePresentationWindow(id: string): Promise<void> {
  const entry = openWindows.get(id);
  if (!entry) return;

  if (entry.isElectron) {
    await window.api.closePresentationWindow(id);
  } else if (entry.window && !entry.window.closed) {
    entry.window.close();
  }
  openWindows.delete(id);
}

/**
 * Close all presentation windows.
 */
export async function closeAllPresentationWindows(): Promise<void> {
  const ids = [...openWindows.keys()];
  for (const id of ids) {
    await closePresentationWindow(id);
  }
}

/**
 * Send content to a specific presentation window.
 */
export async function sendContent(id: string, content: PresentationContent): Promise<void> {
  const entry = openWindows.get(id);
  if (!entry || entry.closed) return;

  if (entry.isElectron) {
    // Apply per-window config overrides
    const windowContent = applyWindowOverrides(content, entry.config, id);
    // Renderer-side dedupe — skip the IPC roundtrip + structured clone if
    // the payload is byte-identical to the last one we sent to this window.
    let serialized = '';
    try {
      serialized = JSON.stringify(windowContent);
    } catch {
      /* fall through */
    }
    if (serialized && serialized === entry.lastSentSerialized) return;
    entry.lastSentSerialized = serialized || undefined;
    window.api.updatePresentationContent(id, windowContent as never);
  } else if (entry.window && !entry.window.closed) {
    // Apply per-window config overrides
    const windowContent = applyWindowOverrides(content, entry.config, id);
    let serialized = '';
    try {
      serialized = JSON.stringify(windowContent);
    } catch {
      /* fall through */
    }
    if (serialized && serialized === entry.lastSentSerialized) return;
    entry.lastSentSerialized = serialized || undefined;

    entry.window.postMessage(
      {
        type: 'UPDATE_PRESENTATION',
        props: { content: windowContent },
      },
      '*',
    );
  }
}

/**
 * Broadcast content to ALL open presentation windows.
 * Sends to every window in parallel — `sendContent` is fire-and-forget for IPC,
 * so awaiting in a loop adds no value but adds tail latency.
 */
export async function broadcastContent(content: PresentationContent): Promise<void> {
  lastBroadcastContent = content;
  // Always send per-window so each window gets its own resolved style override.
  for (const [id] of openWindows) {
    // Intentionally NOT awaited — IPC `send` is one-way and `postMessage` is sync.
    void sendContent(id, content);
  }
}

// ── Stage monitor ─────────────────────────────────────────────────────────────
//
// A channel of its own, deliberately separate from the content path.
//
// The content broadcast is deduped on a navigation key and re-serialized per window; a
// clock pushed through it would defeat both and re-send the entire slide once a second for
// every open window. So the stage overlay travels alone, carrying only absolute timestamps,
// and is sent when a *cue* changes rather than when its value does. The windows do the
// per-second arithmetic themselves.

/** Last stage payload — replayed to windows that open or reload after it was sent. */
let lastBroadcastStage: StageOverlayPayload = EMPTY_STAGE_PAYLOAD;

/**
 * The layers a given window subscribes to. Subscription is opt-in: a window with no
 * `stageLayerIds` shows no stage content, so adding a countdown never surprises a beamer
 * that was only ever meant to show lyrics.
 */
function stagePayloadForWindow(payload: StageOverlayPayload, config: WindowConfig): StageOverlayPayload {
  const subscribed = config.stageLayerIds;
  if (!subscribed || subscribed.length === 0) return EMPTY_STAGE_PAYLOAD;
  return { layers: payload.layers.filter((l) => subscribed.includes(l.id)) };
}

/** Send the stage overlay to one window, skipping the hop when nothing changed for it. */
export async function sendStage(id: string, payload: StageOverlayPayload): Promise<void> {
  const entry = openWindows.get(id);
  if (!entry || entry.closed) return;

  const windowPayload = stagePayloadForWindow(payload, entry.config);
  let serialized = '';
  try {
    serialized = JSON.stringify(windowPayload);
  } catch {
    /* fall through and send anyway */
  }
  if (serialized && serialized === entry.lastSentStage) return;
  entry.lastSentStage = serialized || undefined;

  if (entry.isElectron) {
    window.api.updateStageOverlay?.(id, windowPayload as never);
  } else if (entry.window && !entry.window.closed) {
    entry.window.postMessage({ type: 'UPDATE_STAGE', payload: windowPayload }, '*');
  }
}

/** Push the stage overlay to every open window. */
export async function broadcastStage(payload: StageOverlayPayload): Promise<void> {
  lastBroadcastStage = payload;
  for (const [id] of openWindows) {
    void sendStage(id, payload);
  }
}

/**
 * Forget what a window was last told about the stage, so the next send actually goes.
 * Needed whenever a window's renderer restarts — the payload it "already has" was received
 * by a document that no longer exists.
 */
export function invalidateSentStageCache(id?: string): void {
  if (id) {
    const entry = openWindows.get(id);
    if (entry) entry.lastSentStage = undefined;
    return;
  }
  for (const [, entry] of openWindows) entry.lastSentStage = undefined;
}

/** Re-send the current overlay to one window — used after it opens, reloads, or resubscribes. */
export function replayStage(id: string): void {
  invalidateSentStageCache(id);
  void sendStage(id, lastBroadcastStage);
}

/**
 * Drop the per-window dedupe snapshots so the next broadcast is actually sent.
 *
 * Needed whenever a presentation window's renderer restarts: the payload we "already sent"
 * was received by the PREVIOUS renderer instance (or by none at all, if it was still
 * bootstrapping), so byte-identical content must be allowed through again.
 */
export function invalidateSentContentCache(id?: string): void {
  if (id) {
    const entry = openWindows.get(id);
    if (entry) entry.lastSentSerialized = undefined;
    return;
  }
  for (const [, entry] of openWindows) entry.lastSentSerialized = undefined;
}

/**
 * Update an open window's stored config in the bridge registry.
 * MUST be called whenever per-window settings (especially `styleId`) change in
 * Redux/localStorage so the windowStyleResolver picks up the new value on the
 * next broadcast — otherwise the bridge keeps using the config snapshot taken
 * when the window was first opened, and style assignments appear to do nothing
 * until the window is closed and reopened.
 */
export function updateWindowConfigInBridge(id: string, partial: Partial<WindowConfig>): void {
  const entry = openWindows.get(id);
  if (!entry) return;
  entry.config = { ...entry.config, ...partial };
  // Invalidate the per-window dedupe cache so the next broadcast actually
  // picks up the new config (e.g. styleId, displayMode, languages).
  entry.lastSentSerialized = undefined;
  // Immediately re-send the last broadcast content so the style change takes
  // effect without waiting for the next navigation event.
  if (lastBroadcastContent) {
    void sendContent(id, lastBroadcastContent);
  }
  // `stageLayerIds` may have changed, which decides what this window is allowed to see.
  replayStage(id);
}

/**
 * Get a list of open window IDs and their configs.
 */
export async function getOpenWindows(): Promise<Array<{ id: string; config: WindowConfig; closed: boolean }>> {
  // In Electron mode, get live states from main process
  if (isElectron()) {
    try {
      const states = await window.api.getWindowStates();
      // Merge with local registry
      const result: Array<{ id: string; config: WindowConfig; closed: boolean }> = [];
      for (const state of states) {
        const entry = openWindows.get(state.id);
        result.push({
          id: state.id,
          config: entry?.config || {
            name: state.name,
            displayMode: state.displayMode,
          },
          closed: false,
        });
      }
      // Also include browser windows
      for (const [, entry] of openWindows) {
        if (!entry.isElectron && !entry.closed) {
          result.push({ id: entry.id, config: entry.config, closed: entry.closed });
        }
      }
      return result;
    } catch {
      // Fallback to local registry
    }
  }

  const result: Array<{ id: string; config: WindowConfig; closed: boolean }> = [];
  for (const [, entry] of openWindows) {
    result.push({ id: entry.id, config: entry.config, closed: entry.closed });
  }
  return result;
}

/**
 * Synchronous version for backward compatibility (used by Footer polling).
 */
export function getOpenWindowsSync(): Array<{ id: string; config: WindowConfig; closed: boolean }> {
  const result: Array<{ id: string; config: WindowConfig; closed: boolean }> = [];
  for (const [, entry] of openWindows) {
    result.push({ id: entry.id, config: entry.config, closed: entry.closed });
  }
  return result;
}

/**
 * Send an identify command to all windows (toggle ON).
 */
export async function identifyWindows(styleName?: string): Promise<void> {
  if (isElectron()) {
    await window.api.identifyWindows();
  }

  // Also handle browser windows
  let counter = 0;
  for (const [, entry] of openWindows) {
    if (!entry.closed && !entry.isElectron && entry.window && !entry.window.closed) {
      counter++;
      entry.window.postMessage(
        {
          type: 'UPDATE_PRESENTATION',
          props: {
            content: {
              contentType: 'empty',
              displayMode: 'normal',
              activeBlockIndex: 0,
              activeLineIndex: 0,
              blocks: [],
              style: {},
              isBlack: false,
              showIdentify: true,
              windowName: entry.config.name || `Window ${counter}`,
              windowNumber: counter,
              identifyStyleName: styleName,
            },
          },
        },
        '*',
      );
    }
  }
}

/**
 * Hide the identify overlay on all windows (toggle OFF).
 */
export async function hideIdentify(): Promise<void> {
  // In Electron mode, send hide-identify to all Electron windows
  if (isElectron()) {
    await window.api.hideIdentifyWindows();
  }

  // Also handle browser windows
  for (const [, entry] of openWindows) {
    if (!entry.closed && !entry.isElectron && entry.window && !entry.window.closed) {
      entry.window.postMessage({ type: 'HIDE_IDENTIFY' }, '*');
    }
  }
}

/**
 * Fade to black.
 */
export async function fadeToBlack(windowName?: string): Promise<void> {
  if (isElectron()) {
    await window.api.fadeToBlack(windowName);
  }
}

/**
 * Fade from black.
 */
export async function fadeFromBlack(windowName?: string): Promise<void> {
  if (isElectron()) {
    await window.api.fadeFromBlack(windowName);
  }
}

/**
 * Freeze a window.
 */
export async function freezeWindow(windowName: string): Promise<void> {
  if (isElectron()) {
    await window.api.freezeWindow(windowName);
  }
}

/**
 * Unfreeze a window.
 */
export async function unfreezeWindow(windowName: string): Promise<void> {
  if (isElectron()) {
    await window.api.unfreezeWindow(windowName);
  }
}

/**
 * List available screens (Electron only).
 */
export async function listScreens(): Promise<
  Array<{ id: number; label: string; bounds: { x: number; y: number; width: number; height: number }; isPrimary: boolean }>
> {
  if (isElectron()) {
    return window.api.listScreens();
  }
  // In browser mode, we can only detect the current screen
  return [
    {
      id: 0,
      label: 'Current Screen',
      bounds: {
        x: 0,
        y: 0,
        width: window.screen.width,
        height: window.screen.height,
      },
      isPrimary: true,
    },
  ];
}

// ── Helpers ──

/**
 * Apply per-window config overrides to presentation content.
 */
function applyWindowOverrides(content: PresentationContent, config: WindowConfig, id?: string): PresentationContent {
  const merged: PresentationContent = {
    ...content,
    displayMode: config.displayMode || content.displayMode,
    languages: config.languages || content.languages,
    streamLines: config.streamLines || content.streamLines,
    windowName: config.name || content.windowName,
    hideText: config.hideText || content.hideText,
    hideBackground: config.hideBackground || content.hideBackground,
  };

  // If a per-window style preset is configured, layer it on top of the cascade.
  if (id && windowStyleResolver) {
    const windowStyle = windowStyleResolver(id, config);
    if (windowStyle && typeof windowStyle === 'object') {
      const cleanStyle = Object.fromEntries(
        Object.entries(windowStyle as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined),
      );
      merged.style = { ...(merged.style || {}), ...cleanStyle } as typeof merged.style;
    }
  }

  // Which languages this window shows is the style's decision, but the style only names slots
  // — "the second language" — so it can only be turned into actual codes here, where the song's
  // own language order is also in hand. A window-level override still wins over both.
  if (!config.languages) {
    const style = merged.style as { showAllLanguages?: boolean; languageStyles?: LanguageStyleEntry[] } | undefined;
    merged.languages = languagesForStyle(style?.languageStyles, merged.songLanguages, style?.showAllLanguages);
  }

  return merged;
}
