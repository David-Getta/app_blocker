// Electron entry. Two modes:
//   normal        -> the GUI window
//   `--helper`    -> headless privileged helper (Windows SYSTEM task launches
//                    the same exe with this flag; macOS uses ELECTRON_RUN_AS_NODE
//                    + dist/helper/index.js directly, bypassing this file)

import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import { registerSyncServerIpc } from './sync-server';
import { extensionSeenRecently, registerRulesBridge, stopRulesBridge } from './rules-bridge-ipc';
import {
  hideOverlay, registerOverlayShortcut, takeWarning, toggleOverlay, unregisterOverlayShortcut,
  warnAboutApp,
} from './overlay';
import { shouldWarnAboutApp, warnDue } from '../shared/focus';
import * as path from 'path';
import { HelperClient } from './helper-client';
import { installHelper } from './install';
import { initUpdater, requestUpdateCheck } from './updater';
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
      // Mac-en a címsor beleolvad a saját fejlécünkbe, de a három gomb
      // (bezárás, kicsinyítés, teljes képernyő) OTT MARAD — a fejléc CSS-e
      // (drag / no-drag) eleve erre készült. Windowson marad a rendes keret:
      // ott a hiddenInset épp a gombokat venné el.
      ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setMenuBarVisibility(false);
    // Az ablak fókuszba kerülése jó pillanat frissítést nézni: aki naphosszat
    // futni hagyja az appot, az a hatóránkénti körök KÖZÖTT ülne régi
    // verzión — pont ő járna a legrosszabbul. Türelmi idővel, hogy a sűrű
    // váltogatás ne kérdezzen sokat.
    win.on('focus', () => { requestUpdateCheck(); });
    void win.loadFile(path.join(__dirname, '..', 'ui', 'renderer', 'index.html'));
  };

  /**
   * Magyar app-menü. Nem dísz: a felhasználó szó szerint nem talált kilépést.
   * A szerep-alapú (role) tételek a rendszer viselkedését kapják — kilépés,
   * kicsinyítés, teljes képernyő, másolás/beillesztés a beviteli mezőkhöz.
   */
  const buildMenu = () => {
    if (process.platform !== 'darwin') return; // Windowson az ablak gombjai megvannak
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: 'Breaker',
        submenu: [
          { role: 'hide', label: 'Breaker elrejtése' },
          { role: 'unhide', label: 'Összes megjelenítése' },
          { type: 'separator' },
          // A kilépés NEM feloldás: a tiltást a háttérszolgáltatás tartja.
          { role: 'quit', label: 'Kilépés a Breakerből' },
        ],
      },
      {
        label: 'Szerkesztés',
        submenu: [
          { role: 'undo', label: 'Visszavonás' },
          { role: 'redo', label: 'Újra' },
          { type: 'separator' },
          { role: 'cut', label: 'Kivágás' },
          { role: 'copy', label: 'Másolás' },
          { role: 'paste', label: 'Beillesztés' },
          { role: 'selectAll', label: 'Összes kijelölése' },
        ],
      },
      {
        label: 'Ablak',
        submenu: [
          { role: 'minimize', label: 'Kicsinyítés' },
          { role: 'zoom', label: 'Nagyítás' },
          { role: 'togglefullscreen', label: 'Teljes képernyő be/ki' },
          { type: 'separator' },
          { role: 'close', label: 'Ablak bezárása' },
        ],
      },
    ]));
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

      // Kilépés a felület gombjáról. A tiltást nem érinti (az a segédé), a
      // letöltött frissítést viszont pont a kilépés engedi települni.
      ipcMain.handle('breaker:quit', () => { app.quit(); });
      ipcMain.handle('breaker:app-version', () => app.getVersion());

      buildMenu();
      createWindow();
      initUpdater();

      // Active-time measurement runs in this (user-session) process; the helper
      // stores what it measures. Off until the helper says it is enabled.
      let usageEnabled = false;
      // A futó munkamenet a segédben él; itt csak a legutóbb LÁTOTT állapot van,
      // hogy az előtér-szonda ne kérdezze meg minden öt másodpercben.
      let focusPack: import('../shared/focus').FocusPack | null = null;
      let focusEndsAt: number | null = null;
      let lastAppWarnAt: number | null = null;
      void client.call('status').then((s) => { usageEnabled = (s as StatusData).usageEnabled; })
        .catch(() => { /* helper not installed yet */ });
      const tracker = new UsageTracker({
        send: async (samples) => {
          try {
            // A VÁLASZT is elolvassuk. A segéd minden mintát ellenőriz, és
            // amit nem fogad el, azt szó nélkül eldobja — a kérés attól még
            // sikeres. Ha csak ennyit néznénk, egy csupa eldobott köteg
            // kézbesítettnek látszana, a puffer kiürülne, és a mért idő
            // némán elveszne.
            const r = await client.call('usage_batch', { samples }) as {
              recorded?: number; skippedClosed?: number;
            };
            // A zárva lévő oldalon mért, SZÁNDÉKOSAN nem könyvelt minta itt
            // elszámoltnak számít: döntés volt, nem veszteség. Nélküle egy
            // hibalapon nyitva felejtett fül pár perc után hamisan riasztana
            // azzal, hogy a mért idő elveszik.
            const handled = Number(r?.recorded ?? 0) + Number(r?.skippedClosed ?? 0);
            return { delivered: true, recorded: handled };
          } catch {
            // A segéd nem érhető el: a puffer megtartja a mintákat, és a
            // következő kör újrapróbálja. Ez NEM adatvesztés.
            return { delivered: false, recorded: 0 };
          }
        },
        isEnabled: () => usageEnabled,
        log: (m) => console.log(`[breaker-tracker] ${m}`),
        // A munkamenet appokra vonatkozó fele. TILTANI nem tudunk — egy futó
        // programot nem lövünk ki —, de szólni igen. Ugyanazt a szondát
        // használjuk, amit a mérés: egy második ugyanerre fölösleges terhelés
        // lenne, és a kettő előbb-utóbb máshogy válaszolna.
        onForeground: (fg) => {
          if (!fg || !focusPack || !focusEndsAt || focusEndsAt <= Date.now()) return;
          if (!shouldWarnAboutApp(focusPack, fg.appId, fg.appName)) return;
          const now = Date.now();
          if (!warnDue(lastAppWarnAt, now)) return;
          lastAppWarnAt = now;
          warnAboutApp(fg.appName || fg.appId);
        },
      });
      tracker.start();
      // A mérés csendben elhasalhat: macOS-en, ha a felhasználó megtagadja az
      // automatizálási engedélyt, az előtér-szonda örökre üres marad. Ezt a
      // felület kiírja, ezért kell egy lekérdezhető állapot.
      ipcMain.handle('breaker:tracker-state', () => ({
        blocked: tracker.probeBlocked,
        neverWorked: tracker.probeNeverWorked,
        samplesDropped: tracker.samplesDropped,
        platform: process.platform,
      }));
      // A szinkron-kiszolgáló EBBEN az appban is elindítható. Enélkül a
      // szinkron papíron létezik, gyakorlatban nem: terminált nyitni és külön
      // szolgáltatást futtatni a legtöbben nem fognak — és igazuk lenne.
      registerSyncServerIpc(app.getPath('userData'));
      // A böngésző-bővítmény innen veszi a részleges szabályokat. Enélkül
      // ugyanazt kétszer kellene begépelni, két külön listába — és ami kétszer
      // van, az előbb-utóbb szétcsúszik.
      // EGY állapot-lekérdezés kérésenként, nem kettő.
      //
      // A híd két dolgot ad vissza (a szabályokat és a futó munkamenetet), és
      // mindkettő ugyanabból az egy állapotból jön. A `Promise.all` miatt a
      // kettő EGYSZERRE indul, tehát ez az összevonás valóban egyetlen hívásra
      // fogja őket. Nem gyorsítás kedvéért: a bővítmény három másodperc után
      // továbblép, és két soros lekérdezés ennek a duplájába is telhet.
      //
      // Nem „fut-e épp” jelző, hanem MAGA az ígéret: az mindig befejeződik (a
      // segéd-kliensnek van időkorlátja), tehát nem tud beragadni.
      let statusInFlight: Promise<StatusData> | null = null;
      const sharedStatus = (): Promise<StatusData> => {
        if (!statusInFlight) {
          statusInFlight = (client.call('status') as Promise<StatusData>)
            .finally(() => { statusInFlight = null; });
        }
        return statusInFlight;
      };
      registerRulesBridge(
        app.getPath('userData'),
        async () => {
          const s = await sharedStatus();
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
          const s = await sharedStatus();
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
        async () => {
          // A csatorna-szűrő is a bővítményé: a DNS a hosztnévnél tovább nem
          // lát, egy @csatorna az útvonalban él. Csak a BEKAPCSOLTAK mennek le
          // — a kikapcsolt szűrő a böngészőre nem tartozik.
          const s = await sharedStatus();
          return (s.channelFilters ?? [])
            .filter((f) => f.enabled)
            .map((f) => ({ host: f.host, allow: f.allow }));
        },
        async () => {
          // A MOST zárva lévő hosztnevek, okkal. A DNS-réteg így is tilt; ez
          // csak azért megy le, hogy a bővítmény a nyers hibalap helyett meg
          // tudja mondani, miért zárva az oldal, és mikor nyílik újra.
          // Pontosan azok a hosztnevek mennek, amiket a hosts-fájl is zár —
          // a lap ne magyarázzon olyan címen, amit a DNS át is engedne.
          const s = await sharedStatus();
          const out: { host: string; reason: 'always' | 'schedule' | 'cooldown' | 'limit'; until: number }[] = [];
          for (const site of s.sites ?? []) {
            if (!site.blockedNow || !site.closedReason) continue;
            for (const host of site.hostnames ?? []) {
              out.push({ host, reason: site.closedReason, until: site.closedUntil ?? 0 });
            }
          }
          return out;
        },
      );
      // Keep the tracker's view of the switch fresh without extra IPC chatter.
      const refreshFocus = (): void => {
        void client.call('status')
          .then((s) => {
            const st = s as StatusData;
            usageEnabled = st.usageEnabled;
            const run = st.focusRun;
            focusEndsAt = run && run.endsAt > Date.now() ? run.endsAt : null;
            focusPack = run ? (st.focusPacks ?? []).find((p) => p.id === run.packId) ?? null : null;
            if (!focusEndsAt) lastAppWarnAt = null;
          })
          .catch(() => { /* ignore */ });
      };
      refreshFocus();
      // Húsz másodperc: a munkamenet percekben él, de az indítás UTÁN ne kelljen
      // egy percet várni arra, hogy a réteg tudomást vegyen róla.
      setInterval(refreshFocus, 20_000);
      // A gyorsbillentyűs réteg: egy mozdulattal indítható munkamenet. A
      // regisztráció elbukhat (másik program elvette a kombinációt) — ez nem
      // hiba, a felület megmondja, és a réteg az appból is nyitható.
      const shortcutOk = registerOverlayShortcut();
      // A BŐVÍTMÉNY HIÁNYA a rétegben is látszik. Ez a leggyakoribb indítási
      // út — „aki leül tanulni, nem fog előbb ablakot keresni” —, tehát ha a
      // figyelmeztetés csak az appban lenne meg, a legtöbb ember sosem látná,
      // és pont az indításnál nem tudná meg, hogy a menet a böngészőben nem
      // fog tiltani semmit.
      ipcMain.handle('breaker:overlay-state', () => ({
        shortcutOk,
        warnApp: takeWarning(),
        extensionStale: !extensionSeenRecently(),
      }));
      ipcMain.handle('breaker:overlay-toggle', () => { toggleOverlay(); });
      ipcMain.handle('breaker:overlay-hide', () => { hideOverlay(); });
      // A rétegről a leállítás az APPBA visz: ott van a próbatétel. Enélkül a
      // gomb bezárná a réteget, és látszólag nem történne semmi.
      ipcMain.handle('breaker:show-main', () => {
        hideOverlay();
        const [first] = BrowserWindow.getAllWindows();
        if (first && !first.isDestroyed()) {
          if (first.isMinimized()) first.restore();
          first.show();
          first.focus();
        } else {
          createWindow();
        }
      });

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
