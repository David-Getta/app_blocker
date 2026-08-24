// Electron entry. Two modes:
//   normal        -> the GUI window
//   `--helper`    -> headless privileged helper (Windows SYSTEM task launches
//                    the same exe with this flag; macOS uses ELECTRON_RUN_AS_NODE
//                    + dist/helper/index.js directly, bypassing this file)

import { app, BrowserWindow, ipcMain } from 'electron';
import { registerSyncServerIpc } from './sync-server';
import { registerRulesBridge, stopRulesBridge } from './rules-bridge-ipc';
import { hideOverlay, registerOverlayShortcut, toggleOverlay, unregisterOverlayShortcut } from './overlay';
import * as path from 'path';
import { HelperClient } from './helper-client';
import { installHelper } from './install';
import { initUpdater } from './updater';
import { UsageTracker } from './tracker';
import type { StatusData } from '../shared/protocol';

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
      title: 'Breaker',
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
      ipcMain.handle('breaker:call', async (_e, op: string, payload: Record<string, unknown>) => {
        try {
          return { ok: true, data: await client.call(op, payload ?? {}) };
        } catch (err) {
          const e = err as Error & { code?: string };
          return { ok: false, error: e.message, code: e.code ?? e.message };
        }
      });

      ipcMain.handle('breaker:install', async () => {
        try {
          await installHelper();
          return { ok: true };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      });

      createWindow();
      initUpdater();

      // Active-time measurement runs in this (user-session) process; the helper
      // stores what it measures. Off until the helper says it is enabled.
      let usageEnabled = false;
      void client.call('status').then((s) => { usageEnabled = (s as StatusData).usageEnabled; })
        .catch(() => { /* helper not installed yet */ });
      const tracker = new UsageTracker({
        send: async (samples) => {
          try {
            await client.call('usage_batch', { samples });
            return true;
          } catch {
            return false; // helper down: keep buffering, retry on the next flush
          }
        },
        isEnabled: () => usageEnabled,
        log: (m) => console.log(`[breaker-tracker] ${m}`),
      });
      tracker.start();
      // A mérés csendben elhasalhat: macOS-en, ha a felhasználó megtagadja az
      // automatizálási engedélyt, az előtér-szonda örökre üres marad. Ezt a
      // felület kiírja, ezért kell egy lekérdezhető állapot.
      ipcMain.handle('breaker:tracker-state', () => ({
        blocked: tracker.probeBlocked,
        neverWorked: tracker.probeNeverWorked,
        platform: process.platform,
      }));
      // A szinkron-kiszolgáló EBBEN az appban is elindítható. Enélkül a
      // szinkron papíron létezik, gyakorlatban nem: terminált nyitni és külön
      // szolgáltatást futtatni a legtöbben nem fognak — és igazuk lenne.
      registerSyncServerIpc(app.getPath('userData'));
      // A böngésző-bővítmény innen veszi a részleges szabályokat. Enélkül
      // ugyanazt kétszer kellene begépelni, két külön listába — és ami kétszer
      // van, az előbb-utóbb szétcsúszik.
      registerRulesBridge(
        app.getPath('userData'),
        async () => {
          const s = await client.call('status') as StatusData;
          const out: { host: string; path: string }[] = [];
          for (const site of s.sites ?? []) {
            for (const r of site.rules ?? []) out.push({ host: r.host, path: r.path });
          }
          return out;
        },
        async () => {
          // A futó munkamenet FEHÉRLISTA: a böngésző az egyetlen hely, ahol ezt
          // érvényesíteni lehet. A DNS a hosztnévnél tovább nem lát, és a
          // „mindent tilts, kivéve ötöt” egy hosts-fájlban nem leírható.
          const s = await client.call('status') as StatusData;
          const run = s.focusRun;
          if (!run) return { running: false };
          const pack = (s.focusPacks ?? []).find((p) => p.id === run.packId);
          return {
            running: true,
            name: pack?.name,
            endsAt: run.endsAt,
            allowSites: pack?.allowSites ?? [],
          };
        },
      );
      // Keep the tracker's view of the switch fresh without extra IPC chatter.
      setInterval(() => {
        void client.call('status')
          .then((s) => { usageEnabled = (s as StatusData).usageEnabled; })
          .catch(() => { /* ignore */ });
      }, 60_000);
      // A gyorsbillentyűs réteg: egy mozdulattal indítható munkamenet. A
      // regisztráció elbukhat (másik program elvette a kombinációt) — ez nem
      // hiba, a felület megmondja, és a réteg az appból is nyitható.
      const shortcutOk = registerOverlayShortcut();
      ipcMain.handle('breaker:overlay-state', () => ({ shortcutOk }));
      ipcMain.handle('breaker:overlay-toggle', () => { toggleOverlay(); });
      ipcMain.handle('breaker:overlay-hide', () => { hideOverlay(); });

      app.on('before-quit', () => {
        tracker.stop();
        stopRulesBridge();
        unregisterOverlayShortcut();
      });
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
