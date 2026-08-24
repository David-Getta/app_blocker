// A szinkron ütemezésének egyetlen igazi kérdése: nem hurkol-e.
//
// A hurok így nézne ki, és semmi nem árulja el ránézésre:
//
//   a szinkron a végén MENT,
//   a mentés ÜTEMEZ egy szinkront,
//   az a szinkron megint ment…
//
// Ettől a segéd húsz másodpercenként, örökre verné a kiszolgálót, miközben
// minden függvény külön-külön helyes. Ezért van rá teszt.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createSyncSchedule } from '../src/helper/sync-schedule';

/** Kézzel hajtott időzítő: a teszt nem várakozik valós időt. */
function fakeTimers() {
  const queued: (() => void)[] = [];
  return {
    setTimer: (fn: () => void) => { queued.push(fn); return queued.length; },
    clearTimer: (h: unknown) => { queued[(h as number) - 1] = () => { /* törölve */ }; },
    fire: () => { const all = queued.splice(0); for (const fn of all) fn(); },
    count: () => queued.length,
  };
}

test('a sync that commits does not schedule another sync', async () => {
  const t = fakeTimers();
  let runs = 0;
  const s = createSyncSchedule({
    hasAccount: () => true,
    run: async () => {
      runs++;
      // Ezt teszi a valódi kód: a kör végén ment, a mentés pedig értesít.
      s.notifyCommit();
    },
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
  }, 20_000);

  s.notifyCommit();
  assert.equal(s.pending(), true, 'egy változás ütemez egy kört');
  t.fire();
  await new Promise((r) => setImmediate(r));

  assert.equal(runs, 1);
  assert.equal(s.pending(), false, 'a kör saját mentése NEM ütemez újat — ez volt a hurok');
});

test('several changes in a row become one sync, not three', async () => {
  const t = fakeTimers();
  let runs = 0;
  const s = createSyncSchedule({
    hasAccount: () => true,
    run: async () => { runs++; },
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
  }, 20_000);

  s.notifyCommit();
  s.notifyCommit();
  s.notifyCommit();
  t.fire();
  await new Promise((r) => setImmediate(r));
  assert.equal(runs, 1, 'egy műveletsor egy feltöltés');
});

test('without an account nothing is scheduled and nothing runs', async () => {
  const t = fakeTimers();
  let runs = 0;
  const s = createSyncSchedule({
    hasAccount: () => false,
    run: async () => { runs++; },
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
  }, 20_000);

  s.notifyCommit();
  assert.equal(s.pending(), false);
  await s.runNow('időzített');
  assert.equal(runs, 0, 'fiók nélkül nincs mit szinkronizálni');
});

test('two syncs never overlap', async () => {
  const t = fakeTimers();
  let running = 0;
  let maxParallel = 0;
  let release: (() => void) | null = null;
  const s = createSyncSchedule({
    hasAccount: () => true,
    run: async () => {
      running++;
      maxParallel = Math.max(maxParallel, running);
      await new Promise<void>((r) => { release = r; });
      running--;
    },
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
  }, 20_000);

  const first = s.runNow('indulás');
  await new Promise((r) => setImmediate(r));
  // Közben jön az időzített kör is: nem szabad ráindulnia ugyanarra az állapotra.
  await s.runNow('időzített');
  assert.equal(maxParallel, 1, 'két kör sosem fut egyszerre ugyanazon az állapoton');
  release!();
  await first;
});

test('a pending schedule is dropped when a sync starts anyway', async () => {
  const t = fakeTimers();
  let runs = 0;
  const s = createSyncSchedule({
    hasAccount: () => true,
    run: async () => { runs++; },
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
  }, 20_000);

  s.notifyCommit();
  assert.equal(s.pending(), true);
  await s.runNow('időzített');
  assert.equal(s.pending(), false, 'a felfüggesztett kör fölösleges, ha most futott egy');
  t.fire();
  await new Promise((r) => setImmediate(r));
  assert.equal(runs, 1, 'és nem is fut le még egyszer');
});
