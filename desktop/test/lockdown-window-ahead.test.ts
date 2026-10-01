// A zárlat-ablak előre-listája a böngésző-hídnak.
//
// A segéd az ablak zárlatát az app nélkül is elindítja; a tiltó lap viszont
// csak a hídon, a futó apptól tudott róla, és zárva lévő app mellett olyan
// feloldást ígért, ami a zárlat alatt nincs. Az app ezért egy hetet előre
// leküld — ennek a listának ugyanazokat az előfordulásokat kell mondania,
// amiket a segéd köre (`dueLockdownWindow`) a maga idejében elindít.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { dueLockdownWindow, upcomingLockdownWindows, type LockdownWindow } from '../src/shared/lockdown';
import { MAX_WINDOW_OCCURRENCES, WINDOW_LOOKAHEAD_DAYS } from '../src/shared/focus';

/** Helyi idő — az ablak is helyi időben él. 2026. szeptember 7. hétfő. */
const at = (d: number, h: number, m = 0): number => new Date(2026, 8, d, h, m).getTime();
const MON = (h: number, m = 0): number => at(7, h, m);
const TUE = (h: number, m = 0): number => at(8, h, m);
const SUN = (h: number, m = 0): number => at(6, h, m);

const WORK: LockdownWindow = { id: 'w', days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 17 * 60 };
/** hétfő este → kedd hajnal */
const NIGHT: LockdownWindow = { id: 'n', days: [1], startMin: 22 * 60, endMin: 6 * 60 };

test('a következő hét előfordulásai, kezdés szerint — a most tartó is', () => {
  const list = upcomingLockdownWindows([WORK], SUN(20));
  assert.equal(WINDOW_LOOKAHEAD_DAYS, 7);
  assert.deepEqual(list, [7, 8, 9, 10, 11].map((d) => ({ startsAt: at(d, 9), endsAt: at(d, 17) })));
  assert.deepEqual(upcomingLockdownWindows([WORK], MON(12))[0], { startsAt: MON(9), endsAt: MON(17) }, 'a mostani is');
  assert.deepEqual(upcomingLockdownWindows([WORK], MON(17))[0], { startsAt: TUE(9), endsAt: TUE(17) },
    'a vég percében már a következő');
});

test('a tegnapról átnyúló is benne van, amíg tart', () => {
  assert.deepEqual(upcomingLockdownWindows([NIGHT], TUE(1))[0], { startsAt: MON(22), endsAt: TUE(6) });
  assert.deepEqual(upcomingLockdownWindows([NIGHT], TUE(6))[0], { startsAt: at(14, 22), endsAt: at(15, 6) });
});

test('ugyanazt mondja, amit a segéd köre a maga idejében elindít', () => {
  // Óránként végigmegyünk a héten: ahol a kör zárlatot indítana, ott a lista
  // egy előfordulása tart, ugyanazzal a véggel — és fordítva.
  const windows = [WORK, NIGHT];
  const list = upcomingLockdownWindows(windows, SUN(20));
  for (let t = SUN(20); t < SUN(20) + 7 * 24 * 3600_000; t += 30 * 60_000) {
    const due = dueLockdownWindow(windows, t);
    const covering = list.filter((o) => o.startsAt <= t && t < o.endsAt);
    const latest = covering.reduce<number | null>((m, o) => (m === null || o.endsAt > m ? o.endsAt : m), null);
    assert.equal(latest, due ? due.endsAt : null, `eltérés: ${new Date(t).toString()}`);
  }
});

test('az érvénytelen ablak kimarad, az azonos előfordulás egyszer, a lista korlátos', () => {
  const bad = { id: 'b', days: [], startMin: 600, endMin: 660 } as unknown as LockdownWindow;
  const twin: LockdownWindow = { ...WORK, id: 'w-masik' };
  assert.deepEqual(upcomingLockdownWindows([bad, WORK, twin], SUN(20)), upcomingLockdownWindows([WORK], SUN(20)));
  assert.deepEqual(upcomingLockdownWindows([], SUN(20)), []);
  const many = Array.from({ length: 20 }, (_, i): LockdownWindow =>
    ({ id: `x${i}`, days: [0, 1, 2, 3, 4, 5, 6], startMin: i * 60, endMin: i * 60 + 30 }));
  assert.equal(upcomingLockdownWindows(many, SUN(20)).length, MAX_WINDOW_OCCURRENCES);
});
