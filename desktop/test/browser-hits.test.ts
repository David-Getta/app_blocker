// A böngésző megakadás-könyve a segédnél: tisztítás, forrásonként csere,
// összegzés az elmúlt hét napra — és a heti mondat sora.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  HIT_NUDGE_STEPS, MAX_HITS_PER_DAY, MAX_HIT_DAYS, MAX_HIT_SOURCES, PEAK_WARN_LEAD_MS, PEAK_WARN_MIN_COUNT,
  browserHits7d, browserHitsBetween, browserHitsPeakHour, browserHitsSeries, browserHitsToday, cleanBrowserHitDays,
  cleanBrowserHits, hitDayKey, hitNudgeStep, hitNudgeText, hourLabel, peakWarnKey, peakWarnText, putBrowserHits,
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

test('a hét alakja: hét nap, a legrégebbi elöl, a források összeadva, az üres nap nulla', () => {
  let book = putBrowserHits(undefined, 'a', [{ day: '2026-09-18', total: 2 }, { day: '2026-09-12', total: 1 }]);
  book = putBrowserHits(book, 'b', [{ day: '2026-09-18', total: 3 }, { day: '2026-09-11', total: 9 }]);
  const series = browserHitsSeries(book, NOW, 7);
  assert.equal(series.length, 7);
  assert.equal(series[0].day, '2026-09-12');
  assert.equal(series[6].day, '2026-09-18');
  assert.deepEqual(series.map((d) => d.total), [1, 0, 0, 0, 0, 0, 5], 'a 11. már nem a hété; a 18. két forrás összege');
  assert.deepEqual(browserHitsSeries(undefined, NOW, 2).map((d) => d.total), [0, 0]);
});

test('az órák a hídról: huszonnégy rekesz, a napi összegnél nem több; a csúcs-óra a források összegéből', () => {
  const hours = (h: number, n: number): number[] => { const a = new Array<number>(24).fill(0); a[h] = n; return a; };
  const clean = cleanBrowserHitDays([
    { day: '2026-09-18', total: 2, byReason: {}, byHour: hours(21, 9) },
    { day: '2026-09-17', total: 1, byReason: {}, byHour: [1, 2] },
  ]);
  assert.deepEqual(clean[1].byHour?.[21], 2, 'a rekesz nem mondhat többet a napnál');
  assert.equal(clean[0].byHour, undefined, 'a rossz hosszú lista nem rekesz');
  let book = putBrowserHits(undefined, 'a', [{ day: '2026-09-18', total: 3, byReason: {}, byHour: hours(21, 3) }]);
  book = putBrowserHits(book, 'b', [{ day: '2026-09-17', total: 5, byReason: {}, byHour: hours(9, 5) },
    { day: '2026-09-11', total: 9, byReason: {}, byHour: hours(9, 9) }]);
  assert.deepEqual(browserHitsPeakHour(book, NOW), { hour: 9, count: 5 }, 'a nyolc napos nem számít');
  assert.equal(browserHitsPeakHour(undefined, NOW), null);
  assert.equal(hourLabel(21), '21–22 óra');
});

test('a mondat a csúcs-órával; a sokadik megakadás lépcsői', () => {
  const base = {
    last7Seconds: 0, topWeekSites: [], weekOverWeek: [], daysTracked: 0,
    focusWeek: summarizeFocus([], 0, NOW), unlocks7d: 0,
  };
  assert.equal(digestText({ ...base, browserHits7d: 12, browserHitsPeak: { hour: 21, count: 7 } }, (l) => l),
    'Elmúlt 7 nap: 12 megakadás a böngészőben, a csúcs 21–22 óra.');
  assert.equal(digestText({ ...base, browserHits7d: 12, browserHitsPeak: null }, (l) => l),
    'Elmúlt 7 nap: 12 megakadás a böngészőben.');
  assert.deepEqual(HIT_NUDGE_STEPS, [5, 10, 20]);
  assert.equal(hitNudgeStep(0), 0);
  assert.equal(hitNudgeStep(4), 0);
  assert.equal(hitNudgeStep(5), 5);
  assert.equal(hitNudgeStep(12), 10);
  assert.equal(hitNudgeStep(40), 20);
  assert.match(hitNudgeText(5), /^Ma már 5 megakadás/);
});

test('előjelzés a csúcs-óra előtt: tíz perces ablak, naponta egy kulcs, a nulla óra az előző estén', () => {
  const peak = { hour: 21, count: 7 };
  const at2 = (hh: number, mm: number, d = 18): number => new Date(2026, 8, d, hh, mm).getTime();
  assert.equal(PEAK_WARN_LEAD_MS, 10 * 60_000);
  assert.equal(PEAK_WARN_MIN_COUNT, 3);
  assert.equal(peakWarnKey(peak, at2(20, 49)), null, 'tizenegy perccel előtte még nem');
  assert.equal(peakWarnKey(peak, at2(20, 50)), '2026-09-18:21');
  assert.equal(peakWarnKey(peak, at2(20, 59)), '2026-09-18:21');
  assert.equal(peakWarnKey(peak, at2(21, 0)), null, 'az órában már nem előjelzés');
  assert.equal(peakWarnKey({ hour: 21, count: 2 }, at2(20, 55)), null, 'kettő nem csúcs');
  assert.equal(peakWarnKey(null, at2(20, 55)), null);
  assert.equal(peakWarnKey({ hour: 0, count: 3 }, at2(23, 55)), '2026-09-19:0', 'a nulla óra ablaka az előző este');
  assert.equal(peakWarnKey({ hour: 0, count: 3 }, at2(0, 5, 19)), null);
  assert.equal(peakWarnText(peak),
    'Mindjárt 21 óra — a héten ilyenkor akadt meg a kéz a legtöbbször (7×). Egy munkamenet most segítene — te döntesz.');
});
