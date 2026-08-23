// Privileged helper entry point.
//
// Runs as root (macOS LaunchDaemon) or SYSTEM (Windows scheduled task, at
// boot). Installed ONCE with a single admin approval — after that it starts
// with the machine and never asks again. It owns the hosts file, validates
// unlock challenges and re-applies the block if the file is tampered with.
//
// Dev mode: `sudo npm run helper:dev`, or unprivileged with
// LAKAT_STATE/LAKAT_HOSTS/LAKAT_SOCKET pointing at writable paths.

import { loadState, saveState } from './state';
import { applyBlocklist, applyDohPolicies, watchHosts } from './hosts';
import { startServer } from './server';
import { tick } from './referee';

export function runHelper(): void {
  const log = (m: string) => console.log(`[lakat-helper ${new Date().toISOString()}] ${m}`);
  const state = loadState();
  let dohApplied = state.dohApplied;

  // The installing user's uid is baked into the daemon launch args, so the
  // socket can be restricted to that account (see server.ts).
  const ownerArg = process.argv.find((a) => a.startsWith('--owner-uid='));
  const ownerUid = ownerArg ? Number(ownerArg.split('=')[1]) : undefined;
  if (ownerUid !== undefined && Number.isFinite(ownerUid)) {
    log(`socket will be restricted to uid ${ownerUid}`);
  }

  const commit = () => {
    saveState(state);
    try {
      applyBlocklist(state, Date.now());
    } catch (e) {
      log(`hosts apply failed: ${String(e)}`);
    }
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
