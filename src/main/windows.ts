/**
 * Presentation Window Manager — Electron main process.
 * Creates, tracks, and controls presentation BrowserWindows (§7.2, §12, §13).
 */
import { BrowserWindow, screen, type WebContents } from 'electron';
import { join } from 'path';
import { is } from '@electron-toolkit/utils';
import type { WindowConfig, WindowState, ScreenInfo, MusicianViewConfig, PresentationContentIPC } from '../shared/types';

interface ManagedWindow {
  id: string;
  config: WindowConfig;
  browserWindow: BrowserWindow;
  frozen: boolean;
  isBlack: boolean;
  queuedContent: PresentationContentIPC | null; // content queued while frozen
  /** JSON-serialized snapshot of the last payload sent to this window — used to dedupe. */
  lastSentPayload: string | null;
}

let windowCounter = 0;

export class PresentationWindowManager {
  private windows: Map<string, ManagedWindow> = new Map();
  private musicianWindows: Map<string, BrowserWindow> = new Map();
  /** IDs of windows currently being recreated — prevents closed-handler deletion */
  private recreating = new Set<string>();
  /** Last broadcast content — re-sent after window recreation */
  private lastBroadcastContent: PresentationContentIPC | null = null;
  /** Reference to main window for sending bounds-change notifications */
  private mainWindow: BrowserWindow | null = null;

  setMainWindow(win: BrowserWindow | null): void {
    this.mainWindow = win;
  }

  private notifyBoundsChanged(id: string, win: BrowserWindow): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    const bounds = win.getBounds();
    const managed = this.windows.get(id);
    if (!managed) return;
    // Update config
    managed.config.positionX = bounds.x;
    managed.config.positionY = bounds.y;
    managed.config.width = bounds.width;
    managed.config.height = bounds.height;
    this.mainWindow.webContents.send('presentation-window-bounds-changed', { id, bounds });
  }

  /**
   * Create a new presentation window.
   */
  createPresentationWindow(config: WindowConfig): string {
    const id = `pres-${++windowCounter}`;

    const win = new BrowserWindow({
      x: config.positionX,
      y: config.positionY,
      width: config.width || 1920,
      height: config.height || 1080,
      fullscreen: config.fullscreen,
      frame: !config.frameless,
      alwaysOnTop: config.alwaysOnTop,
      transparent: config.streamTransparentBg || false,
      hasShadow: !config.streamTransparentBg,
      skipTaskbar: true,
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/presentation.mjs'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: is.dev,
        webSecurity: false, // allow loading media from http://localhost:9100
        backgroundThrottling: false,
      },
    });

    // Hide mouse cursor if configured
    if (config.hideMouse) {
      win.webContents.on('did-finish-load', () => {
        win.webContents.insertCSS('* { cursor: none !important; }');
      });
    }

    // Build URL with query params for display mode config
    const queryParams = new URLSearchParams();
    queryParams.set('mode', config.displayMode || 'normal');
    if (config.name) queryParams.set('name', config.name);
    if (config.streamLines) queryParams.set('lines', String(config.streamLines));
    if (config.languages && config.languages !== 'all') {
      queryParams.set('languages', config.languages);
    }
    if (config.streamTransparentBg) {
      queryParams.set('transparent', '1');
    }

    const queryString = queryParams.toString();

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      const baseUrl = process.env['ELECTRON_RENDERER_URL'];
      win.loadURL(`${baseUrl}/presentation.html?${queryString}`);
    } else {
      win.loadFile(join(__dirname, '../renderer/presentation.html'), {
        search: queryString,
      });
    }

    win.once('ready-to-show', () => {
      win.show();
      if (config.fullscreen) {
        win.setFullScreen(true);
      }
      // Re-send the last known presentation content so the window doesn't show
      // a black screen (happens when windows are restored on startup).
      // A short delay lets the React app bootstrap before the IPC payload arrives.
      if (this.lastBroadcastContent) {
        const lastContent = this.lastBroadcastContent;
        setTimeout(() => {
          const m = this.windows.get(id);
          if (m && !m.browserWindow.isDestroyed()) {
            const wc: PresentationContentIPC = {
              ...lastContent,
              displayMode: config.displayMode || lastContent.displayMode,
              languages: config.languages !== 'all' ? config.languages.split(',').map((l) => l.trim()) : lastContent.languages,
              streamLines: config.streamLines || lastContent.streamLines,
              hideText: config.hideText || lastContent.hideText,
              hideBackground: config.hideBackground || lastContent.hideBackground,
              windowName: config.name || lastContent.windowName,
            };
            m.lastSentPayload = null; // reset dedup so the payload is always sent
            this._sendContent(m, wc);
          }
        }, 300);
      }
    });

    // Debounce bounds notifications (move/resize fire many times during drag)
    let boundsTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleBoundsNotify = () => {
      if (boundsTimer) clearTimeout(boundsTimer);
      boundsTimer = setTimeout(() => {
        boundsTimer = null;
        if (!win.isDestroyed() && !win.isFullScreen()) {
          this.notifyBoundsChanged(id, win);
        }
      }, 300);
    };
    win.on('move', scheduleBoundsNotify);
    win.on('resize', scheduleBoundsNotify);

    win.on('closed', () => {
      if (boundsTimer) {
        clearTimeout(boundsTimer);
        boundsTimer = null;
      }
      if (!this.recreating.has(id)) {
        this.windows.delete(id);
      }
    });

    const managed: ManagedWindow = {
      id,
      config,
      browserWindow: win,
      frozen: config.frozen || false,
      isBlack: false,
      queuedContent: null,
      lastSentPayload: null,
    };

    this.windows.set(id, managed);
    return id;
  }

  /**
   * Close a specific presentation window.
   */
  closePresentationWindow(id: string): void {
    const managed = this.windows.get(id);
    if (managed && !managed.browserWindow.isDestroyed()) {
      managed.browserWindow.close();
    }
    this.windows.delete(id);
  }

  /**
   * Focus (bring to front) a presentation window without changing always-on-top.
   */
  focusPresentationWindow(id: string): void {
    const managed = this.windows.get(id);
    if (managed && !managed.browserWindow.isDestroyed()) {
      managed.browserWindow.focus();
    }
  }

  /**
   * Hide (make invisible) a presentation window.
   */
  hidePresentationWindow(id: string): void {
    const managed = this.windows.get(id);
    if (managed && !managed.browserWindow.isDestroyed()) {
      managed.browserWindow.hide();
    }
  }

  /**
   * Show (make visible) a previously hidden presentation window.
   */
  showPresentationWindow(id: string): void {
    const managed = this.windows.get(id);
    if (managed && !managed.browserWindow.isDestroyed()) {
      managed.browserWindow.show();
    }
  }

  /**
   * Close all presentation windows.
   */
  closeAll(): void {
    for (const [, managed] of this.windows) {
      if (!managed.browserWindow.isDestroyed()) {
        managed.browserWindow.close();
      }
    }
    this.windows.clear();
  }

  /**
   * Force-destroy all presentation and musician windows (used on app quit).
   */
  destroyAll(): void {
    for (const [, managed] of this.windows) {
      if (!managed.browserWindow.isDestroyed()) {
        managed.browserWindow.destroy();
      }
    }
    this.windows.clear();
    for (const [, win] of this.musicianWindows) {
      if (!win.isDestroyed()) {
        win.destroy();
      }
    }
    this.musicianWindows.clear();
  }

  /**
   * A presentation window's renderer finished mounting and attached its IPC listeners.
   * Anything sent before that moment was dropped silently (webContents.send has no queue),
   * which left restored windows black on app start until the next navigation. Replay the
   * last payload this window was meant to show, and tell the operator renderer so it can
   * follow up with the freshest content through its own per-window style resolution.
   */
  handlePresentationReady(sender: WebContents): void {
    for (const [id, managed] of this.windows) {
      if (managed.browserWindow.isDestroyed()) continue;
      if (managed.browserWindow.webContents !== sender) continue;
      if (managed.lastSentPayload) {
        try {
          const content = JSON.parse(managed.lastSentPayload) as PresentationContentIPC;
          managed.lastSentPayload = null; // reset dedup so the replay is actually sent
          this._sendContent(managed, content);
        } catch {
          /* corrupt snapshot — the operator's follow-up broadcast covers it */
        }
      }
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('presentation-window-ready', { id });
      }
      return;
    }
  }

  /**
   * Send content to a specific presentation window.
   * Respects freeze state — queues content if frozen.
   */
  updatePresentationContent(id: string, content: PresentationContentIPC): void {
    const managed = this.windows.get(id);
    if (!managed || managed.browserWindow.isDestroyed()) return;

    if (managed.frozen) {
      managed.queuedContent = content;
      return;
    }

    this._sendContent(managed, content);
  }

  /**
   * Forward the stage overlay to one presentation window.
   *
   * Deliberately a plain relay: no dedupe (the renderer already skips unchanged payloads)
   * and no freeze handling. Freezing holds the *content* on screen so the operator can cue
   * the next slide unseen — a countdown that stopped ticking because a window was frozen
   * would be a bug, not the feature.
   */
  sendStageOverlay(id: string, payload: unknown): void {
    const managed = this.windows.get(id);
    if (!managed || managed.browserWindow.isDestroyed()) return;
    managed.browserWindow.webContents.send('presentation-stage', payload);
  }

  /**
   * Broadcast content to all presentation windows.
   * Per-window config overrides (displayMode, languages, etc.) are applied.
   */
  broadcastContent(content: PresentationContentIPC): void {
    this.lastBroadcastContent = content;
    for (const [, managed] of this.windows) {
      if (managed.browserWindow.isDestroyed()) continue;

      // Apply per-window config overrides
      const windowContent: PresentationContentIPC = {
        ...content,
        displayMode: managed.config.displayMode || content.displayMode,
        languages: managed.config.languages !== 'all' ? managed.config.languages.split(',').map((l) => l.trim()) : content.languages,
        streamLines: managed.config.streamLines || content.streamLines,
        hideText: managed.config.hideText || content.hideText,
        hideBackground: managed.config.hideBackground || content.hideBackground,
        windowName: managed.config.name || content.windowName,
      };

      if (managed.frozen) {
        managed.queuedContent = windowContent;
      } else {
        this._sendContent(managed, windowContent);
      }
    }
  }

  /**
   * Fade to black by window name. If no name provided, affects all.
   */
  fadeToBlack(windowName?: string): void {
    this._forEachByName(windowName, (managed) => {
      managed.isBlack = true;
      if (!managed.browserWindow.isDestroyed()) {
        managed.browserWindow.webContents.send('presentation-command', {
          type: 'FADE_TO_BLACK',
        });
      }
    });
  }

  /**
   * Fade from black by window name. If no name provided, affects all.
   */
  fadeFromBlack(windowName?: string): void {
    this._forEachByName(windowName, (managed) => {
      managed.isBlack = false;
      if (!managed.browserWindow.isDestroyed()) {
        managed.browserWindow.webContents.send('presentation-command', {
          type: 'FADE_FROM_BLACK',
        });
      }
    });
  }

  /**
   * Freeze a window by name — queues content updates.
   */
  freezeWindow(windowName: string): void {
    this._forEachByName(windowName, (managed) => {
      managed.frozen = true;
      // Pause any playing videos
      if (!managed.browserWindow.isDestroyed()) {
        managed.browserWindow.webContents.send('presentation-command', {
          type: 'VIDEO_COMMAND',
          action: 'pause',
        });
      }
    });
  }

  /**
   * Unfreeze a window by name — applies latest queued content and resumes video.
   */
  unfreezeWindow(windowName: string): void {
    this._forEachByName(windowName, (managed) => {
      managed.frozen = false;
      if (managed.queuedContent) {
        this._sendContent(managed, managed.queuedContent);
        managed.queuedContent = null;
      }
      // Resume video playback
      if (!managed.browserWindow.isDestroyed()) {
        managed.browserWindow.webContents.send('presentation-command', {
          type: 'VIDEO_COMMAND',
          action: 'play',
        });
      }
    });
  }

  /**
   * Trigger all presentation windows to show identification overlay.
   */
  identifyWindows(): void {
    let counter = 1;
    for (const [, managed] of this.windows) {
      if (managed.browserWindow.isDestroyed()) continue;
      managed.browserWindow.webContents.send('presentation-command', {
        type: 'IDENTIFY',
        windowName: managed.config.name || `Window ${managed.id}`,
        number: counter++,
      });
    }
  }

  /**
   * Hide the identification overlay on all windows.
   */
  hideIdentifyWindows(): void {
    for (const [, managed] of this.windows) {
      if (managed.browserWindow.isDestroyed()) continue;
      managed.browserWindow.webContents.send('presentation-command', {
        type: 'HIDE_IDENTIFY',
      });
    }
  }

  /**
   * Get states of all open windows.
   */
  getWindowStates(): WindowState[] {
    const states: WindowState[] = [];
    for (const [, managed] of this.windows) {
      if (managed.browserWindow.isDestroyed()) continue;
      const bounds = managed.browserWindow.getBounds();
      states.push({
        id: managed.id,
        name: managed.config.name,
        displayMode: managed.config.displayMode,
        frozen: managed.frozen,
        isBlack: managed.isBlack,
        fullscreen: managed.browserWindow.isFullScreen(),
        hidden: !managed.browserWindow.isVisible(),
        bounds,
      });
    }
    return states;
  }

  /**
   * List all available screens/displays.
   */
  listScreens(): ScreenInfo[] {
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    return displays.map((d) => ({
      id: d.id,
      label: d.label || `Display ${d.id}`,
      bounds: d.bounds,
      workArea: d.workArea,
      isPrimary: d.id === primary.id,
      scaleFactor: d.scaleFactor,
    }));
  }

  /**
   * Open the musician PDF view as a separate BrowserWindow.
   */
  openMusicianView(config: MusicianViewConfig): string {
    const id = `musician-${++windowCounter}`;

    const win = new BrowserWindow({
      width: config.width || 1024,
      height: config.height || 768,
      x: config.positionX,
      y: config.positionY,
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.mjs'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/musician.html`);
    } else {
      win.loadFile(join(__dirname, '../renderer/musician.html'));
    }

    win.on('closed', () => {
      this.musicianWindows.delete(id);
    });

    this.musicianWindows.set(id, win);
    return id;
  }

  /**
   * Get a specific window's BrowserWindow instance.
   */
  getWindow(id: string): BrowserWindow | null {
    const managed = this.windows.get(id);
    return managed?.browserWindow || null;
  }

  /**
   * Get all managed windows (for external iteration).
   */
  getAllWindows(): Map<string, ManagedWindow> {
    return this.windows;
  }

  /**
   * Apply runtime updates to a presentation window.
   * Returns { applied, requiresReload } — `requiresReload` is true if some props
   * (frame/transparency/webPreferences) need a window recreation to take effect.
   */
  updateWindowConfig(id: string, partial: Partial<WindowConfig>): { applied: string[]; requiresReload: string[] } {
    const managed = this.windows.get(id);
    const applied: string[] = [];
    const requiresReload: string[] = [];
    if (!managed || managed.browserWindow.isDestroyed()) {
      return { applied, requiresReload };
    }
    const win = managed.browserWindow;
    const cfg = managed.config;

    if (partial.name !== undefined && partial.name !== cfg.name) {
      cfg.name = partial.name;
      applied.push('name');
    }
    if (partial.fullscreen !== undefined && partial.fullscreen !== cfg.fullscreen) {
      cfg.fullscreen = partial.fullscreen;
      try {
        win.setFullScreen(partial.fullscreen);
        applied.push('fullscreen');
      } catch {
        /* noop */
      }
    }
    if (partial.alwaysOnTop !== undefined && partial.alwaysOnTop !== cfg.alwaysOnTop) {
      cfg.alwaysOnTop = partial.alwaysOnTop;
      try {
        win.setAlwaysOnTop(partial.alwaysOnTop);
        applied.push('alwaysOnTop');
      } catch {
        /* noop */
      }
    }
    if (partial.width !== undefined || partial.height !== undefined || partial.positionX !== undefined || partial.positionY !== undefined) {
      const cur = win.getBounds();
      const next = {
        x: partial.positionX ?? cur.x,
        y: partial.positionY ?? cur.y,
        width: partial.width ?? cur.width,
        height: partial.height ?? cur.height,
      };
      cfg.positionX = next.x;
      cfg.positionY = next.y;
      cfg.width = next.width;
      cfg.height = next.height;
      try {
        win.setBounds(next);
        applied.push('bounds');
      } catch {
        /* noop */
      }
    }
    if (partial.hideMouse !== undefined && partial.hideMouse !== cfg.hideMouse) {
      cfg.hideMouse = partial.hideMouse;
      try {
        win.webContents.insertCSS(partial.hideMouse ? '* { cursor: none !important; }' : '* { cursor: auto !important; }');
        applied.push('hideMouse');
      } catch {
        /* noop */
      }
    }
    if (partial.displayMode !== undefined && partial.displayMode !== cfg.displayMode) {
      cfg.displayMode = partial.displayMode;
      applied.push('displayMode');
    }
    if (partial.languages !== undefined && partial.languages !== cfg.languages) {
      cfg.languages = partial.languages;
      applied.push('languages');
    }
    if (partial.streamLines !== undefined && partial.streamLines !== cfg.streamLines) {
      cfg.streamLines = partial.streamLines;
      applied.push('streamLines');
    }
    if (partial.hideText !== undefined && partial.hideText !== cfg.hideText) {
      cfg.hideText = partial.hideText;
      applied.push('hideText');
    }
    if (partial.hideBackground !== undefined && partial.hideBackground !== cfg.hideBackground) {
      cfg.hideBackground = partial.hideBackground;
      applied.push('hideBackground');
    }

    // Frame / transparency cannot be toggled on a live BrowserWindow — recreate it.
    if (partial.frameless !== undefined && partial.frameless !== cfg.frameless) {
      cfg.frameless = partial.frameless;
      this._recreateWindow(managed);
      applied.push('frameless');
    }
    if (partial.streamTransparentBg !== undefined && partial.streamTransparentBg !== cfg.streamTransparentBg) {
      cfg.streamTransparentBg = partial.streamTransparentBg;
      requiresReload.push('streamTransparentBg');
    }

    return { applied, requiresReload };
  }

  /**
   * Send a video command (play/pause/stop/mute/unmute/seek/volume) to presentation windows.
   */
  sendVideoCommand(action: string, windowName?: string, value?: number, fadeDuration?: number, target?: string): void {
    this._forEachByName(windowName, (managed) => {
      if (!managed.browserWindow.isDestroyed()) {
        managed.browserWindow.webContents.send('presentation-command', {
          type: 'VIDEO_COMMAND',
          action,
          value,
          fadeDuration,
          target,
        });
      }
    });
  }

  /**
   * Toggle background-video visibility per-window (or all when `windowName`
   * is undefined). `value === undefined` means toggle the current state.
   */
  setVideoVisible(windowName?: string, value?: boolean, mode?: 'cut' | 'fade', durationMs?: number): void {
    this._forEachByName(windowName, (managed) => {
      if (!managed.browserWindow.isDestroyed()) {
        managed.browserWindow.webContents.send('presentation-command', {
          type: 'SET_VIDEO_VISIBLE',
          value,
          mode,
          durationMs,
        });
      }
    });
  }

  // ── Private helpers ──

  /**
   * Recreate a presentation window in-place (same map id) with the current config.
   * Used when frameless is toggled since Electron requires window recreation.
   */
  private _recreateWindow(managed: ManagedWindow): void {
    const id = managed.id;
    const config = { ...managed.config };

    // Capture current bounds / fullscreen state
    if (!managed.browserWindow.isDestroyed()) {
      const bounds = managed.browserWindow.getBounds();
      config.positionX = bounds.x;
      config.positionY = bounds.y;
      config.width = bounds.width;
      config.height = bounds.height;
      config.fullscreen = managed.browserWindow.isFullScreen();
    }

    // Destroy old window without removing from map
    this.recreating.add(id);
    if (!managed.browserWindow.isDestroyed()) {
      managed.browserWindow.destroy();
    }
    // Note: do NOT delete from recreating here — the old window's 'closed' event fires
    // asynchronously and would remove the managed entry. We clear the flag in ready-to-show.

    // Build new BrowserWindow
    const win = new BrowserWindow({
      x: config.positionX,
      y: config.positionY,
      width: config.width || 1920,
      height: config.height || 1080,
      fullscreen: config.fullscreen,
      frame: !config.frameless,
      alwaysOnTop: config.alwaysOnTop,
      transparent: config.streamTransparentBg || false,
      hasShadow: !config.streamTransparentBg,
      skipTaskbar: true,
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/presentation.mjs'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: is.dev,
        webSecurity: false, // allow loading media from http://localhost:9100
        backgroundThrottling: false,
      },
    });

    if (config.hideMouse) {
      win.webContents.on('did-finish-load', () => {
        win.webContents.insertCSS('* { cursor: none !important; }');
      });
    }

    const queryParams = new URLSearchParams();
    queryParams.set('mode', config.displayMode || 'normal');
    if (config.name) queryParams.set('name', config.name);
    if (config.streamLines) queryParams.set('lines', String(config.streamLines));
    if (config.languages && config.languages !== 'all') queryParams.set('languages', config.languages);
    if (config.streamTransparentBg) queryParams.set('transparent', '1');
    const queryString = queryParams.toString();

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/presentation.html?${queryString}`);
    } else {
      win.loadFile(join(__dirname, '../renderer/presentation.html'), { search: queryString });
    }

    win.once('ready-to-show', () => {
      this.recreating.delete(id);
      win.show();
      if (config.fullscreen) win.setFullScreen(true);
      // Re-send the last broadcast content to the new window
      if (this.lastBroadcastContent) {
        const windowContent: PresentationContentIPC = {
          ...this.lastBroadcastContent,
          displayMode: managed.config.displayMode || this.lastBroadcastContent.displayMode,
          windowName: managed.config.name || this.lastBroadcastContent.windowName,
        };
        this._sendContent(managed, windowContent);
      }
    });

    win.on('closed', () => {
      if (!this.recreating.has(id)) {
        this.windows.delete(id);
      }
    });

    // Replace window in-place
    managed.browserWindow = win;
    managed.frozen = false;
    managed.isBlack = false;
    managed.queuedContent = null;
    managed.lastSentPayload = null;
  }

  private _sendContent(managed: ManagedWindow, content: PresentationContentIPC): void {
    if (managed.browserWindow.isDestroyed()) return;
    // Dedupe — skip the IPC roundtrip + structured clone if the payload is identical
    // to the last one we sent to this window. This is the single biggest perf win
    // for line/block switches because the renderer broadcasts the FULL content on
    // every change.
    let serialized: string;
    try {
      serialized = JSON.stringify(content);
    } catch {
      serialized = '';
    }
    if (serialized && serialized === managed.lastSentPayload) return;
    managed.lastSentPayload = serialized;
    managed.browserWindow.webContents.send('presentation-update', {
      type: 'UPDATE_PRESENTATION',
      props: { content },
    });
  }

  private _forEachByName(windowName: string | undefined, callback: (managed: ManagedWindow) => void): void {
    for (const [, managed] of this.windows) {
      if (managed.browserWindow.isDestroyed()) continue;
      if (!windowName || managed.config.name === windowName) {
        callback(managed);
      }
    }
  }
}
