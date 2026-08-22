// Automatic updates for the desktop app, exactly like an app store: the app
// checks GitHub Releases on launch (and every few hours), downloads new versions
// in the background, and installs them on quit / when the user clicks "restart".
//
// Signing note:
//  - Windows (NSIS): auto-update works unsigned, though SmartScreen may warn on
//    first install. A code-signing cert removes the warning.
//  - macOS: Squirrel.Mac REQUIRES a valid Developer ID signature + notarization
//    for auto-update to apply. Unsigned builds still run, but won't self-update;
//    the app falls back to opening the Releases page. See docs/releasing.md.

import { app, BrowserWindow, ipcMain, shell } from 'electron';

const RELEASES_URL = 'https://github.com/David-Getta/app_blocker/releases/latest';
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;

interface UpdaterState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error' | 'unsupported';
  version?: string;
  percent?: number;
  error?: string;
}

let state: UpdaterState = { status: 'idle' };

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('lakat:update-state', state);
  }
}

function set(next: Partial<UpdaterState>): void {
  state = { ...state, ...next };
  broadcast();
}

export function currentUpdateState(): UpdaterState {
  return state;
}

export function initUpdater(): void {
  // Never block startup on the network; wire everything lazily.
  let autoUpdater: import('electron-updater').AppUpdater;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    autoUpdater = require('electron-updater').autoUpdater;
  } catch {
    set({ status: 'unsupported', error: 'Az electron-updater nem érhető el.' });
    return;
  }

  // In dev (no packaged app) there is nothing to update.
  if (!app.isPackaged) {
    set({ status: 'idle' });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => set({ status: 'checking' }));
  autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => set({ status: 'idle' }));
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => {
    // Only surface an error state when a newer version was actually detected
    // (e.g. unsigned macOS cannot apply it) — a plain network hiccup while
    // checking must not tell the user to go download anything.
    const message = err == null ? 'ismeretlen hiba' : String(err.message ?? err);
    if (state.version) set({ status: 'error', error: message });
    else set({ status: 'idle', error: message });
  });

  ipcMain.handle('lakat:check-update', async () => {
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle('lakat:install-update', () => {
    if (state.status === 'ready') {
      autoUpdater.quitAndInstall();
      return { ok: true };
    }
    // Not downloadable (e.g. unsigned macOS) -> open the Releases page.
    void shell.openExternal(RELEASES_URL);
    return { ok: true, opened: true };
  });

  ipcMain.handle('lakat:update-state', () => state);

  const kick = () => { void autoUpdater.checkForUpdates().catch(() => { /* logged via event */ }); };
  setTimeout(kick, 8_000);          // shortly after launch
  setInterval(kick, CHECK_INTERVAL_MS);
}
