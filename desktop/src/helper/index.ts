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
import { applyBlocklist, applyDohPolicies, watchHosts } from './hosts';
import { startServer } from './server';
import { tick } from './referee';
import { bumpRevisions } from './revisions';
import { syncNow } from './sync-client';

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
  // Két ütem: időzítve, és egy változás után rövid csenddel. A csend azért kell,
  // hogy egy műveletsor (felvétel, keret, menetrend) EGY feltöltés legyen, ne
  // három.
  let syncTimer: NodeJS.Timeout | null = null;
  let syncing = false;

  const runSync = async (why: string) => {
    if (syncing || !state.sync) return;
    syncing = true;
    try {
      const r = await syncNow(state, Date.now());
      commit();
      if (r.changed) log(`sync (${why}): a lista változott, ${r.sites} oldal`);
    } catch (e) {
      // Nem naplózzuk minden körben ugyanazt: offline gépnél az percenként
      // ismétlődő, haszontalan sor lenne. Az állapotba viszont bekerül, és a
      // felület kiírja.
      const msg = (e as Error).message;
      if (state.sync && state.sync.lastError !== msg) {
        state.sync.lastError = msg;
        saveState(state);
        log(`sync (${why}) failed: ${msg}`);
      }
    } finally {
      syncing = false;
    }
  };

  const scheduleSync = () => {
    if (!state.sync || syncTimer) return;
    syncTimer = setTimeout(() => { syncTimer = null; void runSync('változás'); }, SYNC_DEBOUNCE_MS);
  };

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
    scheduleSync();
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

  setInterval(() => void runSync('időzített'), SYNC_INTERVAL_MS);
  void runSync('indulás');

  startServer({
    getState: () => state,
    commit,
    dohApplied: () => dohApplied,
    log,
    ownerUid: ownerUid !== undefined && Number.isFinite(ownerUid) ? ownerUid : undefined,
  });
}

// Direct execution: `node dist/helper/index.js` (launchd/schtasks entry).
if (require.main === module) {
  runHelper();
}
