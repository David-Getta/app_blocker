// Automatic updates for the desktop app, exactly like an app store: the app
// checks GitHub Releases on launch (and every few hours), downloads new versions
// in the background, and installs them when the user clicks "restart".
//
// Two engines, chosen once at startup:
//
//  - **electron-updater** (Squirrel) — Windows always, and macOS when the app
//    carries a Developer ID signature. This is the good path: differential
//    downloads, signature checks done by the OS.
//  - **the built-in macOS fallback** (mac-updater.ts) — an UNSIGNED macOS build.
//    Squirrel.Mac refuses to apply updates to such a build, so without this the
//    update button could only ever open a download page and leave the user
//    dragging bundles by hand. See mac-updater.ts for how it stays safe.
//
// Both are driven through the same tiny interface, so the UI never has to know
// which one it is talking to.

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
  appBundlePath, applyUpdate, checkMacUpdate, cleanupStaleUpdates, downloadUpdate,
  hasDeveloperIdSignature,
  type MacUpdate,
} from './mac-updater';

const RELEASES_URL = 'https://github.com/David-Getta/app_blocker/releases/latest';
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;

interface UpdaterState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error' | 'unsupported';
  version?: string;
  percent?: number;
  error?: string;
  /** true when this build updates itself without Squirrel (unsigned macOS) */
  selfManaged?: boolean;
}

interface Engine {
  check(): Promise<void>;
  install(): Promise<{ opened?: boolean }>;
}

let state: UpdaterState = { status: 'idle' };
let engine: Engine | null = null;

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('breaker:update-state', state);
  }
}

function set(next: Partial<UpdaterState>): void {
  state = { ...state, ...next };
  broadcast();
}

export function currentUpdateState(): UpdaterState {
  return state;
}

// ------------------------------------------------------- electron-updater

function squirrelEngine(): Engine | null {
  let autoUpdater: import('electron-updater').AppUpdater;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    autoUpdater = require('electron-updater').autoUpdater;
  } catch {
    return null;
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

  return {
    check: async () => { await autoUpdater.checkForUpdates(); },
    install: async () => {
      if (state.status === 'ready') { autoUpdater.quitAndInstall(); return {}; }
      void shell.openExternal(RELEASES_URL);
      return { opened: true };
    },
  };
}

// ------------------------------------------------- unsigned macOS fallback

function macFallbackEngine(bundle: string): Engine {
  let pending: MacUpdate | null = null;
  let downloadedZip: string | null = null;
  let busy = false;

  /** A letöltés saját ideiglenes mappában van; ha eldobjuk, vigyük a mappát is. */
  const discardDownload = (): void => {
    if (!downloadedZip) return;
    try { fs.rmSync(path.dirname(downloadedZip), { recursive: true, force: true }); } catch { /* ok */ }
    downloadedZip = null;
  };

  return {
    check: async () => {
      if (busy) return;
      busy = true;
      set({ status: 'checking', selfManaged: true });
      try {
        const update = await checkMacUpdate();
        if (!update) {
          discardDownload();
          // Nincs mit telepíteni, tehát nincs mit ŐRIZNI sem: egy korábbi
          // futásból ottmaradt csomag ilyenkor tiszta szemét.
          cleanupStaleUpdates();
          pending = null;
          set({ status: 'idle', version: undefined, percent: undefined });
          return;
        }
        // Az ellenőrzés 6 óránként fut. Ha ugyanazt a verziót már letöltöttük és
        // a fájl megvan, NE töltsük le újra: aki nem nyomja meg rögtön az
        // „újraindítás” gombot, annak ez naponta négyszer ~90 MB lenne, és
        // minden kör hagyna is maga után egy ekkora ideiglenes mappát.
        if (pending?.version === update.version && downloadedZip && fs.existsSync(downloadedZip)) {
          set({ status: 'ready', version: update.version, percent: 100 });
          return;
        }
        // Új verzió jött a korábban letöltött helyett: a régi csomag felesleges.
        discardDownload();
        // ÉS a korábbi FUTÁSOKBÓL ottmaradtak is. A memóriában tartott út az
        // app leállásakor elveszett, tehát azokat a `discardDownload` sosem
        // érte el — csendben gyűltek, fejenként ~90 MB.
        cleanupStaleUpdates(update.version);
        pending = update;
        set({ status: 'downloading', version: update.version, percent: 0 });
        downloadedZip = await downloadUpdate(update, (percent) => set({ status: 'downloading', percent }));
        set({ status: 'ready', version: update.version, percent: 100 });
      } catch (e) {
        const message = (e as Error).message;
        // A félbemaradt letöltés fájlja nem használható, és nagy: ne maradjon ott.
        discardDownload();
        // A sikertelen ellenőrzés nem hír; egy már bejelentett verzió sikertelen
        // letöltése igen.
        if (pending) set({ status: 'error', error: message });
        else set({ status: 'idle', error: message });
      } finally {
        busy = false;
      }
    },
    install: async () => {
      if (state.status === 'ready' && downloadedZip) {
        try {
          await applyUpdate(downloadedZip, bundle);
          return {};
        } catch (e) {
          set({ status: 'error', error: (e as Error).message });
        }
      }
      void shell.openExternal(RELEASES_URL);
      return { opened: true };
    },
  };
}

// -------------------------------------------------------------------- init

export function initUpdater(): void {
  // In dev (no packaged app) there is nothing to update.
  if (!app.isPackaged) {
    set({ status: 'idle' });
    wireIpc();
    return;
  }

  wireIpc();

  const bundle = process.platform === 'darwin' ? appBundlePath() : null;
  if (bundle) {
    // The signature decides the engine, so the check has to finish before the
    // first update check runs — but it must never delay startup, hence async.
    void hasDeveloperIdSignature(bundle).then((signed) => {
      engine = signed ? squirrelEngine() : macFallbackEngine(bundle);
      if (!engine) { set({ status: 'unsupported', error: 'Az electron-updater nem érhető el.' }); return; }
      if (!signed) set({ selfManaged: true });
      startChecking();
    });
    return;
  }

  engine = squirrelEngine();
  if (!engine) {
    set({ status: 'unsupported', error: 'Az electron-updater nem érhető el.' });
    return;
  }
  startChecking();
}

function wireIpc(): void {
  ipcMain.handle('breaker:check-update', async () => {
    if (!engine) return { ok: true };
    try {
      await engine.check();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle('breaker:install-update', async () => {
    if (!engine) { void shell.openExternal(RELEASES_URL); return { ok: true, opened: true }; }
    const r = await engine.install();
    return { ok: true, ...r };
  });

  ipcMain.handle('breaker:update-state', () => state);
}

function startChecking(): void {
  const kick = () => { void engine?.check().catch(() => { /* surfaced via state */ }); };
  setTimeout(kick, 8_000);          // shortly after launch
  setInterval(kick, CHECK_INTERVAL_MS);
}
