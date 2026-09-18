// A böngésző megakadás-könyve a segédnél: tisztítás, forrásonként csere,
// összegzés az elmúlt hét napra — és a heti mondat sora.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  MAX_HITS_PER_DAY, MAX_HIT_DAYS, MAX_HIT_SOURCES, browserHits7d, browserHitsBetween, browserHitsToday,
  cleanBrowserHitDays, cleanBrowserHits, hitDayKey, putBrowserHits,
} from '../src/shared/browser-hits';
import { digestText } from '../src/shared/digest';
import { summarizeFocus } from '../src/shared/focus';
import { defaultState } from '../src/helper/state';
import { digestTextNow } from '../src/helper/digest-journal';

const at = (y: number, m: number, d: number, hh = 12): number => new Date(y, m - 1, d, hh).getTime();
const NOW = at(2026, 9, 18);

test('a napok tisztán: jó nap, pozitív egész a plafonig, okonként csak az ismert, naponként egyszer', () => {
  const days = cleanBrowserHitDays([
    { day: '2026-09-18', total: 2.9, byReason: { keyword: 2, semmi: 5, closed: -1 } },
    { day: '2026-09-17', total: 0 },
    { day: '2026-09-16', total: 1, byReason: 'nem' },
    { day: 'nem nap', total: 3 },
    { day: '2026-09-18', total: 4, byReason: { closed: 9 } }, // ugyanaz a nap még egyszer: az utolsó marad
    null, 42, 'szöveg',
    { day: '2026-09-15', total: MAX_HITS_PER_DAY * 5 },
  ]);
  assert.deepEqual(days, [
    { day: '2026-09-15', total: MAX_HITS_PER_DAY, byReason: {} },
    { day: '2026-09-16', total: 1, byReason: {} },
    { day: '2026-09-18', total: 4, byReason: { closed: 4 } },
  ]);
  const many = Array.from({ length: MAX_HIT_DAYS + 5 }, (_, i) => ({ day: hitDayKey(NOW - i * 86_400_000), total: 1 }));
  const kept = cleanBrowserHitDays(many);
  assert.equal(kept.length, MAX_HIT_DAYS);
  assert.equal(kept[kept.length - 1].day, '2026-09-18', 'a legfrissebbek maradnak');
});

test('a könyv forrásonként: csere, törlés üres jelentéssel, rossz azonosító nem forrás, plafon', () => {
  let book = putBrowserHits(undefined, 'chrome1', [{ day: '2026-09-18', total: 2, byReason: { keyword: 2 } }]);
  book = putBrowserHits(book, 'edge_2', [{ day: '2026-09-18', total: 1 }, { day: '2026-09-12', total: 3 }]);
  assert.deepEqual(Object.keys(book), ['chrome1', 'edge_2']);
  assert.equal(browserHitsToday(book, NOW), 3, 'a két böngésző összeadódik');
  assert.equal(browserHits7d(book, NOW), 6, 'a hét legrégebbi napja (12.) benne');
  assert.equal(browserHitsBetween(book, '2026-09-13', '2026-09-18'), 3);
  // Csere: a forrás mindig a teljes hetét küldi, a régi sorai mennek.
  book = putBrowserHits(book, 'chrome1', [{ day: '2026-09-18', total: 5 }]);
  assert.equal(browserHitsToday(book, NOW), 6);
  book = putBrowserHits(book, 'chrome1', []);
  assert.equal(book.chrome1, undefined, 'az üres jelentés törli a forrást');
  assert.deepEqual(putBrowserHits(book, 'rossz azonosító!', [{ day: '2026-09-18', total: 1 }]), book);
  let full: ReturnType<typeof putBrowserHits> = {};
  for (let i = 0; i < MAX_HIT_SOURCES + 2; i++) full = putBrowserHits(full, `src${i}`, [{ day: '2026-09-18', total: 1 }]);
  assert.equal(Object.keys(full).length, MAX_HIT_SOURCES, 'a plafon fölött az új forrás nem fér');
  assert.equal(putBrowserHits(full, 'src0', [{ day: '2026-09-18', total: 7 }]).src0[0].total, 7, 'a meglévő forrás cserélhető');
  assert.deepEqual(cleanBrowserHits('szemét'), {});
  assert.deepEqual(cleanBrowserHits({ 'x y': [{ day: '2026-09-18', total: 1 }], ok: 'nem lista', ok2: [] }), {});
});

test('a mondat: a megakadás a feloldások után, tényként — nulla nem sor', () => {
  const base = {
    last7Seconds: 0, topWeekSites: [], weekOverWeek: [], daysTracked: 0,
    focusWeek: summarizeFocus([], 0, NOW),
    unlocks7d: 1,
  };
  assert.equal(digestText({ ...base, browserHits7d: 12 }, (l) => l), 'Elmúlt 7 nap: 1 feloldás. 12 megakadás a böngészőben.');
  assert.equal(digestText({ ...base, unlocks7d: 0, browserHits7d: 3 }, (l) => l), 'Elmúlt 7 nap: 3 megakadás a böngészőben.',
    'megakadás feloldás nélkül is mondat');
  assert.equal(digestText({ ...base, browserHits7d: 0 }, (l) => l), 'Elmúlt 7 nap: 1 feloldás.');
  assert.equal(digestText({ ...base, unlocks7d: 0 }, (l) => l), null, 'semmi: nincs mondat');
});

test('a segéd mondata a könyvből: a forrásokat összeadja, az ablak a mai nap kezdete mínusz hat nap', () => {
  const state = defaultState();
  state.unlockLog = [NOW - 86_400_000];
  state.browserHits = putBrowserHits(undefined, 'a', [{ day: '2026-09-18', total: 2 }, { day: '2026-09-11', total: 9 }]);
  state.browserHits = putBrowserHits(state.browserHits, 'b', [{ day: '2026-09-12', total: 1 }]);
  assert.equal(digestTextNow(state, NOW), 'Elmúlt 7 nap: 1 feloldás. 3 megakadás a böngészőben.');
});
