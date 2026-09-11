import { contextBridge, ipcRenderer } from 'electron';
import { electronAPI } from '@electron-toolkit/preload';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { MusicianViewConfig } from '../shared/types';

// The renderer directory as a file:// URL — reliable inside asar bundles because
// __dirname in the preload always resolves correctly via Electron's module system.
// Using pathToFileURL handles Windows drive letters and backslashes correctly.
const rendererDir = pathToFileURL(join(__dirname, '../renderer')).toString().replace(/\/?$/, '/');

// Custom APIs for renderer — full ElectronAPI per §7.3
const api = {
  // ── Renderer path (for building correct file:// URLs inside asar) ──
  rendererDir,
  // ── Basic window controls ──
  minimize: () => electronAPI.ipcRenderer.invoke('window-minimize'),
  close: () => electronAPI.ipcRenderer.invoke('window-close'),
  maximize: () => electronAPI.ipcRenderer.invoke('window-maximize'),

  // ── App info ──
  getAppVersion: () => electronAPI.ipcRenderer.invoke('get-app-version'),
  checkForUpdates: () => electronAPI.ipcRenderer.invoke('check-for-updates'),

  // ── System ──
  getSystemFonts: () => electronAPI.ipcRenderer.invoke('get-system-fonts'),

  // ── File system ──
  openDirectory: (path: string) => electronAPI.ipcRenderer.invoke('open-directory', path),
  pickFile: (options?: { title?: string; filters?: { name: string; extensions: string[] }[]; defaultPath?: string }) =>
    electronAPI.ipcRenderer.invoke('pick-file', options ?? {}),
  pickDirectory: (options?: { title?: string; defaultPath?: string }) => electronAPI.ipcRenderer.invoke('pick-directory', options ?? {}),

  // ── Presentation window management ──
  createPresentationWindow: (config: unknown) => electronAPI.ipcRenderer.invoke('create-presentation-window', config),
  closePresentationWindow: (id: string) => electronAPI.ipcRenderer.invoke('close-presentation-window', id),
  focusPresentationWindow: (id: string) => electronAPI.ipcRenderer.invoke('focus-presentation-window', id),
  hidePresentationWindow: (id: string) => electronAPI.ipcRenderer.invoke('hide-presentation-window', id),
  showPresentationWindow: (id: string) => electronAPI.ipcRenderer.invoke('show-presentation-window', id),
  updateWindowConfig: (id: string, partial: unknown) => electronAPI.ipcRenderer.invoke('update-window-config', id, partial),
  updatePresentationContent: (id: string, content: unknown) => {
    ipcRenderer.send('update-presentation-content', id, content);
  },
  updateStageOverlay: (id: string, payload: unknown) => {
    ipcRenderer.send('update-stage-overlay', id, payload);
  },
  broadcastPresentationContent: (content: unknown) => {
    ipcRenderer.send('broadcast-presentation-content', content);
  },
  listScreens: () => electronAPI.ipcRenderer.invoke('list-screens'),
  getWindowStates: () => electronAPI.ipcRenderer.invoke('get-window-states'),

  // ── Window actions ──
  fadeToBlack: (windowName?: string) => electronAPI.ipcRenderer.invoke('fade-to-black', windowName),
  fadeFromBlack: (windowName?: string) => electronAPI.ipcRenderer.invoke('fade-from-black', windowName),
  freezeWindow: (windowName: string) => electronAPI.ipcRenderer.invoke('freeze-window', windowName),
  unfreezeWindow: (windowName: string) => electronAPI.ipcRenderer.invoke('unfreeze-window', windowName),
  identifyWindows: () => electronAPI.ipcRenderer.invoke('identify-windows'),
  hideIdentifyWindows: () => electronAPI.ipcRenderer.invoke('hide-identify-windows'),

  // ── Video commands ──
  videoCommand: (command: { action: string; windowName?: string; value?: number; fadeDuration?: number; target?: string }) =>
    electronAPI.ipcRenderer.invoke('video-command', command),
  setVideoVisible: (payload?: { windowName?: string; value?: boolean; mode?: 'cut' | 'fade'; durationMs?: number }) =>
    electronAPI.ipcRenderer.invoke('set-video-visible', payload || {}),

  // ── Media ──
  checkMediaFiles: (files: string[]) => electronAPI.ipcRenderer.invoke('check-media-files', files),
  getMediaServerUrl: () => electronAPI.ipcRenderer.invoke('get-media-server-url'),
  startMediaServer: (mediaPath: string) => electronAPI.ipcRenderer.invoke('start-media-server', mediaPath),

  // ── Built-in WebSocket server status ──
  getWsServerInfo: () => electronAPI.ipcRenderer.invoke('get-ws-server-info'),
  setWsCommandHandlingEnabled: (enabled: boolean) => electronAPI.ipcRenderer.invoke('set-ws-command-handling-enabled', enabled),
  onWsClientCount: (callback: (data: { count: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data as { count: number });
    ipcRenderer.on('ws-client-count', handler);
    return () => ipcRenderer.removeListener('ws-client-count', handler);
  },
  onWsLastCommand: (
    callback: (data: { action: string; target?: string; payload?: Record<string, unknown>; receivedAt: number }) => void,
  ) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
      callback(data as { action: string; target?: string; payload?: Record<string, unknown>; receivedAt: number });
    ipcRenderer.on('ws-last-command', handler);
    return () => ipcRenderer.removeListener('ws-last-command', handler);
  },
  onWsNavigationAction: (callback: (data: { action: string; payload?: Record<string, unknown> }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
      callback(data as { action: string; payload?: Record<string, unknown> });
    ipcRenderer.on('ws-navigation-action', handler);
    return () => ipcRenderer.removeListener('ws-navigation-action', handler);
  },
  onWsVideoAction: (callback: (data: { action: string; target?: string; payload?: Record<string, unknown> }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
      callback(data as { action: string; target?: string; payload?: Record<string, unknown> });
    ipcRenderer.on('ws-video-action', handler);
    return () => ipcRenderer.removeListener('ws-video-action', handler);
  },
  wsBroadcastState: (data: Record<string, unknown>) => {
    ipcRenderer.send('ws-broadcast-state', data);
  },

  // ── Musician view ──
  openMusicianView: (config?: MusicianViewConfig) => electronAPI.ipcRenderer.invoke('open-musician-view', config || {}),

  // ── Settings export/import ──
  exportSettings: () => electronAPI.ipcRenderer.invoke('export-settings'),
  importSettings: () => electronAPI.ipcRenderer.invoke('import-settings'),
  applyImportedSettings: (diff: unknown) => electronAPI.ipcRenderer.invoke('apply-imported-settings', diff),
  // Commit pending localStorage writes to disk now (see renderer store/persist.ts).
  flushStorage: () => ipcRenderer.send('flush-storage'),

  // ── Auto-updater ──
  installUpdate: () => electronAPI.ipcRenderer.invoke('install-update'),
  onUpdaterUpdateAvailable: (callback: (info: { version: string; releaseDate: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data as { version: string; releaseDate: string });
    ipcRenderer.on('updater-update-available', handler);
    return () => ipcRenderer.removeListener('updater-update-available', handler);
  },
  onUpdaterUpdateNotAvailable: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('updater-update-not-available', handler);
    return () => ipcRenderer.removeListener('updater-update-not-available', handler);
  },
  onUpdaterDownloadProgress: (callback: (progress: { percent: number; transferred: number; total: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
      callback(data as { percent: number; transferred: number; total: number });
    ipcRenderer.on('updater-download-progress', handler);
    return () => ipcRenderer.removeListener('updater-download-progress', handler);
  },
  onUpdaterUpdateDownloaded: (callback: (info: { version: string; releaseDate: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data as { version: string; releaseDate: string });
    ipcRenderer.on('updater-update-downloaded', handler);
    return () => ipcRenderer.removeListener('updater-update-downloaded', handler);
  },
  onUpdaterError: (callback: (info: { message: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data as { message: string });
    ipcRenderer.on('updater-error', handler);
    return () => ipcRenderer.removeListener('updater-error', handler);
  },

  // ── Backend origin (for OIDC callback detection in main process) ──
  setBackendOrigin: (origin: string) => ipcRenderer.send('set-backend-origin', origin),

  // ── Auto-login preference mirror (so the IdP auto-fill script can submit) ──
  setAutoLogin: (enabled: boolean) => ipcRenderer.send('set-auto-login', enabled),

  // ── Secure credential storage (Electron only) ──
  isEncryptionAvailable: () => electronAPI.ipcRenderer.invoke('is-encryption-available'),
  storeCredentials: (username: string, password: string) => electronAPI.ipcRenderer.invoke('store-credentials', username, password),
  getCredentialUsername: () => electronAPI.ipcRenderer.invoke('get-credential-username'),
  deleteCredentials: () => electronAPI.ipcRenderer.invoke('delete-credentials'),

  // ── Musician IPC sync — lets the musician window push navigation state
  //    directly to the operator window via the main process (bypasses WS relay) ──
  musicianSyncToOperator: (data: unknown) => ipcRenderer.send('musician-sync-to-operator', data),
  onMusicianSyncFromIpc: (callback: (data: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on('musician-sync-from-ipc', handler);
    return () => ipcRenderer.removeListener('musician-sync-from-ipc', handler);
  },

  // ── Video status from presentation windows ──
  onVideoStatus: (callback: (status: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on('video-status-update', handler);
    return () => {
      ipcRenderer.removeListener('video-status-update', handler);
    };
  },

  // ── IPC event listeners (main -> renderer) ──
  onPresentationWindowBoundsChanged: (
    callback: (data: { id: string; bounds: { x: number; y: number; width: number; height: number } }) => void,
  ) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
      callback(data as { id: string; bounds: { x: number; y: number; width: number; height: number } });
    ipcRenderer.on('presentation-window-bounds-changed', handler);
    return () => {
      ipcRenderer.removeListener('presentation-window-bounds-changed', handler);
    };
  },

  onPresentationWindowReady: (callback: (data: { id: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data as { id: string });
    ipcRenderer.on('presentation-window-ready', handler);
    return () => {
      ipcRenderer.removeListener('presentation-window-ready', handler);
    };
  },
};

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI);
    contextBridge.exposeInMainWorld('api', api);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI;
  // @ts-ignore (define in dts)
  window.api = api;
}
