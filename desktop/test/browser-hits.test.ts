// A böngésző megakadás-könyve a segédnél: tisztítás, forrásonként csere,
// összegzés az elmúlt hét napra — és a heti mondat sora.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  HIT_NUDGE_STEPS, HIT_REASON_LABELS, MAX_HITS_PER_DAY, MAX_HIT_DAYS, MAX_HIT_SOURCES, MAX_TOP_HOSTS,
  PEAK_WARN_LEAD_MS, PEAK_WARN_MIN_COUNT, browserHits7d, browserHitsBetween, browserHitsByHour, browserHitsByKeyword, browserHitsByReason,
  browserHitsPeakHour,
  browserHitsPrev7d, browserHitsSeries, browserHitsToday, browserHitsTopSite, cleanBrowserHitDays, cleanBrowserHits, hitDayKey,
  monthHasOlderHits,
  hitNudgeStep, hitNudgeText, hitsKeywordLine, hitsReasonLine, hitsTrendText, hostSite, hourLabel, isPeakNow, peakNowText,
  peakWarnKey, peakWarnText,
  putBrowserHits,
  browserHitsByWeekday, peakWeekday, peakWeekdayText,
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
  // Csere: a forrás mindig a teljes két hetét küldi, a régi sorai mennek.
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
  assert.equal(digestTextNow(state, NOW), 'Elmúlt 7 nap: 1 feloldás. 3 megakadás a böngészőben (az előző héten 9). A négy hét csúcs-napja: péntek (11 megakadás).',
    'a 11. az előző hété — a mondat a szám mellett mondja');
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
  // A HÓNAP rajza csak akkor mond többet a hétnél, ha a hét előtt is volt.
  const month = browserHitsSeries(book, NOW, 30);
  assert.equal(month.length, 30);
  assert.equal(monthHasOlderHits(month), true, 'a 11. a hét előtt van, a hónapé: a rajz áll');
  const weekOnly = putBrowserHits(undefined, 'a', [{ day: '2026-09-18', total: 2 }, { day: '2026-09-12', total: 1 }]);
  assert.equal(monthHasOlderHits(browserHitsSeries(weekOnly, NOW, 30)), false, 'csak a hét napjain volt: a hónap rajza nem áll');
  assert.equal(monthHasOlderHits([]), false);
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
  const by = browserHitsByHour(book, NOW);
  assert.equal(by.length, 24, 'az órák sávja huszonnégy rekesz');
  assert.equal(by[9], 5, 'a rekesz a források összege a héten — a nyolc napos nélkül');
  assert.equal(by[21], 3);
  assert.equal(by.reduce((a, b) => a + b, 0), 8);
  assert.deepEqual(browserHitsByHour(undefined, NOW), new Array(24).fill(0), 'könyv nélkül csupa nulla');
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
  assert.equal(digestText({ ...base, browserHits7d: 12, browserHitsPeak: { hour: 21, count: 7 }, browserHitsPeakPack: 'Nyelvtanulás' }, (l) => l),
    'Elmúlt 7 nap: 12 megakadás a böngészőben, a csúcs 21–22 óra (magától indul: Nyelvtanulás).', 'a lefedett csúcs-óra a csúcs mellett');
  assert.equal(digestText({ ...base, browserHits7d: 12, browserHitsPeak: null, browserHitsPeakPack: 'Nyelvtanulás' }, (l) => l),
    'Elmúlt 7 nap: 12 megakadás a böngészőben.', 'csúcs nélkül a csomag sem szerepel');
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
  assert.equal(isPeakNow(peak, at2(21, 0)), true, 'az óra elején már most van');
  assert.equal(isPeakNow(peak, at2(21, 59)), true);
  assert.equal(isPeakNow(peak, at2(20, 59)), false, 'előtte még nem');
  assert.equal(isPeakNow(peak, at2(22, 0)), false, 'utána már nem');
  assert.equal(isPeakNow(null, at2(21, 0)), false);
  assert.equal(peakNowText(peak, at2(21, 30)),
    ' Most a hét csúcs-órája van (21–22 óra, 7 megakadás a héten) — ilyenkor jár a kéz magától.');
  assert.equal(peakNowText(peak, at2(20, 30)), '', 'a csúcs-órán kívül a láb nem mondja');
  assert.equal(peakNowText(null, at2(21, 30)), '');
});

test('okonként a héten: minden forrásból, a legnagyobb elöl, a sor a bővítmény neveivel', () => {
  let book = putBrowserHits(undefined, 'a', [{ day: '2026-09-18', total: 5, byReason: { closed: 3, keyword: 2 } }]);
  book = putBrowserHits(book, 'b', [{ day: '2026-09-17', total: 4, byReason: { closed: 1, focus: 3 } },
    { day: '2026-09-11', total: 9, byReason: { channel: 9 } }]);
  assert.deepEqual(browserHitsByReason(book, NOW), [
    { reason: 'closed', count: 4 }, { reason: 'focus', count: 3 }, { reason: 'keyword', count: 2 },
  ], 'a nyolc napos nem számít');
  assert.equal(hitsReasonLine(browserHitsByReason(book, NOW)), '4 zárva oldal · 3 munkamenet · 2 kulcsszó');
  assert.deepEqual(browserHitsByReason(undefined, NOW), []);
  assert.equal(hitsReasonLine([]), '');
  assert.equal(HIT_REASON_LABELS.rule, 'részleges szabály');
  // Holtversenyben az okok rögzített sorrendje: a sor nem ugrál két frissítés között.
  const tie = putBrowserHits(undefined, 'a', [{ day: '2026-09-18', total: 4, byReason: { keyword: 2, closed: 2 } }]);
  assert.deepEqual(browserHitsByReason(tie, NOW).map((r) => r.reason), ['closed', 'keyword']);
});

test('a hét csúcs-oldala: az élboly a hídról tisztán, a hoszt a lista tételéhez rendelve, holtversenynél az ábécé', () => {
  const days = cleanBrowserHitDays([{
    day: '2026-09-18', total: 5, byReason: {},
    topHosts: [['www.YouTube.com.', 3], ['reddit.com', 9], ['', 2], ['x.com', 0], ['dup.com', 1], ['dup.com', 1], ['a.com', 1], ['b.com', 1], ['c.com', 1]],
  }]);
  assert.deepEqual(days[0].topHosts, [['www.youtube.com', 3], ['reddit.com', 5], ['dup.com', 1], ['a.com', 1], ['b.com', 1]],
    'kisbetű, záró pont nélkül, a plafon a napi összeg, hosztonként egyszer, legfeljebb öt');
  assert.equal(cleanBrowserHitDays([{ day: '2026-09-18', total: 1, byReason: {} }])[0].topHosts, undefined);
  assert.equal(MAX_TOP_HOSTS, 5);
  const sites = [{ domain: 'youtube.com', hostnames: ['youtube.com', 'www.youtube.com'] }];
  assert.equal(hostSite('M.YouTube.com.', sites), 'youtube.com');
  assert.equal(hostSite('notyoutube.com', sites), 'notyoutube.com', 'a hasonló név nem az oldal');
  let book = putBrowserHits(undefined, 'a', [{ day: '2026-09-18', total: 4, byReason: {}, topHosts: [['www.youtube.com', 2], ['reddit.com', 2]] }]);
  book = putBrowserHits(book, 'b', [{ day: '2026-09-17', total: 1, byReason: {}, topHosts: [['m.youtube.com', 1]] },
    { day: '2026-09-11', total: 9, byReason: {}, topHosts: [['old.com', 9]] }]);
  assert.deepEqual(browserHitsTopSite(book, NOW, sites), { label: 'youtube.com', count: 3 }, 'két hoszt egy oldal; a nyolc napos nem számít');
  const tie = putBrowserHits(undefined, 'a', [{ day: '2026-09-18', total: 2, byReason: {}, topHosts: [['b.com', 1], ['a.com', 1]] }]);
  assert.deepEqual(browserHitsTopSite(tie, NOW, []), { label: 'a.com', count: 1 }, 'holtverseny: az ábécé');
  assert.equal(browserHitsTopSite(undefined, NOW, sites), null);
  const base = {
    last7Seconds: 0, topWeekSites: [], weekOverWeek: [], daysTracked: 0,
    focusWeek: summarizeFocus([], 0, NOW), unlocks7d: 0,
  };
  assert.equal(digestText({ ...base, browserHits7d: 12, browserHitsPeak: { hour: 21, count: 7 }, browserHitsTop: { label: 'youtube.com', count: 5 } },
    (l) => (l === 'youtube.com' ? 'A videós' : l)),
  'Elmúlt 7 nap: 12 megakadás a böngészőben, a csúcs 21–22 óra, a legtöbbször: A videós (5×).');
});

test('a hét az előző héthez képest: a 13.–7. nap, a mondat a két számmal — előző hét nélkül nincs', () => {
  const d = (back: number): string => hitDayKey(NOW - back * 86_400_000);
  const book = putBrowserHits(undefined, 'chrome1', [
    { day: d(0), total: 2 }, { day: d(6), total: 3 },
    { day: d(7), total: 9 }, { day: d(13), total: 4 },
    { day: d(14), total: 100 }, // tizennégy napja: egyik hété sem
  ]);
  assert.equal(browserHits7d(book, NOW), 5);
  assert.equal(browserHitsPrev7d(book, NOW), 13, 'a hetedik és a tizenharmadik nap benne, a tizennegyedik nem');
  assert.equal(browserHitsPrev7d(undefined, NOW), 0);
  assert.equal(hitsTrendText(12, 18), 'A héten 12 megakadás, az előző héten 18.');
  assert.equal(hitsTrendText(0, 18), 'A héten 0 megakadás, az előző héten 18.', 'a nulla hét is mondat, ha volt mihez mérni');
  assert.equal(hitsTrendText(12, 0), '', 'előző hét nélkül nincs összehasonlítás');
  const base = {
    last7Seconds: 0, topWeekSites: [], weekOverWeek: [], daysTracked: 0,
    focusWeek: summarizeFocus([], 0, NOW), unlocks7d: 0,
  };
  assert.equal(digestText({ ...base, browserHits7d: 12, browserHitsPrev7d: 18 }, (l) => l),
    'Elmúlt 7 nap: 12 megakadás a böngészőben (az előző héten 18).');
  assert.equal(digestText({ ...base, browserHits7d: 0, browserHitsPrev7d: 18 }, (l) => l),
    'Elmúlt 7 nap: Megakadás nélkül a böngészőben (az előző héten 18).', 'a nulla hét is mondat, ha volt mihez mérni');
  assert.equal(digestText({ ...base, browserHits7d: 12, browserHitsPrev7d: 18, browserHitsPeak: { hour: 21, count: 7 } }, (l) => l),
    'Elmúlt 7 nap: 12 megakadás a böngészőben (az előző héten 18), a csúcs 21–22 óra.', 'az előző hét a szám mellett, a csúcs utána');
  assert.equal(digestText({ ...base, browserHits7d: 12, browserHitsPrev7d: 0 }, (l) => l),
    'Elmúlt 7 nap: 12 megakadás a böngészőben.', 'előző hét nélkül a régi mondat');
});

test('kulcsszavanként a hídról: az élboly tisztán, a hét összege, a sor', () => {
  const days = cleanBrowserHitDays([
    { day: '2026-09-18', total: 5, byReason: { keyword: 5 }, topKeywords: [['Shorts', 3], ['reels', 9], ['', 1], ['shorts', 1], 'nem'] },
    { day: '2026-09-11', total: 2, byReason: { keyword: 2 }, topKeywords: [['live', 2]] },
  ]);
  assert.deepEqual(days[1].topKeywords, [['shorts', 3], ['reels', 5]], 'kisbetűs, egyszer, a napi összegig');
  const book = putBrowserHits(undefined, 'chrome1', days);
  assert.deepEqual(browserHitsByKeyword(book, NOW), [{ keyword: 'reels', count: 5 }, { keyword: 'shorts', count: 3 }], 'a nyolc napja nem a hété');
  assert.equal(hitsKeywordLine(browserHitsByKeyword(book, NOW)), 'reels 5 · shorts 3');
  assert.equal(hitsKeywordLine([]), '');
  assert.deepEqual(browserHitsByKeyword(undefined, NOW), []);
});

test('a heti mondat mondja, ha a csúcs-órát nem fedi ablak — csak ha lehetne rá tenni; a fedés erősebb', () => {
  const peak = {
    last7Seconds: 0, topWeekSites: [], weekOverWeek: [], daysTracked: 0,
    focusWeek: summarizeFocus([], 0, NOW), unlocks7d: 0,
    browserHits7d: 12, browserHitsPeak: { hour: 21, count: 6 },
  };
  assert.equal(digestText({ ...peak, peakWindowOffer: true }, (l) => l),
    'Elmúlt 7 nap: 12 megakadás a böngészőben, a csúcs 21–22 óra (nincs rá ablak).');
  assert.equal(digestText({ ...peak, peakWindowOffer: false }, (l) => l),
    'Elmúlt 7 nap: 12 megakadás a böngészőben, a csúcs 21–22 óra.');
  assert.equal(digestText({ ...peak, peakWindowOffer: true, browserHitsPeakPack: 'Nyelvtanulás' }, (l) => l),
    'Elmúlt 7 nap: 12 megakadás a böngészőben, a csúcs 21–22 óra (magától indul: Nyelvtanulás).', 'a fedés erősebb');
});

test('a csúcs-nap: négy hétből, a hét napjaira osztva; holtversenynél a hét elejéhez közelebbi', () => {
  // 2026-09-18 péntek. Három péntek a négy hétben, a 28 nappal ezelőtti már nincs benne.
  const key = (back: number): string => hitDayKey(new Date(2026, 8, 18 - back).getTime());
  const book = putBrowserHits(undefined, 'a', [
    { day: key(0), total: 2 }, { day: key(7), total: 3 }, { day: key(14), total: 1 },
    { day: key(1), total: 5 }, { day: key(28), total: 100 },
  ]);
  const by = browserHitsByWeekday(book, NOW);
  assert.equal(by.length, 7);
  assert.equal(by[5], 6, 'péntek: három péntek összege, a huszonnyolc napos nélkül');
  assert.equal(by[4], 5, 'csütörtök');
  assert.deepEqual(peakWeekday(by), { day: 5, count: 6 });
  assert.deepEqual(peakWeekday([0, 0, 0, 0, 6, 6, 0]), { day: 4, count: 6 }, 'holtverseny: a hét elejéhez közelebbi (csütörtök a péntek előtt)');
  assert.deepEqual(peakWeekday([3, 0, 0, 0, 0, 0, 3]), { day: 6, count: 3 }, 'a vasárnap a hét vége: a szombat előbb jön');
  assert.equal(peakWeekday([0, 0, 0, 0, 0, 0, 0]), null);
  assert.deepEqual(browserHitsByWeekday(undefined, NOW), [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(peakWeekdayText({ day: 0, count: 14 }), 'A négy hét csúcs-napja: vasárnap (14 megakadás).');
});
