// Privileged helper entry point.
//
// Runs as root (macOS LaunchDaemon) or SYSTEM (Windows scheduled task, at
// boot). Installed ONCE with a single admin approval — after that it starts
// with the machine and never asks again. It owns the hosts file, validates
// unlock challenges and re-applies the block if the file is tampered with.
//
// Dev mode: `sudo npm run helper:dev`, or unprivileged with
// BREAKER_STATE/BREAKER_HOSTS/BREAKER_SOCKET pointing at writable paths.

import { loadState, saveState } from './state';
import { activeHostnames, applyBlocklist, applyDohPolicies, watchHosts } from './hosts';
import { startServer } from './server';
import { runSelfTest } from './selftest';
import type { SelfTestReport } from '../shared/selftest';
import { tick } from './referee';
import { bumpRevisions } from './revisions';
import { syncNow, syncToday } from './sync-client';
import { createSyncSchedule } from './sync-schedule';

export function runHelper(): void {
  const log = (m: string) => console.log(`[breaker-helper ${new Date().toISOString()}] ${m}`);
  const state = loadState();
  let dohApplied = state.dohApplied;

  // The installing user's uid is baked into the daemon launch args, so the
  // socket can be restricted to that account (see server.ts).
  const ownerArg = process.argv.find((a) => a.startsWith('--owner-uid='));
  const ownerUid = ownerArg ? Number(ownerArg.split('=')[1]) : undefined;
  if (ownerUid !== undefined && Number.isFinite(ownerUid)) {
    log(`socket will be restricted to uid ${ownerUid}`);
  }

  // Egy változás után ennyi csenddel indul a szinkron: egy műveletsor így EGY
  // feltöltés lesz, nem három.
  const SYNC_DEBOUNCE_MS = 20_000;
  /** Ilyen sűrűn nézünk rá magunktól is, hogy a másik gép írt-e. */
  const SYNC_INTERVAL_MS = 10 * 60_000;

  // ---------------------------------------------------------------- szinkron
  //
  // A felhasználó nem fogja nyomkodni a „Szinkronizálás most” gombot. Ha csak
  // kézzel menne, a másik gépen felvett oldal órákig nem érne ide — és pont ez
  // az, amiért az egész funkció van.
  //
  // Az ÜTEMEZÉS külön fájlban van (`sync-schedule.ts`), tesztekkel: a huzalozás
  // egy csúnya hurkot rejt, amit ránézésre semmi nem árul el — a szinkron a
  // végén ment, a mentés pedig ütemez egy szinkront, az megint ment…
  /** Az utoljára NAPLÓZOTT szinkron-hiba — csak a naplózás ritkításához. */
  let lastLoggedSyncError: string | null = null;
  const runSync = async (why: string): Promise<void> => {
    if (!state.sync) return;
    state.sync.lastAttemptAt = Date.now();
    try {
      const r = await syncNow(state, Date.now());
      commit();
      if (r.changed) log(`sync (${why}): a lista változott, ${r.sites} oldal`);
    } catch (e) {
      const msg = (e as Error).message;
      // A PRÓBÁLKOZÁS ideje akkor is elmentődik, ha a hibaüzenet ugyanaz, mint
      // az előző körben. Ez a fontos rész: a felhasználó ebből látja, hogy az
      // app MÉG PRÓBÁLKOZIK. Ha csak változás esetén mentenénk, egy órákig
      // ismétlődő hiba mellett az időbélyeg befagyna, és a képernyő pontosan
      // úgy nézne ki, mintha a szinkron leállt volna.
      if (state.sync) state.sync.lastError = msg;
      saveState(state);
      // A NAPLÓBA viszont csak a változás megy: offline gépnél a tízpercenként
      // ismétlődő azonos sor haszontalan.
      if (state.sync && lastLoggedSyncError !== msg) {
        lastLoggedSyncError = msg;
        log(`sync (${why}) failed: ${msg}`);
      }
    }
  };

  const syncSchedule = createSyncSchedule({
    hasAccount: () => !!state.sync,
    run: runSync,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
  }, SYNC_DEBOUNCE_MS);

  const commit = () => {
    // Egyetlen fogópont a szinkron verziószámaihoz: ami itt nem megy át, az
    // sosem jut el a másik eszközre. Az eszközazonosító csak akkor van, ha be
    // van jelentkezve — enélkül is léptetünk, hogy a későbbi belépéskor már
    // helyes számlálók menjenek fel.
    bumpRevisions(state, state.sync?.deviceId ?? 'local', Date.now());
    saveState(state);
    try {
      applyBlocklist(state, Date.now());
    } catch (e) {
      log(`hosts apply failed: ${String(e)}`);
    }
    syncSchedule.notifyCommit();
  };

  log(`starting on ${process.platform}, ${state.sites.length} site(s) in list`);
  commit(); // enforce at boot, before any browser opens

  void applyDohPolicies(log).then((ok) => {
    if (ok !== dohApplied) {
      dohApplied = ok;
      state.dohApplied = ok;
      saveState(state);
    }
  });

  watchHosts(() => state, log);

  setInterval(() => {
    try {
      const dirty = tick(state, Date.now());
      if (dirty) {
        log('tick: pauses expired / deletions executed');
        commit();
      } else {
        // periodic belt-and-braces re-check even if fs.watch missed something
        applyBlocklist(state, Date.now());
      }
    } catch (e) {
      log(`tick failed: ${String(e)}`);
    }
  }, 15_000);

  setInterval(() => void syncSchedule.runNow('időzített'), SYNC_INTERVAL_MS);
  void syncSchedule.runNow('indulás');

  // ------------------------------------------------- közös napi keret
  //
  // A napi keret eszközök között közös, és ehhez a mai összegzésnek FRISSNEK
  // kell lennie: tízperces körökkel a telefonon elhasznált idő tíz percet
  // késne, vagyis a húszperces keret akár harminc is lehetne.
  //
  // Ezért ez külön, sűrűbben fut — de csak akkor, ha van mit őriznie. Ha
  // egyetlen oldalon sincs napi keret, a hívás semmit nem befolyásolna, tehát
  // el is marad.
  const TODAY_INTERVAL_MS = 2 * 60_000;
  setInterval(() => {
    if (!state.sync) return;
    if (!state.sites.some((s) => (s.dailyLimitSeconds ?? 0) > 0)) return;
    void syncToday(state, Date.now()).then(
      () => {
        // FIGYELEM: itt NEM `commit()` van, szándékosan.
        //
        // A commit ütemez egy szinkron-kört (`notifyCommit`), tehát ez a
        // kétperces időzítő kétpercenként hozná vissza a teljes kört — pont azt
        // a hurkot, amit a `sync-schedule.ts` külön fájllal és tesztekkel zár.
        // Itt csak két dolog kell: az állapot maradjon meg újraindulás után, és
        // a keret azonnal blokkoljon, ha közben elfogyott.
        saveState(state);
        try {
          applyBlocklist(state, Date.now());
        } catch (e) {
          log(`hosts apply failed: ${String(e)}`);
        }
      },
      () => { /* offline: marad a helyi mérés, a következő kör újrapróbálja */ },
    );
  }, TODAY_INTERVAL_MS);

  // ------------------------------------------------- önteszt
  //
  // A „Védelem aktív” csak akkor igaz, ha a rendszer feloldója a tiltott
  // neveket a tiltó címre oldja. Ötpercenként megkérdezzük (és indulás után
  // hamar), a felület gombja pedig azonnal — a jelentés a status része.
  const SELF_TEST_INTERVAL_MS = 5 * 60_000;
  let lastSelfTest: SelfTestReport | null = null;
  const selfTestNow = async (): Promise<SelfTestReport> => {
    const now = Date.now();
    const report = await runSelfTest(activeHostnames(state, now), now);
    const before = (lastSelfTest?.leaking ?? []).map((l) => l.host).join(',');
    const after = report.leaking.map((l) => l.host).join(',');
    // A naplóba csak a változás: egy órákig szivárgó név egyszer kerüljön be.
    if (before !== after) {
      log(after
        ? `self-test: NOT enforced by the system resolver: ${after}`
        : `self-test: all ${report.checked} blocked name(s) resolve to the sinkhole`);
    }
    lastSelfTest = report;
    return report;
  };
  const selfTestQuietly = (): void => {
    void selfTestNow().catch((e) => log(`self-test failed: ${String(e)}`));
  };
  setTimeout(selfTestQuietly, 20_000);
  setInterval(selfTestQuietly, SELF_TEST_INTERVAL_MS);

  startServer({
    getState: () => state,
    commit,
    dohApplied: () => dohApplied,
    log,
    selfTest: () => lastSelfTest,
    runSelfTest: selfTestNow,
    ownerUid: ownerUid !== undefined && Number.isFinite(ownerUid) ? ownerUid : undefined,
  });
}

// Direct execution: `node dist/helper/index.js` (launchd/schtasks entry).
if (require.main === module) {
  runHelper();
}
