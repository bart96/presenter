/**
 * Preload script for presentation BrowserWindows.
 * Exposes a minimal API for receiving content updates from the main process via IPC.
 */
import { contextBridge, ipcRenderer } from 'electron';

const presentationApi = {
  /**
   * Register a callback for content updates from the main process.
   */
  onContentUpdate: (callback: (data: unknown) => void) => {
    ipcRenderer.on('presentation-update', (_event, data) => {
      callback(data);
    });
  },

  /**
   * Register a callback for presentation commands (fade, identify, etc.).
   */
  onCommand: (callback: (data: unknown) => void) => {
    ipcRenderer.on('presentation-command', (_event, data) => {
      callback(data);
    });
  },

  /**
   * Register a callback for stage-overlay updates.
   *
   * Separate from `onContentUpdate` on purpose: the overlay has its own lifetime, so a cue
   * change must not re-send the slide and a slide change must not disturb a running timer.
   */
  onStageUpdate: (callback: (data: unknown) => void) => {
    ipcRenderer.on('presentation-stage', (_event, data) => {
      callback(data);
    });
  },

  /**
   * Tell the main process this window's React app is mounted and listening.
   * Content sent before this point was lost — main replays the last payload on it.
   */
  signalReady: () => {
    ipcRenderer.send('presentation-ready');
  },

  /**
   * Remove all listeners (for cleanup).
   */
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('presentation-update');
    ipcRenderer.removeAllListeners('presentation-command');
    ipcRenderer.removeAllListeners('presentation-stage');
  },

  /**
   * Report video playback status back to the main window.
   */
  reportVideoStatus: (status: {
    hasVideo: boolean;
    paused?: boolean;
    muted?: boolean;
    loop?: boolean;
    volume?: number;
    currentTime?: number;
    duration?: number;
    windowName?: string;
  }) => {
    ipcRenderer.send('video-status', status);
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('presentationApi', presentationApi);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore — no contextIsolation here, so the API is attached to the real window
  window.presentationApi = presentationApi;
}
