// Electron entry. Two modes:
//   normal        -> the GUI window
//   `--helper`    -> headless privileged helper (Windows SYSTEM task launches
//                    the same exe with this flag; macOS uses ELECTRON_RUN_AS_NODE
//                    + dist/helper/index.js directly, bypassing this file)

import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { HelperClient } from './helper-client';
import { installHelper } from './install';

const HELPER_MODE = process.argv.includes('--helper');

if (HELPER_MODE) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { runHelper } = require('../helper/index') as typeof import('../helper/index');
  app.whenReady().then(() => {
    runHelper();
  });
  // No window, no dock icon, never quit on window-all-closed.
  app.on('window-all-closed', () => { /* keep running */ });
} else {
  const client = new HelperClient();

  const createWindow = () => {
    const win = new BrowserWindow({
      width: 1060,
      height: 760,
      minWidth: 780,
      minHeight: 560,
      title: 'Lakat',
      backgroundColor: '#101418',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setMenuBarVisibility(false);
    void win.loadFile(path.join(__dirname, '..', 'ui', 'renderer', 'index.html'));
  };

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      const [win] = BrowserWindow.getAllWindows();
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });

    app.whenReady().then(() => {
      ipcMain.handle('lakat:call', async (_e, op: string, payload: Record<string, unknown>) => {
        try {
          return { ok: true, data: await client.call(op, payload ?? {}) };
        } catch (err) {
          const e = err as Error & { code?: string };
          return { ok: false, error: e.message, code: e.code ?? e.message };
        }
      });

      ipcMain.handle('lakat:install', async () => {
        try {
          await installHelper();
          return { ok: true };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      });

      createWindow();
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    });

    app.on('window-all-closed', () => {
      // Blocking is enforced by the helper daemon, not by this window,
      // so quitting the GUI is always safe.
      app.quit();
    });
  }
}
