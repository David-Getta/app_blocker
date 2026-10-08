// Electron entry. Two modes:
//   normal        -> the GUI window
//   `--helper`    -> headless privileged helper (Windows SYSTEM task launches
//                    the same exe with this flag; macOS uses ELECTRON_RUN_AS_NODE
//                    + dist/helper/index.js directly, bypassing this file)

// ELSŐ import: a füstpróba-mód a többi modul betöltése ELŐTT élesíti a
// hibakezelőjét — egy betöltéskor elhasaló modul különben párbeszédablakot
// nyitna, amit a CI-ban senki nem kattint el (lásd smoke.ts).
import { isSmoke, watchSmoke } from './smoke';
import { app, BrowserWindow, ipcMain, Menu, Notification, systemPreferences, Tray } from 'electron';
import * as fs from 'fs';
import { registerSyncServerIpc } from './sync-server';
import {
  extensionIncognitoOff, extensionSeenRecently, extensionTabHint, registerRulesBridge, stopRulesBridge,
} from './rules-bridge-ipc';
import { SOON_HORIZON_MS, type BridgeSoon } from './rules-bridge';
import { isWindowLockdown, liveLockdown, upcomingLockdownWindows } from '../shared/lockdown';
import {
  hideOverlay, takeWarning, toggleOverlay, unregisterOverlayShortcut, warnAboutForeground,
} from './overlay';
import { setupOverlayShortcut } from './overlay-shortcut';
import { setupExtensionFolder } from './extension-folder';
import {
  foregroundWarning, isFocusHourNow, isWindowRun, packCoveringHour, peakWindowBand, SITE_WARN_SIGHTINGS, siteSightings,
  warnDue,
} from '../shared/focus';
import { isPeakDayNow } from '../shared/browser-hits';
import { limitRemaining, limitSoonLine } from '../shared/limits';
import { normalizeBurst } from '../shared/burst';
import { nextCloseAt } from '../shared/schedule';
import { displayName } from '../shared/alias';
import * as path from 'path';
import { HelperClient } from './helper-client';
import { installHelper } from './install';
import { readHelperKey } from './helper-key';
import { initUpdater, requestUpdateCheck } from './updater';
import { UsageTracker } from './tracker';
import { needsMeasurement } from '../shared/measure-guard';

/** Ennél több hosztnév nem megy le a mérés-őrrel (a bővítmény is ennyit tárol). */
const MAX_GUARD_HOSTS = 2000;
/** Ennél több közelgő zárás nem megy le (a bővítmény is ennyit tárol). */
const MAX_SOON_HOSTS = 500;
import {
  BACKGROUND_FLAG, closeAction, LAUNCH_AGENT_LABEL, launchAgentPlist, launchAgentUsable, startsHidden, WINDOWS_RUN_NAME,
} from '../shared/background';
import type { StatusData } from '../shared/protocol';
import { APP_ID } from '../shared/app-id';

const HELPER_MODE = process.argv.includes('--helper');
/** Indítási füstpróba: a rendes indulás, nyom és hálózat nélkül (smoke.ts). */
const SMOKE = isSmoke(process.argv);

// Az app magyar, a Chromium belső nyelve is legyen az: a beépített idő- és
// dátummezők (a heti ablak 9:00–12:00-ja) a Chromium nyelvét követik, nem a
// lap `lang="hu"` jelzőjét — angol rendszeren „09:00 AM”-et mutatnának egy
// magyar felület közepén. A kapcsoló csak az `app.whenReady()` előtt hat.
app.commandLine.appendSwitch('lang', 'hu');

// Windowson az app ugyanazzal az azonosítóval küld értesítést, amit a telepítő
// parancsikonja visel (shared/app-id.ts) — még az első ablak és értesítés előtt.
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

if (HELPER_MODE) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { runHelper } = require('../helper/index') as typeof import('../helper/index');
  app.whenReady().then(() => {
    runHelper();
  });
  // No window, no dock icon, never quit on window-all-closed.
  app.on('window-all-closed', () => { /* keep running */ });
} else {
  // Windowson a segéd csak a telepítéskor kapott kulccsal áll szóba
  // (shared/client-key.ts); máshol a socket jogai szűkítenek.
  const client = new HelperClient(process.platform === 'win32' ? { key: readHelperKey } : {});

  /**
   * A fő ablak. Nem a getAllWindows()-ból keressük: a gyorsbillentyűs réteg is
   * BrowserWindow, és egy rejtett fő ablak mellett az elsőként visszaadott
   * ablak a réteg is lehet.
   */
  let mainWin: BrowserWindow | null = null;
  /** Kilépés közben az ablak tényleg bezárul; máskor csak elrejtőzik. */
  let quitting = false;
  /** A tálca-ikon (Windows) — hivatkozás nélkül a szemétgyűjtő eltüntetné. */
  let tray: Tray | null = null;

  /**
   * Az első elrejtéskor egyszer kimondjuk, hogy az app nem állt le — ez új
   * viselkedés, és egy némán tovább futó app meglepetés lenne. Utána csend.
   */
  const noteHiddenOnce = () => {
    const flag = path.join(app.getPath('userData'), 'background-notice-shown');
    if (fs.existsSync(flag)) return;
    try { fs.writeFileSync(flag, String(Date.now())); } catch { return; }
    if (!Notification.isSupported()) return;
    new Notification({
      title: 'Breaker — a háttérben fut tovább',
      body: process.platform === 'win32'
        ? 'A mérés és az értesítések nem állnak le. Kilépni a tálca ikonjáról lehet.'
        : 'A mérés és az értesítések nem állnak le. Kilépni a menüből lehet: Breaker › Kilépés.',
    }).show();
  };

  const createWindow = (opts: { show: boolean } = { show: true }) => {
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
      // Bejelentkezéskor rejtve indul: a mérés és az értesítések futnak, az
      // ablak csak kérésre jön elő.
      show: opts.show,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // A rejtett ablak időzítőit a Chromium percenkéntire ritkítaná — a
        // heti ablak értesítése így percekkel később szólna.
        backgroundThrottling: false,
      },
    });
    win.setMenuBarVisibility(false);
    // A BEZÁRÁS ELREJT, nem állít le (lásd shared/background.ts): a mérés —
    // amiből a napi keret és az adag fogy — és a gépi értesítések az appban
    // futnak. Kilépés közben viszont tényleg bezárul.
    win.on('close', (e) => {
      if (closeAction(quitting) === 'close') return;
      e.preventDefault();
      win.hide();
      noteHiddenOnce();
    });
    // Windowson a leállítás és a kijelentkezés NEM küld before-quit-et: itt
    // jelezzük, különben a bezárás elrejtene, és a rendszer azt látná, hogy az
    // app akadályozza a leállítást.
    win.on('session-end', () => { quitting = true; });
    win.on('closed', () => { if (mainWin === win) mainWin = null; });
    // A LÁTHATÓSÁG a felületnek: rejtve (vagy kicsinyítve) ritkábban kérdez, és
    // nem rajzol — az értesítések ettől mennek tovább (shared/refresh-cadence.ts).
    const sendVisibility = () => {
      if (win.isDestroyed()) return;
      win.webContents.send('breaker:visibility', win.isVisible() && !win.isMinimized());
    };
    for (const ev of ['show', 'hide', 'minimize', 'restore'] as const) win.on(ev as 'show', sendVisibility);
    win.webContents.on('did-finish-load', sendVisibility);
    mainWin = win;
    // Az ablak fókuszba kerülése jó pillanat frissítést nézni: aki naphosszat
    // futni hagyja az appot, az a hatóránkénti körök KÖZÖTT ülne régi
    // verzión — pont ő járna a legrosszabbul. Türelmi idővel, hogy a sűrű
    // váltogatás ne kérdezzen sokat.
    win.on('focus', () => { requestUpdateCheck(); });
    // A betöltés ELŐTT: egy korai preload-hibát különben lekésnénk.
    if (SMOKE) watchSmoke(win);
    void win.loadFile(path.join(__dirname, '..', 'ui', 'renderer', 'index.html'));
  };

  /** A fő ablak elő: a rejtett megjelenik, a megszűnt helyett új nyílik. */
  const showMain = () => {
    if (mainWin && !mainWin.isDestroyed()) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
    } else {
      createWindow({ show: true });
    }
  };

  /**
   * Bejelentkezéskor induljon az app — rejtve. Fejlesztés közben nem írunk
   * semmit (a futtató nem az, amit a felhasználó telepített).
   *
   * A rendszer kapcsolóját NEM írjuk felül: ha valaki a Feladatkezelőben vagy
   * a Rendszerbeállításokban kikapcsolta, kikapcsolva marad — a felület
   * kimondja, hogy akkor a mérés áll, amíg az app nem fut. Csak a hiányzó vagy
   * elavult (máshova mutató) bejegyzést pótoljuk.
   */
  const ensureLoginStart = () => {
    if (!app.isPackaged) return;
    try {
      if (process.platform === 'win32') {
        const args = [BACKGROUND_FLAG];
        const ours = app.getLoginItemSettings({ path: process.execPath, args }).launchItems
          ?.find((i) => i.name === WINDOWS_RUN_NAME);
        const current = !!ours && ours.path.toLowerCase() === process.execPath.toLowerCase()
          && ours.args.join(' ') === args.join(' ');
        if (current) return;
        app.setLoginItemSettings({
          openAtLogin: true, path: process.execPath, args, name: WINDOWS_RUN_NAME,
          // A meglévő bejegyzés ki/be állapota marad, ami volt.
          ...(ours ? { enabled: ours.enabled } : {}),
        });
      } else if (process.platform === 'darwin') {
        if (!launchAgentUsable(process.execPath)) return;
        const dir = path.join(app.getPath('home'), 'Library', 'LaunchAgents');
        const file = path.join(dir, `${LAUNCH_AGENT_LABEL}.plist`);
        const want = launchAgentPlist(process.execPath);
        let have = '';
        try { have = fs.readFileSync(file, 'utf8'); } catch { /* még nincs */ }
        if (have === want) return;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, want);
      }
    } catch (err) {
      console.log(`[login-start] ${(err as Error).message}`);
    }
  };

  /**
   * Windowson a háttérben futó appnak látszania kell: tálca-ikon, rajta a
   * megnyitás és a kilépés. Macen ezt a Dock és a menü adja.
   */
  const setupTray = async () => {
    if (process.platform !== 'win32' || tray) return;
    try {
      const icon = await app.getFileIcon(process.execPath, { size: 'small' });
      tray = new Tray(icon);
      tray.setToolTip('Breaker — a háttérben mér és értesít');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Breaker megnyitása', click: () => showMain() },
        { type: 'separator' },
        // A kilépés NEM feloldás (a tiltást a segéd tartja), de a mérés megáll.
        { label: 'Kilépés (a mérés megáll)', click: () => app.quit() },
      ]));
      tray.on('click', () => showMain());
    } catch (err) {
      console.log(`[tray] ${(err as Error).message}`);
    }
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
          // A kilépés NEM feloldás: a tiltást a háttérszolgáltatás tartja. A
          // mérés viszont megáll vele — a felület ezt kimondja.
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
    // A második indítás (a háttérben futó app mellett kattintanak rá) az
    // ablakot hozza elő — a rejtettet is.
    app.on('second-instance', () => { showMain(); });

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

      // A LISTA ZÁRJA: a rejtett blokklista felfedése a gép azonosítását kéri.
      // Macen a Touch ID a rendszeré — mi csak igen/nem választ kapunk. Ahol
      // nincs olvasó (Windows, vagy Mac nélküle), nincs mit kérni: kimondjuk,
      // nem tettetjük — az Electronnak itt nincs rendszer-azonosító hívása.
      ipcMain.handle('breaker:authenticate', async (_e, reason: string) => {
        if (process.platform !== 'darwin' || !systemPreferences.canPromptTouchID()) {
          return { ok: false, unavailable: true };
        }
        try {
          await systemPreferences.promptTouchID(String(reason ?? '').slice(0, 120));
          return { ok: true };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      });

      buildMenu();
      createWindow({ show: !startsHidden(process.argv) });
      // A füstpróba nem hagy nyomot a gépen (bejelentkezéskori indítás) és nem
      // keres frissítést — minden más ugyanúgy indul, mint élesben.
      if (!SMOKE) ensureLoginStart();
      void setupTray();
      initUpdater({ checks: !SMOKE });

      // Active-time measurement runs in this (user-session) process; the helper
      // stores what it measures. Off until the helper says it is enabled.
      let usageEnabled = false;
      // A futó munkamenet a segédben él; itt csak a legutóbb LÁTOTT állapot van,
      // hogy az előtér-szonda ne kérdezze meg minden öt másodpercben.
      let focusPack: import('../shared/focus').FocusPack | null = null;
      let focusEndsAt: number | null = null;
      let focusStartedAt = 0;
      let lastAppWarnAt: number | null = null;
      // Ugyanaz a nem engedett oldal hány egymás utáni mintán látszott.
      let siteSeen: { host: string; count: number } | null = null;
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
        // A böngésző jele: ahol a szonda a címet nem látja (macOS-en a frissítés
        // után visszavont engedély), a bővítmény mondja meg az oldalt — enélkül
        // az idő appként könyvelődne, és az oldal kerete nem fogyna.
        tabHint: () => extensionTabHint(),
        log: (m) => console.log(`[breaker-tracker] ${m}`),
        // A munkamenet appokra vonatkozó fele. TILTANI nem tudunk — egy futó
        // programot nem lövünk ki —, de szólni igen. Ugyanazt a szondát
        // használjuk, amit a mérés: egy második ugyanerre fölösleges terhelés
        // lenne, és a kettő előbb-utóbb máshogy válaszolna.
        // A BÖNGÉSZŐ NEM APP: benne a nyitott oldal dönt (lásd `foregroundWarning`).
        // Ha egy nem engedett oldal két mintán át látszik, abban a böngészőben a
        // fehérlistát senki nem tartja — ezt mondjuk ki, nem azt, hogy a böngésző
        // „nincs a listán”.
        onForeground: (fg) => {
          const now = Date.now();
          if (!fg || !focusPack || !focusEndsAt || focusEndsAt <= now) {
            siteSeen = null;
            return;
          }
          const warning = foregroundWarning(focusPack, focusStartedAt, fg, now);
          siteSeen = siteSightings(siteSeen, warning?.kind === 'site' ? warning.host : null);
          if (!warning) return;
          if (warning.kind === 'site' && (siteSeen?.count ?? 0) < SITE_WARN_SIGHTINGS) return;
          if (!warnDue(lastAppWarnAt, now)) return;
          lastAppWarnAt = now;
          warnAboutForeground(warning);
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
      // A bővítmény mappája: az app csomagolja ki és tartja frissen, a
      // böngészőbe egyszer kell betölteni — nem minden kiadásnál újra.
      setupExtensionFolder(app.getPath('userData'), (m) => console.log(`[extension] ${m}`));
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
          // A heti ablakok következő hete is lemegy, a futó menettől függetlenül:
          // ha az app bezárul, a segéd az ablak menetét akkor is elindítja, és a
          // bővítmény ebből tudja, hogy a böngészőben is be kell tartani.
          const windows = s.focusWindows ?? [];
          if (!run) return { running: false, windows };
          const packs = s.focusPacks ?? [];
          const pack = packs.find((p) => p.id === run.packId);
          return {
            running: true,
            name: pack?.name,
            endsAt: run.endsAt,
            // A HATÁSOS lista: ha közben egy másik csomag heti ablaka is tart,
            // a kettő metszete — az ablak nem állítja le a menetet, de amíg
            // tart, ő is szól (`effectivePack`).
            allowSites: s.focusEffective?.allowSites ?? pack?.allowSites ?? [],
            packAllowSites: pack?.allowSites ?? [],
            // Aki nem maga indította, a böngészőben is tudja meg, miért fut.
            window: isWindowRun(run, packs),
            windows,
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
        async () => {
          // A ZÁRLAT vége, ha fut. A tiltó lap enélkül azt írná, hogy az
          // appban feloldható, próbatétellel — zárlat alatt pont ez az út
          // nincs, és a lap ne ígérjen olyat, ami nem létezik.
          const s = await sharedStatus();
          const now = Date.now();
          // A heti zárlat-ablakok következő hete is lemegy, a futó zárlattól
          // függetlenül: a segéd az ablak zárlatát az app nélkül is elindítja,
          // és a lap ebből tudja, hogy akkor sincs feloldás.
          const windows = upcomingLockdownWindows(s.lockdownWindows ?? [], now);
          const l = liveLockdown(s.lockdown, now);
          if (!l) return windows.length > 0 ? { until: 0, windows } : null;
          // Az ablak zárlata ugyanaz a zárlat — de a lap mondja ki, hogy az
          // ablak tartja: aki a tiltó lapra fut, tudja meg, miért.
          return { until: l.until, ...(isWindowLockdown(l, s.lockdownWindows ?? []) ? { byWindow: true } : {}), windows };
        },
        async () => {
          // Az INDOK: amiért a felhasználó maga tiltotta le. A tiltó lapon a
          // kísértés pillanatában ez a mondat számít — hosztnevenként megy,
          // mint a zárva-lista, hogy a lap pontos címre mondja.
          const s = await sharedStatus();
          const out: { host: string; text: string }[] = [];
          for (const site of s.sites ?? []) {
            if (!site.reason) continue;
            for (const host of site.hostnames ?? []) out.push({ host, text: site.reason });
          }
          return out;
        },
        async () => {
          // A MEGBÍZOTT neve, ha van: a tiltó lap ebből mondja ki, hogy a
          // feloldás útja az ő jelmondatával ér véget. Csak a név megy — a
          // lenyomat a segédé, a bővítménynek semmi dolga vele.
          // Ha társ-megbízott is él, mindegyikük neve: a lazítás végén
          // mindegyikük jelmondata kell.
          const s = await sharedStatus();
          return s.partner
            ? { name: [s.partner.name, ...(s.partnerCo ?? []).map((p) => p.name)].join(', ') }
            : null;
        },
        async () => {
          // A KULCSSZAVAK: bármely oldalon, ha a cím tartalmazza — ezt csak a
          // böngésző tudja érvényesíteni, ezért megy le a hídon.
          const s = await sharedStatus();
          return s.keywords ?? [];
        },
        async (source, days) => {
          // A MEGAKADÁS-KÖNYV visszafelé: a bővítmény számolja, a segéd tartja
          // — a heti mondat és a statisztika sora innen mondja, hányszor
          // állított meg a böngésző. Könyvelés, nem szabály: bíró nélkül.
          await client.call('browser_hits', { source, days });
        },
        async () => {
          // A JAVASOLT csomag a felugró lapnak: a legutóbb használt (napló
          // nélkül az első) a szokásos hosszával — a segéd választása. Futó
          // menet mellett nincs: egyszerre egy menet fut.
          const s = await sharedStatus();
          const run = s.focusRun;
          if (run && run.endsAt > Date.now()) return null;
          const packs = s.focusPacks ?? [];
          const pick = packs.find((p) => p.id === s.lastUsedPackId) ?? packs[0] ?? null;
          if (!pick) return null;
          // A CSÚCS-ÓRA, amire a lap ablakot tehet: ugyanazok a kapuk, mint az
          // app gombjánál — van csúcs, a csomagnak nincs ablaka, és semmi nem
          // fedi. Különben null: a lap ne ígérjen olyat, amit a híd nem tesz meg.
          const peak = s.browserHitsPeak ?? null;
          const covering = peak ? packCoveringHour(packs, peak.hour) : null;
          const peakHour = peak && !pick.recurrence && !covering ? peak.hour : null;
          // A MENET-NAP: ma szoktál-e leülni — a lap a gomb mellett kimondja. A „ma van” szabálya a csúcs-napé.
          const focusDay = isPeakDayNow(s.focusWeekday ?? null, Date.now());
          // A MENET-ÓRA: most szoktál-e elkezdeni — a lap a gomb mellett kimondja.
          const focusHourNow = isFocusHourNow(s.focusHour ?? null, Date.now());
          // A MENET-ÓRA, amire a lap ablakot tehet: a csúcs-óra gombjának tükre,
          // ugyanazokkal a kapukkal — és ha a menet-óra a csúcs-óra, a csúcs-óra
          // gombja már kínálja (null): kétszer ugyanazt nem.
          const fh = s.focusHour ?? null;
          const focusHour = fh && (!peak || peak.hour !== fh.hour) && !pick.recurrence && !packCoveringHour(packs, fh.hour) ? fh.hour : null;
          // LE VAN-E FEDVE a menet-óra: a csomag, amelynek ablaka fedi — a lap kimondja;
          // ha a menet-óra a csúcs-óra, a csúcs-óra fedése mondja (kétszer ugyanazt nem).
          const focusHourPack = fh && (!peak || peak.hour !== fh.hour) ? packCoveringHour(packs, fh.hour)?.name ?? null : null;
          // AMIKOR A CSÚCS-ÓRA A MENET-ÓRA: a tükör két fele egy pontra mutat — a felugró lap kimondja.
          const sameHour = !!(fh && peak && fh.hour === peak.hour);
          // A MENET-SOROZAT: hány napja ülsz le minden nap — a segéd számolja, a lap a gomb mellett mondja (kettőtől).
          const focusStreak = s.focusStreak ?? 0;
          // A LEGHOSSZABB SOROZAT: a lap a mostani mellett, zárójelben mondja — a szám az appé, a küszöb a lapé.
          const focusLongestStreak = s.focusLongestStreak ?? 0;
          // KÖZELEG A NAPI KERET: a legsürgősebb oldal, ha a mai keretéből kevés van hátra.
          // A fedőnevet itt oldjuk fel; rejtett listánál nincs (a cím ne szivárogjon ki).
          const limitSoon = s.hideSiteList === true ? '' : limitSoonLine((s.sites ?? []).map((site) => ({
            label: displayName(site), dailyLimitSeconds: site.dailyLimitSeconds, usedSeconds: site.usedTodaySeconds,
          })));
          // LE VAN-E FEDVE: a csomag, amelynek ablaka a csúcs-órát fedi — a felugró lap kimondja.
          return { packId: pick.id, name: pick.name, minutes: pick.defaultMinutes, peakHour, peakPack: covering?.name ?? null, focusDay, focusHourNow, focusHour, focusHourPack, sameHour, focusStreak, focusLongestStreak, limitSoon };
        },
        async (packId, minutes) => {
          // EGY KATTINTÁS a felugró lapról a menetig: ugyanaz a bírói út, mint
          // az app gombjáé — szigorítás, ingyen. A bíró nemje hibaként jön
          // vissza, a híd válasznak adja tovább.
          await client.call('focus_start', { packId, minutes });
        },
        async (packId, hour) => {
          // ABLAK A CSÚCS-ÓRÁRA a tiltó lapról és a felugró lapról: ugyanaz a
          // bírói út, mint az app gombjáé. A híd befelé csak szigorít: ablakos
          // csomagra nem megy — a csere lazíthat, arról a bíró próbatételt
          // kezdene, és azt a híd nem indíthatja el. Ezért előbb megnézzük.
          const s = await sharedStatus();
          const pack = (s.focusPacks ?? []).find((p) => p.id === packId);
          if (!pack) throw new Error('Ismeretlen csomag.');
          if (pack.recurrence) throw new Error('Ennek a csomagnak már van heti ablaka — az appban szerkeszthető.');
          const r = await client.call('focus_recurrence', { packId, band: peakWindowBand(hour) }) as { applied?: boolean };
          if (r.applied === false) throw new Error('Ez próbatételbe kerülne — az appból megy.');
        },
        async () => {
          // A MÉRÉS-ŐR a böngészőnek: ha az app elhallgat, a segéd a keretes
          // oldalakat a hosts-ban zárja — a bővítmény ebből tudja megmondani a
          // tiltó lapon, miért, a DNS csupasz hibaoldala helyett.
          const s = await sharedStatus();
          if (!s.requireMeasurement) return null;
          const hosts = new Set<string>();
          for (const site of s.sites ?? []) {
            if (!needsMeasurement(site)) continue;
            for (const h of site.hostnames) hosts.add(h);
          }
          return { hosts: [...hosts].slice(0, MAX_GUARD_HOSTS) };
        },
        async () => {
          // A HAMAROSAN ZÁRULÓ, most még nyitott hosztnevek: a lap ebből szól
          // előre az utolsó percekben. Ugyanazok a hosztnevek, mint a
          // zárva-listán — a lap ne magyarázzon olyan címen, amit a DNS nem zár.
          // A szünet erősebb a menetrendnél: szünet alatt csak a vége számít.
          const s = await sharedStatus();
          const now = Date.now();
          const out: BridgeSoon[] = [];
          for (const site of s.sites ?? []) {
            if (site.blockedNow || site.pendingDeleteAt !== null) continue;
            const hosts = site.hostnames ?? [];
            const push = (e: Omit<BridgeSoon, 'host'>): void => {
              for (const host of hosts) out.push({ host, ...e });
            };
            if (site.pauseUntil !== null && site.pauseUntil > now) {
              // Csak ha a szünet végén TÉNYLEG zárul (a segéd döntése): egy
              // nyitott menetrend-sávban véget érő szünet után nyitva marad,
              // és a lap „utána újra zárva” mondata hamis volna.
              if (site.pauseUntil - now <= SOON_HORIZON_MS && (site.closesAfterPause ?? true)) {
                push({ kind: 'pause', at: site.pauseUntil });
              }
              continue;
            }
            if (site.schedule && site.schedule.mode !== 'always') {
              const closes = nextCloseAt(site.schedule, now);
              if (closes > now && closes - now <= SOON_HORIZON_MS) push({ kind: 'schedule', at: closes });
            }
            const left = limitRemaining(site.dailyLimitSeconds, site.usedTodaySeconds);
            if (left !== null && left > 0 && left * 1000 <= SOON_HORIZON_MS) push({ kind: 'limit', left });
            // Az ADAG: ennyi használat után szünet — a hátralévő aktív
            // másodpercek, mint a keretnél (a hűtés alatt az oldal már zárva,
            // a fenti `blockedNow` kiveszi).
            const rule = normalizeBurst(site.burstSeconds, site.cooldownSeconds);
            if (rule) {
              const burstLeft = rule.burstSeconds - (site.burstUsedSeconds ?? 0);
              if (burstLeft > 0 && burstLeft * 1000 <= SOON_HORIZON_MS) {
                push({ kind: 'burst', left: burstLeft, of: rule.burstSeconds, cool: rule.cooldownSeconds });
              }
            }
          }
          return out.slice(0, MAX_SOON_HOSTS);
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
            const own = run ? (st.focusPacks ?? []).find((p) => p.id === run.packId) ?? null : null;
            // A hatásos lista a réteg figyelmeztetéséhez is: amíg egy másik
            // csomag heti ablaka is tart, a kettő metszete.
            focusPack = own && st.focusEffective
              ? { ...own, allowSites: st.focusEffective.allowSites, allowApps: st.focusEffective.allowApps }
              : own;
            focusStartedAt = run ? run.startedAt : 0;
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
      // A mentett kombináció regisztrálódik (nem az beégetett): az átállítás
      // a Munkamenetek kártyán él, és újraindítás után is az marad.
      const overlayShortcut = setupOverlayShortcut(app.getPath('userData'));
      // A BŐVÍTMÉNY HIÁNYA a rétegben is látszik. Ez a leggyakoribb indítási
      // út — „aki leül tanulni, nem fog előbb ablakot keresni” —, tehát ha a
      // figyelmeztetés csak az appban lenne meg, a legtöbb ember sosem látná,
      // és pont az indításnál nem tudná meg, hogy a menet a böngészőben nem
      // fog tiltani semmit.
      ipcMain.handle('breaker:overlay-state', () => ({
        shortcutOk: overlayShortcut.registered(),
        warn: takeWarning(),
        extensionStale: !extensionSeenRecently(),
        // Ott van, de inkognitóban nem fut: a réteg lába ezt is kimondja.
        extensionNoIncognito: extensionIncognitoOff(),
      }));
      ipcMain.handle('breaker:overlay-toggle', () => { toggleOverlay(); });
      ipcMain.handle('breaker:overlay-hide', () => { hideOverlay(); });
      // A rétegről a leállítás az APPBA visz: ott van a próbatétel. Enélkül a
      // gomb bezárná a réteget, és látszólag nem történne semmi.
      ipcMain.handle('breaker:show-main', () => {
        hideOverlay();
        showMain();
      });

      app.on('before-quit', () => {
        // ELŐSZÖR ez: enélkül az ablak bezárása elrejtené az ablakot, és a
        // kilépés sosem érne véget.
        quitting = true;
        tracker.stop();
        stopRulesBridge();
        unregisterOverlayShortcut();
      });
      // A Dock-ikon: a rejtett ablakot hozza elő.
      app.on('activate', () => { showMain(); });
    });

    app.on('window-all-closed', () => {
      // NEM lépünk ki. A tiltást a segéd tartja, de a mérés (napi keret,
      // adag) és a gépi értesítések az appban futnak — ezért a bezárás csak
      // elrejt (lásd shared/background.ts). Ide csak akkor érünk, ha az ablak
      // mégis megszűnt; a következő megnyitás újat nyit.
    });
  }
}
