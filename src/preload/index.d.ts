import { ElectronAPI } from '@electron-toolkit/preload';
import type {
  WindowConfig,
  WindowState,
  ScreenInfo,
  MediaCheckResult,
  SettingsDiff,
  MusicianViewConfig,
  UpdateInfo,
  PresentationContentIPC,
} from '../shared/types';

export interface FrontendAPI {
  // ── Renderer path (for building correct file:// URLs inside asar) ──
  rendererDir: string;
  // ── Basic window controls ──
  minimize: () => Promise<void>;
  close: () => Promise<void>;
  maximize: () => Promise<void>;

  // ── App info ──
  getAppVersion: () => Promise<string>;
  checkForUpdates: () => Promise<UpdateInfo>;

  // ── System ──
  getSystemFonts: () => Promise<string[]>;

  // ── File system ──
  openDirectory: (path: string) => Promise<boolean>;
  pickFile: (options?: {
    title?: string;
    filters?: { name: string; extensions: string[] }[];
    defaultPath?: string;
  }) => Promise<{ path: string; url: string } | null>;
  pickDirectory: (options?: { title?: string; defaultPath?: string }) => Promise<string | null>;

  // ── Presentation window management ──
  createPresentationWindow: (config: WindowConfig) => Promise<string>;
  closePresentationWindow: (id: string) => Promise<void>;
  // These three have been exposed by the preload since presentation windows existed but were
  // never declared, so every call site reached them through an `any` cast.
  focusPresentationWindow: (id: string) => Promise<void>;
  hidePresentationWindow: (id: string) => Promise<void>;
  showPresentationWindow: (id: string) => Promise<void>;
  updateWindowConfig: (id: string, partial: Partial<WindowConfig>) => Promise<{ applied: string[]; requiresReload: string[] }>;
  updatePresentationContent: (id: string, content: PresentationContentIPC) => void;
  /** Stage-monitor overlay for one window; its own channel, see presentationBridge. */
  updateStageOverlay: (id: string, payload: unknown) => void;
  broadcastPresentationContent: (content: PresentationContentIPC) => void;
  listScreens: () => Promise<ScreenInfo[]>;
  getWindowStates: () => Promise<WindowState[]>;

  // ── Window actions ──
  fadeToBlack: (windowName?: string) => Promise<void>;
  fadeFromBlack: (windowName?: string) => Promise<void>;
  freezeWindow: (windowName: string) => Promise<void>;
  unfreezeWindow: (windowName: string) => Promise<void>;
  identifyWindows: () => Promise<void>;
  hideIdentifyWindows: () => Promise<void>;

  // ── Video commands ──
  videoCommand: (command: { action: string; windowName?: string; value?: number; fadeDuration?: number; target?: string }) => Promise<void>;
  setVideoVisible: (payload?: { windowName?: string; value?: boolean; mode?: 'cut' | 'fade'; durationMs?: number }) => Promise<void>;

  // ── Media ──
  checkMediaFiles: (files: string[]) => Promise<MediaCheckResult>;
  getMediaServerUrl: () => Promise<string>;
  startMediaServer: (mediaPath: string) => Promise<string>;

  // ── Musician view ──
  openMusicianView: (config?: MusicianViewConfig) => Promise<string>;

  // ── Settings export/import ──
  exportSettings: () => Promise<string | null>;
  importSettings: () => Promise<SettingsDiff | null>;
  applyImportedSettings: (diff: SettingsDiff) => Promise<void>;
  /** Commit pending localStorage writes to disk now, instead of whenever Chromium gets to it. */
  flushStorage: () => void;

  // ── WebSocket network scan ──
  scanWsHosts: (url: string) => Promise<string[]>;

  // ── Built-in WebSocket server status ──
  getWsServerInfo: () => Promise<{ hosts: string[]; port: number; clientCount: number; commandHandlingEnabled: boolean }>;
  setWsCommandHandlingEnabled: (enabled: boolean) => Promise<boolean>;
  onWsClientCount: (callback: (data: { count: number }) => void) => (() => void) | void;
  onWsLastCommand: (
    callback: (data: { action: string; target?: string; payload?: Record<string, unknown>; receivedAt: number }) => void,
  ) => (() => void) | void;
  onWsNavigationAction: (callback: (data: { action: string; payload?: Record<string, unknown> }) => void) => (() => void) | void;
  onWsVideoAction: (
    callback: (data: { action: string; target?: string; payload?: Record<string, unknown> }) => void,
  ) => (() => void) | void;
  wsBroadcastState: (data: Record<string, unknown>) => void;

  // ── Auto-updater ──
  installUpdate: () => Promise<void>;
  onUpdaterUpdateAvailable: (callback: (info: { version: string; releaseDate: string }) => void) => (() => void) | void;
  onUpdaterUpdateNotAvailable: (callback: () => void) => (() => void) | void;
  onUpdaterDownloadProgress: (callback: (progress: { percent: number; transferred: number; total: number }) => void) => (() => void) | void;
  onUpdaterUpdateDownloaded: (callback: (info: { version: string; releaseDate: string }) => void) => (() => void) | void;
  onUpdaterError: (callback: (info: { message: string }) => void) => (() => void) | void;

  // ── Backend origin (for OIDC callback detection) ──
  setBackendOrigin: (origin: string) => void;

  // ── Auto-login preference mirror ──
  setAutoLogin: (enabled: boolean) => void;

  // ── Secure credential storage (Electron only) ──
  isEncryptionAvailable: () => Promise<boolean>;
  storeCredentials: (username: string, password: string) => Promise<boolean>;
  getCredentialUsername: () => Promise<string | null>;
  deleteCredentials: () => Promise<boolean>;

  // ── Musician IPC sync ──
  musicianSyncToOperator: (data: unknown) => void;
  onMusicianSyncFromIpc: (callback: (data: unknown) => void) => (() => void) | void;

  // ── Video status from presentation windows ──
  onVideoStatus: (callback: (status: VideoStatus) => void) => (() => void) | void;

  // ── IPC event listeners (main -> renderer) ──
  onPresentationWindowBoundsChanged: (
    callback: (data: { id: string; bounds: { x: number; y: number; width: number; height: number } }) => void,
  ) => (() => void) | void;
  /** A presentation window finished mounting — the operator should re-send current content. */
  onPresentationWindowReady: (callback: (data: { id: string }) => void) => (() => void) | void;
}

export interface VideoStatus {
  hasVideo: boolean;
  paused?: boolean;
  muted?: boolean;
  loop?: boolean;
  volume?: number;
  currentTime?: number;
  duration?: number;
  windowName?: string;
}

/** Presentation window preload API (separate preload script). */
export interface PresentationAPI {
  onContentUpdate: (callback: (data: unknown) => void) => void;
  onCommand: (callback: (data: unknown) => void) => void;
  /** Stage-overlay updates, on their own channel so cues and content never disturb each other. */
  onStageUpdate?: (callback: (data: unknown) => void) => void;
  /** Tells main this window's React app is mounted — main replays the last content on it. */
  signalReady?: () => void;
  removeAllListeners: () => void;
  reportVideoStatus?: (status: VideoStatus) => void;
}

declare global {
  interface Window {
    electron: ElectronAPI;
    api: FrontendAPI;
    presentationApi?: PresentationAPI;
  }
}
