// A szinkron-kiszolgáló EBBEN az appban.
//
// Enélkül a szinkron papíron létezik, gyakorlatban nem: a felhasználónak
// terminált kellene nyitnia, Node-ot telepítenie és egy szolgáltatást
// futtatnia. A legtöbben itt megállnának — és igazuk lenne.
//
// Mivel a kiszolgálónak nincs egyetlen függősége sem, egyszerűen behúzható ide.
// Egy kapcsoló a felületen, és a gép kiszolgálja a saját telefonját ugyanarról
// a Wi-Fi-ről.
//
// Amit ez NEM old meg, és a felület ki is mondja: amíg ez az app nem fut (vagy
// a gép alszik), nincs szinkron. Semmi nem vész el — a következő elérésnél
// összefésül —, de a telefon addig a legutóbbi állapotot mutatja.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ipcMain } from 'electron';
import type { Server } from 'http';

export interface SyncServerState {
  running: boolean;
  /** amit a másik eszközbe be kell írni */
  url?: string;
  /** hol tárolja az adatot ez a gép */
  dataDir?: string;
  error?: string;
}

/** Alapértelmezett port. Ugyanaz, mint a különálló kiszolgálóé. */
export const SYNC_PORT = 8787;

let server: Server | null = null;
let state: SyncServerState = { running: false };

/**
 * A gép helyi hálózati címe.
 *
 * A `localhost` itt használhatatlan: azt a telefon nem éri el. A cél az első
 * NEM belső IPv4 cím — ezt kell beírni a másik eszközön.
 */
export function lanAddress(): string | undefined {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return undefined;
}

export function syncServerState(): SyncServerState {
  return state;
}

export function startSyncServer(userDataDir: string): SyncServerState {
  if (server) return state;
  try {
    // A kiszolgáló a build során kerül a `dist/sync-server/` alá (lásd
    // scripts/copy-static.js). Függősége nincs, tehát egyszerű require.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(path.join(__dirname, '..', 'sync-server', 'server.js'));
    const dataDir = path.join(userDataDir, 'sync-data');
    const store = new mod.Store(dataDir);
    // A regisztráció csak AMÍG nincs egyetlen fiók sem. A gép a saját
    // hálózatán szolgál ki: az első fiók után más ne tudjon újat nyitni rajta,
    // se véletlenül, se szándékosan.
    const app = mod.createApp(store, { openSignup: () => !store.hasAnyAccount() });
    app.on('error', (e: Error) => {
      state = { running: false, error: serverError(e) };
      server = null;
    });
    app.listen(SYNC_PORT, () => {
      const host = lanAddress();
      state = {
        running: true,
        url: host ? `http://${host}:${SYNC_PORT}` : `http://127.0.0.1:${SYNC_PORT}`,
        dataDir,
      };
    });
    server = app;
    // A listen aszinkron; addig is mondjuk meg, hogy elindult a folyamat.
    state = { running: true, url: undefined, dataDir };
    return state;
  } catch (e) {
    state = { running: false, error: (e as Error).message };
    server = null;
    return state;
  }
}

export function stopSyncServer(): SyncServerState {
  if (server) {
    server.close();
    server = null;
  }
  state = { running: false };
  return state;
}

function serverError(e: Error & { code?: string }): string {
  if (e.code === 'EADDRINUSE') {
    return `A ${SYNC_PORT}-es port foglalt — fut már egy kiszolgáló ezen a gépen?`;
  }
  return e.message;
}

/**
 * Bekapcsolva marad-e a következő indításnál.
 *
 * Enélkül minden appindítás után újra kellene kattintani, a telefon pedig addig
 * csendben nem érné el a kiszolgálót. A felhasználó azt látná, hogy hol megy,
 * hol nem — az a legrosszabb fajta hiba, mert semmi nem magyarázza.
 */
function prefFile(userDataDir: string): string {
  return path.join(userDataDir, 'sync-server.json');
}

function readPref(userDataDir: string): boolean {
  try {
    return JSON.parse(fs.readFileSync(prefFile(userDataDir), 'utf8')).on === true;
  } catch {
    return false;
  }
}

function writePref(userDataDir: string, on: boolean): void {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(prefFile(userDataDir), JSON.stringify({ on }));
  } catch { /* a beállítás elvesztése nem ér annyit, hogy elhasaljon tőle az app */ }
}

export function registerSyncServerIpc(userDataDir: string): void {
  ipcMain.handle('breaker:sync-server-state', () => syncServerState());
  ipcMain.handle('breaker:sync-server-start', () => {
    writePref(userDataDir, true);
    return startSyncServer(userDataDir);
  });
  ipcMain.handle('breaker:sync-server-stop', () => {
    writePref(userDataDir, false);
    return stopSyncServer();
  });
  if (readPref(userDataDir)) startSyncServer(userDataDir);
}
