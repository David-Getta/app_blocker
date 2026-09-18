// A közelgő zárlat-ablak jelzése: tíz perccel a beérés előtt egyszer.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { windowStartingSoon, WINDOW_PRE_WARN_MS, type LockdownWindow } from '../src/shared/lockdown';

/** 2026. szeptember 7., hétfő — helyi idő. */
const MON = (h: number, m = 0): number => new Date(2026, 8, 7, h, m).getTime();
const work: LockdownWindow = { id: 'w', days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 17 * 60 };

test('a közelgő ablak: tíz percen belül jelez, bent és túlérő zárlat alatt nem', () => {
  assert.equal(WINDOW_PRE_WARN_MS, 10 * 60_000);
  const occ = windowStartingSoon(null, [work], MON(8, 55));
  assert.deepEqual(occ, { startsAt: MON(9), endsAt: MON(17) }, 'tíz percen belül: jelez');
  assert.equal(windowStartingSoon(null, [work], MON(8, 45)), null, 'negyed óra még sok');
  assert.equal(windowStartingSoon(null, [work], MON(9, 5)), null, 'bent már nem közelgő');
  assert.equal(windowStartingSoon({ startedAt: MON(8), until: MON(18) }, [work], MON(8, 55)), null,
    'a futó zárlat túlér rajta: nincs miről szólni');
  assert.deepEqual(windowStartingSoon({ startedAt: MON(8), until: MON(12) }, [work], MON(8, 55)), occ,
    'a rövidebb zárlatot kitolja: jelez');
  assert.deepEqual(windowStartingSoon({ startedAt: MON(7), until: MON(8, 30) }, [work], MON(8, 55)), occ,
    'a lejárt zárlat nem számít');
  // Két ablak: a hamarabb kezdődő szól — a másik majd a maga idejében.
  const late: LockdownWindow = { id: 'l', days: [1], startMin: 9 * 60 + 3, endMin: 20 * 60 };
  assert.deepEqual(windowStartingSoon(null, [late, work], MON(8, 55)), { startsAt: MON(9), endsAt: MON(17) });
  assert.equal(windowStartingSoon(null, [], MON(8, 55)), null, 'ablak nélkül nincs mit jelezni');
});
