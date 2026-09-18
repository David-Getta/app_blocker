// A heti napló a SEGÉDBEN: a hét sora akkor is íródik, ha az app nem fut.
// A hétfői értesítés a felületé; a napló könyvelés, és a mindig futó segéd
// könyvel — ugyanúgy, mint a telefonon a szűrő szolgáltatása.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { defaultState, newId, type HelperState } from '../src/helper/state';
import { digestTextNow, helperLabel, journalTick } from '../src/helper/digest-journal';
import * as referee from '../src/helper/referee';

const at = (y: number, m: number, d: number, hh: number, mm = 0): number =>
  new Date(y, m - 1, d, hh, mm).getTime();
const DAY = 86_400_000;
// 2026. szeptember 7. hétfő, reggel nyolc: a hét esedékes.
const MONDAY_8 = at(2026, 9, 7, 8);

function weekState(now: number): HelperState {
  const state = defaultState();
  state.unlockLog = [now - 2 * DAY, now - 20 * DAY];
  // A félbemaradt kísérletek ugyanezzel az ablakkal: a húsz napos nem az elmúlt hété.
  state.droppedAttempts = [now - 3 * DAY, now - 20 * DAY];
  state.focusLog = [{
    packId: 'p', packName: 'Nyelvtanulás',
    startedAt: now - 3 * DAY, endedAt: now - 3 * DAY + 3600_000, plannedEndsAt: now - 3 * DAY + 3600_000, stopped: false,
  }];
  state.sites.push({
    id: newId('site'), domain: 'youtube.com', hostnames: ['youtube.com', 'www.youtube.com'],
    addedAt: now - 30 * DAY, pauseUntil: null, pendingDeleteAt: null,
  });
  return state;
}

test('a segéd köre hétfő reggel beírja a hét sorát — egyszer, és az app nélkül', () => {
  const state = weekState(MONDAY_8);
  assert.equal(journalTick(state, at(2026, 9, 7, 6, 59)), false, 'hétfő 6:59: még nem esedékes');
  // Kifejezésen, nem a mezőn: a szigorú assert a mező típusát örökre leszűkítené.
  assert.equal((state.digestLog ?? []).length, 0, 'még nincs napló');
  assert.equal(journalTick(state, MONDAY_8), true);
  assert.equal(state.digestWeekKey, '2026-09-07');
  assert.deepEqual(state.digestLog ?? [], [{
    week: '2026-09-07', text: 'Elmúlt 7 nap: 1 menet (1 ó 0 p, mind végigvive). A négy hét menet-napja: péntek (1 menet). 1 feloldás, 1 félbemaradt kísérlet.',
  }]);
  assert.equal(journalTick(state, MONDAY_8 + 3600_000), false, 'ezen a héten már volt');
  assert.equal((state.digestLog ?? []).length, 1);
  // A következő hétfőn újra — és a legfrissebb elöl.
  const next = at(2026, 9, 14, 9);
  state.unlockLog.push(next - DAY);
  assert.equal(journalTick(state, next), true);
  assert.deepEqual((state.digestLog ?? []).map((e) => e.week), ['2026-09-14', '2026-09-07']);
});

test('a bíró köre NEM ír naplót: a könyvelés a segéd időzítőjéé, a bíróé az érvényesítés', () => {
  const state = weekState(MONDAY_8);
  assert.equal(referee.tick(state, MONDAY_8), false, 'nincs mit érvényesíteni: a kör tiszta');
  assert.equal(state.digestWeekKey, undefined);
});

test('üres hét: a hét el van könyvelve, sor nincs', () => {
  const state = defaultState();
  assert.equal(journalTick(state, MONDAY_8), true);
  assert.equal(state.digestWeekKey, '2026-09-07');
  assert.deepEqual(state.digestLog ?? null, []);
});

test('a segéd címkézése a beállításé: rejtett listánál sorszám, fedőnévnél a fedőnév', () => {
  const state = weekState(MONDAY_8);
  assert.equal(helperLabel(state)('youtube.com'), 'youtube.com');
  assert.equal(helperLabel(state)('github.com'), 'github.com', 'ami nincs a listán, marad');
  state.hideSiteList = true;
  assert.equal(helperLabel(state)('youtube.com'), '1. rejtett oldal');
  state.sites[0].alias = 'A videós';
  assert.equal(helperLabel(state)('youtube.com'), 'A videós', 'a fedőnév erősebb a rejtésnél');
  assert.equal(digestTextNow(state, MONDAY_8),
    'Elmúlt 7 nap: 1 menet (1 ó 0 p, mind végigvive). A négy hét menet-napja: péntek (1 menet). 1 feloldás, 1 félbemaradt kísérlet.');
});
