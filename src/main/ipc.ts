/**
 * IPC handler registrations for the Electron main process (§7.2).
 * All ipcMain.handle calls are registered here.
 */
import { ipcMain, BrowserWindow, dialog, shell, app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { existsSync } from 'fs';
import { pathToFileURL } from 'url';
import { PresentationWindowManager } from './windows';
import type { WindowConfig, MusicianViewConfig, PresentationContentIPC, SettingsDiff } from '../shared/types';
import { storeCredentials, getCredentials, deleteCredentials, isEncryptionAvailable } from './credentials';

export const registerIpcHandlers = (windowManager: PresentationWindowManager) => {
  // ── Basic window controls ──

  ipcMain.handle('window-minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.minimize();
  });

  ipcMain.handle('window-close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.close();
  });

  ipcMain.handle('window-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
    }
  });

  // ── App info ──

  ipcMain.handle('get-app-version', () => {
    return app.getVersion();
  });

  ipcMain.handle('check-for-updates', async () => {
    if (app.isPackaged) {
      try {
        const result = await autoUpdater.checkForUpdates();
        return {
          updateAvailable: result?.isUpdateAvailable ?? false,
          isTokenAvailable: !!process.env.GH_TOKEN,
          version: result?.updateInfo.version,
          releaseDate: result?.updateInfo.releaseDate,
          releaseNotes: result?.updateInfo.releaseNotes,
        };
      } catch {
        return {
          updateAvailable: false,
          isTokenAvailable: !!process.env.GH_TOKEN,
        };
      }
    }
    return {
      updateAvailable: false,
      isTokenAvailable: !!process.env.GH_TOKEN,
    };
  });

  // ── File system ──

  ipcMain.handle('open-directory', async (_event, path: string) => {
    try {
      await shell.openPath(path);
      return true;
    } catch {
      return false;
    }
  });

  // Native file picker — returns { path, url } or null if cancelled.
  ipcMain.handle('pick-file', async (event, options: { title?: string; filters?: Electron.FileFilter[]; defaultPath?: string } = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await dialog.showOpenDialog(win as BrowserWindow, {
      title: options.title ?? 'Select File',
      properties: ['openFile'],
      filters: options.filters,
      defaultPath: options.defaultPath,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const path = result.filePaths[0];
    return { path, url: pathToFileURL(path).toString() };
  });

  // Native folder picker — returns the absolute path or null if cancelled.
  ipcMain.handle('pick-directory', async (event, options: { title?: string; defaultPath?: string } = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await dialog.showOpenDialog(win as BrowserWindow, {
      title: options.title ?? 'Select Folder',
      properties: ['openDirectory'],
      defaultPath: options.defaultPath,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Apply runtime updates to an existing presentation window.
  ipcMain.handle('update-window-config', (_event, id: string, partial: Partial<WindowConfig>) => {
    return windowManager.updateWindowConfig(id, partial);
  });

  // ── Presentation window management ──

  ipcMain.handle('create-presentation-window', (_event, windowConfig: WindowConfig) => {
    return windowManager.createPresentationWindow(windowConfig);
  });

  ipcMain.handle('close-presentation-window', (_event, id: string) => {
    windowManager.closePresentationWindow(id);
  });

  ipcMain.handle('focus-presentation-window', (_event, id: string) => {
    windowManager.focusPresentationWindow(id);
  });

  ipcMain.handle('hide-presentation-window', (_event, id: string) => {
    windowManager.hidePresentationWindow(id);
  });

  ipcMain.handle('show-presentation-window', (_event, id: string) => {
    windowManager.showPresentationWindow(id);
  });

  ipcMain.on('update-presentation-content', (_event, id: string, content: PresentationContentIPC) => {
    windowManager.updatePresentationContent(id, content);
  });

  // The stage overlay rides its own channel rather than the content payload, so a running
  // countdown never re-serializes the current slide. See presentationBridge.broadcastStage.
  ipcMain.on('update-stage-overlay', (_event, id: string, payload: unknown) => {
    windowManager.sendStageOverlay(id, payload);
  });

  // A presentation window's renderer signals its listeners are attached — replay
  // the content it may have missed during bootstrap (fixes black windows on start).
  ipcMain.on('presentation-ready', (event) => {
    windowManager.handlePresentationReady(event.sender);
  });

  ipcMain.on('broadcast-presentation-content', (_event, content: PresentationContentIPC) => {
    windowManager.broadcastContent(content);
  });

  ipcMain.handle('list-screens', () => {
    return windowManager.listScreens();
  });

  ipcMain.handle('get-window-states', () => {
    return windowManager.getWindowStates();
  });

  // ── Window actions ──

  ipcMain.handle('fade-to-black', (_event, windowName?: string) => {
    windowManager.fadeToBlack(windowName);
  });

  ipcMain.handle('fade-from-black', (_event, windowName?: string) => {
    windowManager.fadeFromBlack(windowName);
  });

  ipcMain.handle('freeze-window', (_event, windowName: string) => {
    windowManager.freezeWindow(windowName);
  });

  ipcMain.handle('unfreeze-window', (_event, windowName: string) => {
    windowManager.unfreezeWindow(windowName);
  });

  ipcMain.handle('identify-windows', () => {
    windowManager.identifyWindows();
  });

  ipcMain.handle('hide-identify-windows', () => {
    windowManager.hideIdentifyWindows();
  });

  // ── Video commands (forwarded to presentation windows) ──

  ipcMain.handle(
    'video-command',
    (_event, command: { action: string; windowName?: string; value?: number; fadeDuration?: number; target?: string }) => {
      windowManager.sendVideoCommand(command.action, command.windowName, command.value, command.fadeDuration, command.target);
    },
  );

  ipcMain.handle(
    'set-video-visible',
    (_event, payload: { windowName?: string; value?: boolean; mode?: 'cut' | 'fade'; durationMs?: number } = {}) => {
      windowManager.setVideoVisible(payload.windowName, payload.value, payload.mode, payload.durationMs);
    },
  );

  // Forward video status from presentation windows to the main renderer
  ipcMain.on('video-status', (_event, status) => {
    const allWindows = BrowserWindow.getAllWindows();
    // The main window is the one that is NOT a presentation window — typically the first one
    for (const win of allWindows) {
      if (!win.isDestroyed() && win.webContents.id !== _event.sender.id) {
        win.webContents.send('video-status-update', status);
      }
    }
  });

  // ── Media file checks ──

  ipcMain.handle('check-media-files', (_event, files: string[]) => {
    const result: Record<string, boolean> = {};
    for (const file of files) {
      result[file] = existsSync(file);
    }
    return result;
  });

  // ── Musician IPC sync — forwards musician navigation state to the operator (main) window ──
  ipcMain.on('musician-sync-to-operator', (_event, data) => {
    const allWindows = BrowserWindow.getAllWindows();
    // The main (operator) window is the one that did NOT send this message
    for (const win of allWindows) {
      if (!win.isDestroyed() && win.webContents.id !== _event.sender.id) {
        win.webContents.send('musician-sync-from-ipc', data);
      }
    }
  });

  // ── Musician view ──

  ipcMain.handle('open-musician-view', (_event, viewConfig: MusicianViewConfig) => {
    return windowManager.openMusicianView(viewConfig);
  });

  // ── Settings export/import (§7.5) ──

  ipcMain.handle('export-settings', async (event) => {
    // Request settings from renderer
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;

    // Ask renderer to collect all presenter_* settings
    const settings = await win.webContents.executeJavaScript(`
      (() => {
        const result = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith('presenter_')) {
            result[key] = localStorage.getItem(key);
          }
        }
        return result;
      })()
    `);

    // Show save dialog
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export Settings',
      defaultPath: 'presenter-settings.json',
      filters: [{ name: 'JSON Files', extensions: ['json'] }],
    });

    if (canceled || !filePath) return null;

    // Write the file
    const { writeFileSync } = await import('fs');
    writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf-8');
    return filePath;
  });

  ipcMain.handle('import-settings', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;

    // Show open dialog
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Import Settings',
      filters: [{ name: 'JSON Files', extensions: ['json'] }],
      properties: ['openFile'],
    });

    if (canceled || filePaths.length === 0) return null;

    // Read and parse the file
    const { readFileSync } = await import('fs');
    const content = readFileSync(filePaths[0], 'utf-8');
    const imported = JSON.parse(content) as Record<string, string>;

    // Get current settings from renderer
    const current = (await win.webContents.executeJavaScript(`
      (() => {
        const result = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith('presenter_')) {
            result[key] = localStorage.getItem(key);
          }
        }
        return result;
      })()
    `)) as Record<string, string>;

    // Compute diff
    const diff: SettingsDiff = {
      added: {},
      changed: {},
      removed: [],
    };

    for (const [key, value] of Object.entries(imported)) {
      if (!(key in current)) {
        diff.added[key] = value;
      } else if (current[key] !== value) {
        diff.changed[key] = { old: current[key], new: value };
      }
    }

    for (const key of Object.keys(current)) {
      if (!(key in imported)) {
        diff.removed.push(key);
      }
    }

    return diff;
  });

  ipcMain.handle('apply-imported-settings', async (event, diff: SettingsDiff) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;

    // Apply the diff in the renderer's localStorage
    await win.webContents.executeJavaScript(`
      (() => {
        const diff = ${JSON.stringify(diff)};
        // Add new settings
        for (const [key, value] of Object.entries(diff.added)) {
          localStorage.setItem(key, value);
        }
        // Update changed settings
        for (const [key, entry] of Object.entries(diff.changed)) {
          localStorage.setItem(key, entry.new);
        }
        // Note: we don't remove settings during import — only add/change
      })()
    `);

    // Reload the window to apply settings
    win.webContents.reload();
  });

  // A renderer's localStorage writes sit in memory until Chromium commits them lazily, so the
  // renderer asks for an immediate commit after saving — otherwise a crash or a Windows
  // restart takes the last settings with it (see renderer store/persist.ts).
  ipcMain.on('flush-storage', (event) => {
    event.sender.session.flushStorageData();
  });

  // ── System fonts ──
  ipcMain.handle('get-system-fonts', async () => {
    try {
      // Require font-list dynamically at runtime. Some bundlers may break
      // static imports for font-list's internal files, so load it lazily and
      // guard with try/catch.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fontList = require('font-list');
      const fonts: string[] = await fontList.getFonts();
      // font-list returns names wrapped in quotes on some platforms; strip them
      return fonts.map((f: string) => f.replace(/^"|"$/g, ''));
    } catch (err) {
      console.error('Failed to enumerate system fonts (font-list unavailable):', err);
      return [];
    }
  });

  // ── Auto-updater: install now ──

  ipcMain.handle('install-update', () => {
    autoUpdater.quitAndInstall(false, true);
  });

  // ── Secure credential storage (Electron only, safeStorage) ──

  ipcMain.handle('is-encryption-available', () => {
    return isEncryptionAvailable();
  });

  ipcMain.handle('store-credentials', (_event, username: string, password: string) => {
    return storeCredentials(username, password);
  });

  ipcMain.handle('get-credential-username', () => {
    return getCredentials()?.username ?? null;
  });

  ipcMain.handle('delete-credentials', () => {
    deleteCredentials();
    return true;
  });
};
