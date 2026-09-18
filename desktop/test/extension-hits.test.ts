// A KISZÁLLÍTOTT `extension/hits.js` szeletelt tesztje: a megakadás-könyv —
// naponként, okonként, harminc napig; a mondat és a hídra menő sorok.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

function extensionDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const cand = path.join(dir, 'extension');
    if (fs.existsSync(path.join(cand, 'hits.js'))) return cand;
    dir = path.dirname(dir);
  }
  throw new Error('nem talalom az extension/ mappat');
}

interface Hits {
  RETENTION_DAYS: number;
  dayKey: (d?: Date) => string;
  lastDays: (today: string, n: number) => string[];
  recordHit: (state: unknown, day: string, reason: string, host?: string, hour?: number, keyword?: string) => { days: Record<string, { total: number; byReason: Record<string, number> }> };
  sweepHits: (state: unknown, today: string) => { days: Record<string, unknown> };
  hitsOn: (state: unknown, day: string) => number;
  hitsSummary: (state: unknown, today: string) => { today: number; week: number; prevWeek: number; month: number };
  hitsMonth: (state: unknown, today: string) => { day: string; total: number }[];
  monthHasOlderHits: (series: { day: string; total: number }[]) => boolean;
  hitsTrendText: (s: { week: number; prevWeek: number }) => string | null;
  hitsReport: (state: unknown, today: string) => { day: string; total: number; byReason: Record<string, number>; topHosts?: [string, number][] }[];
  REPORT_DAYS: number;
  MAX_KEYWORDS_PER_DAY: number;
  keywordsWeek: (state: unknown, days: string[]) => { keyword: string; count: number }[];
  keywordsText: (rows: { keyword: string; count: number }[]) => string | null;
  idleKeywords: (keywords: unknown, rows: { keyword: string; count: number }[]) => string[];
  idleKeywordsText: (idle: string[]) => string | null;
  hitsText: (s: { today: number; week: number; month?: number }) => string | null;
  hitsRows: (state: unknown, today: string) => { day: string; total: number; detail: string }[];
  hitsOnHost: (state: unknown, day: string, host: string) => number;
  MAX_HOSTS_PER_DAY: number;
  hitsByHour: (state: unknown, days: string[]) => number[];
  peakHour: (state: unknown, days: string[]) => { hour: number; count: number } | null;
  hourLabel: (hour: number) => string;
  peakNow: (state: unknown, today: string, hour: number) => { hour: number; count: number; now: boolean } | null;
  peakText: (peak: unknown) => string;
  peakNowText: (peak: unknown) => string;
  hitsNudge: (today: number) => string;
  NUDGE_AT: number;
  hitsWeekByReason: (state: unknown, today: string) => { reason: string; count: number }[];
  hitsReasonText: (rows: { reason: string; count: number }[]) => string | null;
  REASON_NAMES: Record<string, string>;
  TOP_HOSTS_PER_DAY: number;
  topHost: (state: unknown, days: string[]) => { host: string; count: number } | null;
}

function load(): Hits {
  const src = fs.readFileSync(path.join(extensionDir(), 'hits.js'), 'utf8').replace(/^export /gm, '');
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn { RETENTION_DAYS, REPORT_DAYS, MAX_HOSTS_PER_DAY, MAX_KEYWORDS_PER_DAY, keywordsWeek, keywordsText, idleKeywords, idleKeywordsText, dayKey, lastDays, recordHit, sweepHits, hitsOn, hitsOnHost, hitsSummary, hitsMonth, monthHasOlderHits, hitsReport, hitsText, hitsTrendText, hitsRows, hitsByHour, peakHour, hourLabel, peakNow, peakText, peakNowText, hitsNudge, NUDGE_AT, hitsWeekByReason, hitsReasonText, REASON_NAMES, TOP_HOSTS_PER_DAY, topHost };`)() as Hits;
}

const TODAY = '2026-09-18';

test('könyvelés: naponként és okonként; az ismeretlen ok „egyéb”; a rossz nap nem sor', () => {
  const h = load();
  let s = h.recordHit({}, TODAY, 'keyword');
  s = h.recordHit(s, TODAY, 'keyword');
  s = h.recordHit(s, TODAY, 'closed');
  s = h.recordHit(s, TODAY, 'valami');
  s = h.recordHit(s, '2026-09-17', 'focus');
  s = h.recordHit(s, 'nem nap', 'focus');
  assert.deepEqual(s.days[TODAY], { total: 4, byReason: { keyword: 2, closed: 1, other: 1 } });
  assert.equal(s.days['2026-09-17'].total, 1);
  assert.equal(Object.keys(s.days).length, 2, 'a rossz napkulcs nem sor');
  // Sérült tár: a könyvelés nem dob, hanem újrakezd.
  assert.equal(h.recordHit({ days: { [TODAY]: 'szemét' } }, TODAY, 'rule').days[TODAY].total, 1);
  assert.equal(h.recordHit(null, TODAY, 'rule').days[TODAY].total, 1);
});

test('takarítás: harminc napnál régebbi és jövőbeli nap kiesik', () => {
  const h = load();
  let s = {};
  for (const d of h.lastDays(TODAY, 40)) s = h.recordHit(s, d, 'closed');
  s = h.recordHit(s, '2026-12-24', 'closed');
  const swept = h.sweepHits(s, TODAY);
  assert.equal(Object.keys(swept.days).length, h.RETENTION_DAYS);
  assert.equal(swept.days['2026-12-24'], undefined, 'a jövő nem mérés, hanem elállított óra');
  assert.equal(swept.days[TODAY] !== undefined, true);
  assert.equal(h.sweepHits(undefined, TODAY).days !== undefined, true);
});

test('összegzés és a hídra menő sorok: ma és az elmúlt 7 nap; a hídra két hét megy, üres nap nem sor', () => {
  const h = load();
  let s = {};
  s = h.recordHit(s, TODAY, 'keyword');
  s = h.recordHit(s, '2026-09-12', 'closed'); // a hét legrégebbi napja: benne
  s = h.recordHit(s, '2026-09-11', 'closed'); // nyolc napja: nincs a hétben — de a hídra megy (az előző hét)
  s = h.recordHit(s, '2026-09-04', 'closed'); // tizennégy napja: a két hétben sincs benne
  assert.deepEqual(h.hitsSummary(s, TODAY), { today: 1, week: 2, prevWeek: 1, month: 4 },
    'a nyolc napja az előző hété, a tizennégy napja egyiké sem — de a hónapé mind a négy');
  // A HÓNAP alakja: harminc nap a legrégebbitől; csak akkor áll, ha a hét előtt is volt.
  const month = h.hitsMonth(s, TODAY);
  assert.equal(month.length, 30);
  assert.equal(month[29].day, TODAY);
  assert.equal(month.reduce((a, d) => a + d.total, 0), 4);
  assert.equal(h.monthHasOlderHits(month), true, 'a nyolc és a tizennégy napos a hét előtt van');
  assert.equal(h.monthHasOlderHits(h.hitsMonth(h.recordHit({}, TODAY, 'closed'), TODAY)), false, 'csak ma: nem áll');
  assert.equal(h.monthHasOlderHits([]), false);
  assert.equal(h.REPORT_DAYS, 14, 'a híd két hetet visz: a gép a hetet az előző héthez méri');
  assert.deepEqual(h.hitsReport(s, TODAY), [
    { day: '2026-09-11', total: 1, byReason: { closed: 1 } },
    { day: '2026-09-12', total: 1, byReason: { closed: 1 } },
    { day: TODAY, total: 1, byReason: { keyword: 1 } },
  ]);
  assert.deepEqual(h.hitsSummary({}, TODAY), { today: 0, week: 0, prevWeek: 0, month: 0 });
  assert.equal(h.hitsTrendText({ week: 2, prevWeek: 1 }), 'A héten 2 megakadás, az előző héten 1.');
  assert.equal(h.hitsTrendText({ week: 0, prevWeek: 1 }), 'A héten 0 megakadás, az előző héten 1.', 'a nulla hét is mondat, ha volt mihez mérni');
  assert.equal(h.hitsTrendText({ week: 2, prevWeek: 0 }), null, 'előző hét nélkül nincs összehasonlítás');
  assert.equal(h.hitsOn({ days: { [TODAY]: { total: -3 } } }, TODAY), 0, 'a negatív nem szám');
  assert.equal(h.hitsRows(s, TODAY)[0].day, TODAY, 'a legfrissebb elöl');
  assert.equal(h.hitsRows(s, TODAY)[0].detail, 'kulcsszó 1');
});

test('a mondat: üres héten nincs; ma nélkül a hét; mával mindkettő', () => {
  const h = load();
  assert.equal(h.hitsText({ today: 0, week: 0 }), null);
  assert.equal(h.hitsText({ today: 0, week: 5 }), 'Ma még nem állított meg a böngésző; az elmúlt 7 napban 5 megakadás.');
  assert.equal(h.hitsText({ today: 2, week: 5 }), 'Ma 2 megakadás — a böngésző ennyiszer vitt a tiltó lapra; az elmúlt 7 napban 5.');
  // A hónap csak akkor kerül a mondatba, ha több a hétnél.
  assert.equal(h.hitsText({ today: 2, week: 5, month: 9 }), 'Ma 2 megakadás — a böngésző ennyiszer vitt a tiltó lapra; az elmúlt 7 napban 5, 30 napban 9.');
  assert.equal(h.hitsText({ today: 0, week: 5, month: 9 }), 'Ma még nem állított meg a böngésző; az elmúlt 7 napban 5 megakadás, 30 napban 9.');
  assert.equal(h.hitsText({ today: 2, week: 5, month: 5 }), 'Ma 2 megakadás — a böngésző ennyiszer vitt a tiltó lapra; az elmúlt 7 napban 5.', 'ha a hónap a hét, nem mondja kétszer');
});

test('a nap kulcsa helyi idő szerint, és az utolsó napok a mai nappal zárnak', () => {
  const h = load();
  assert.equal(h.dayKey(new Date(2026, 8, 18, 0, 30)), TODAY);
  assert.deepEqual(h.lastDays(TODAY, 3), ['2026-09-16', '2026-09-17', TODAY]);
  assert.deepEqual(h.lastDays('2026-03-01', 2), ['2026-02-28', '2026-03-01'], 'hónapforduló');
});

test('hosztonként is: hányadszor ma ezen az oldalon — plafonnal; a hídra csak a nap élbolya megy', () => {
  const h = load();
  let s = h.recordHit({}, TODAY, 'keyword', 'YouTube.com');
  s = h.recordHit(s, TODAY, 'closed', 'youtube.com');
  s = h.recordHit(s, TODAY, 'rule', 'reddit.com');
  s = h.recordHit(s, TODAY, 'rule'); // hoszt nélkül: csak az összegbe
  assert.equal(h.hitsOnHost(s, TODAY, 'youtube.com'), 2, 'a kis-nagybetű nem számít');
  assert.equal(h.hitsOnHost(s, TODAY, 'reddit.com'), 1);
  assert.equal(h.hitsOnHost(s, TODAY, 'x.example'), 0);
  assert.equal(h.hitsOn(s, TODAY), 4);
  assert.deepEqual(h.hitsReport(s, TODAY),
    [{ day: TODAY, total: 4, byReason: { keyword: 1, closed: 1, rule: 2 }, topHosts: [['youtube.com', 2], ['reddit.com', 1]] }],
    'a hídra a nap élbolya megy, a teljes hoszt-könyv nem');
  let many = {};
  for (let i = 0; i < h.MAX_HOSTS_PER_DAY + 5; i++) many = h.recordHit(many, TODAY, 'closed', `h${i}.example`);
  assert.equal(h.hitsOnHost(many, TODAY, 'h0.example'), 1);
  assert.equal(h.hitsOnHost(many, TODAY, `h${h.MAX_HOSTS_PER_DAY + 2}.example`), 0, 'a plafon fölött nincs külön szám');
  assert.equal(h.hitsOn(many, TODAY), h.MAX_HOSTS_PER_DAY + 5, '…de az összegben benne van');
});

test('óránként is: a hét csúcs-órája, holtversenynél a korábbi; a hídra a rekeszek is mennek', () => {
  const h = load();
  let s = h.recordHit({}, TODAY, 'keyword', 'a.example', 21);
  s = h.recordHit(s, TODAY, 'closed', 'a.example', 21);
  s = h.recordHit(s, '2026-09-17', 'closed', 'b.example', 9);
  s = h.recordHit(s, '2026-09-17', 'closed', 'b.example', 9);
  s = h.recordHit(s, '2026-09-11', 'closed', 'b.example', 9); // nyolc napja: nem a hété
  s = h.recordHit(s, TODAY, 'rule', 'c.example', 99); // rossz óra: csak az összegbe
  const week = h.lastDays(TODAY, 7);
  assert.equal(h.hitsByHour(s, week)[21], 2);
  assert.equal(h.hitsByHour(s, week)[9], 2);
  assert.deepEqual(h.peakHour(s, week), { hour: 9, count: 2 }, 'holtverseny: a korábbi óra');
  assert.equal(h.peakHour({}, week), null);
  assert.equal(h.hourLabel(23), '23–0 óra');
  // A CSÚCS-ÓRA a kísértés pillanatában: a felugró lap a hetet mondja (jelöléssel,
  // ha most van), a tiltó lap csak a csúcs-órában szól — a tükör a pillanaté.
  assert.deepEqual(h.peakNow(s, TODAY, 9), { hour: 9, count: 2, now: true }, 'a csúcs-órában: most');
  assert.equal(h.peakNow(s, TODAY, 10)?.now, false);
  assert.equal(h.peakNow({}, TODAY, 9), null);
  assert.equal(h.peakText(h.peakNow(s, TODAY, 9)), ' A hét csúcsa: 9–10 óra (2 megakadás) — most.');
  assert.equal(h.peakText(h.peakNow(s, TODAY, 10)), ' A hét csúcsa: 9–10 óra (2 megakadás).');
  assert.equal(h.peakText(null), '');
  assert.equal(h.peakNowText(h.peakNow(s, TODAY, 9)),
    ' Most a hét csúcs-órája van (9–10 óra, 2 megakadás a héten) — ilyenkor jár a kéz magától.');
  assert.equal(h.peakNowText(h.peakNow(s, TODAY, 10)), '', 'a csúcs-órán kívül a tiltó lap nem mondja');
  assert.equal(h.peakNowText(null), '');
  const report = h.hitsReport(s, TODAY);
  const todayRow = report.find((r) => r.day === TODAY) as { byHour?: number[] };
  assert.equal(todayRow.byHour?.[21], 2, 'a rekeszek a hídra mennek');
  assert.equal(todayRow.byHour?.length, 24);
});

test('a sokadik megakadásnál a lap egy lépést javasol — alatta hallgat', () => {
  const h = load();
  assert.equal(h.NUDGE_AT, 5);
  assert.equal(h.hitsNudge(4), '');
  assert.match(h.hitsNudge(5), /munkamenet vagy egy rövid zárlat/);
});

test('a hét okonként: a legnagyobb elöl, holtversenynél az okok sorrendje; a mondat a lap neveivel', () => {
  const h = load();
  let s = {};
  for (let i = 0; i < 3; i++) s = h.recordHit(s, TODAY, 'keyword');
  s = h.recordHit(s, TODAY, 'closed');
  for (let i = 0; i < 3; i++) s = h.recordHit(s, '2026-09-17', 'closed');
  s = h.recordHit(s, '2026-09-17', 'focus');
  s = h.recordHit(s, '2026-09-10', 'channel'); // a nyolc napos nem a hété
  assert.deepEqual(h.hitsWeekByReason(s, TODAY), [
    { reason: 'closed', count: 4 }, { reason: 'keyword', count: 3 }, { reason: 'focus', count: 1 },
  ]);
  assert.equal(h.hitsReasonText(h.hitsWeekByReason(s, TODAY)), 'A héten: 4 zárva oldal · 3 kulcsszó · 1 munkamenet');
  assert.equal(h.hitsReasonText([]), null, 'üresen nincs mondat');
  assert.deepEqual(h.hitsWeekByReason({}, TODAY), []);
  const tie = h.recordHit(h.recordHit({}, TODAY, 'keyword'), TODAY, 'closed');
  assert.deepEqual(h.hitsWeekByReason(tie, TODAY).map((r) => r.reason), ['closed', 'keyword'], 'holtverseny: az okok rögzített sorrendje');
  assert.equal(h.REASON_NAMES.rule, 'részleges szabály');
});

test('a nap élbolya a hídra: az öt leggyakoribb hoszt, a legnagyobb elöl; hoszt nélkül nincs', () => {
  const h = load();
  let s = {};
  for (let i = 0; i < 3; i++) s = h.recordHit(s, TODAY, 'closed', 'www.youtube.com');
  s = h.recordHit(s, TODAY, 'closed', 'reddit.com');
  for (const x of ['a.com', 'b.com', 'c.com', 'd.com', 'e.com']) s = h.recordHit(s, TODAY, 'closed', x);
  const row = h.hitsReport(s, TODAY)[0];
  assert.equal(h.TOP_HOSTS_PER_DAY, 5);
  assert.deepEqual(row.topHosts, [['www.youtube.com', 3], ['a.com', 1], ['b.com', 1], ['c.com', 1], ['d.com', 1]], 'holtversenyben az ábécé; öt fér');
  assert.equal(h.hitsReport(h.recordHit({}, TODAY, 'closed'), TODAY)[0].topHosts, undefined, 'hoszt nélkül nincs élboly');
});

test('a csúcs-oldal a saját könyvből: a napokra összeadva, pontosan; holtversenynél az ábécé; üresen nincs', () => {
  const h = load();
  let s = {};
  s = h.recordHit(s, TODAY, 'closed', 'reddit.com');
  s = h.recordHit(s, TODAY, 'closed', 'youtube.com');
  s = h.recordHit(s, '2026-09-17', 'closed', 'youtube.com');
  s = h.recordHit(s, '2026-09-17', 'closed', 'reddit.com');
  s = h.recordHit(s, '2026-09-17', 'closed', 'reddit.com');
  assert.deepEqual(h.topHost(s, [TODAY]), { host: 'reddit.com', count: 1 }, 'ma holtverseny: az ábécé');
  assert.deepEqual(h.topHost(s, h.lastDays(TODAY, 7)), { host: 'reddit.com', count: 3 }, 'a hét összeadva');
  assert.equal(h.topHost(s, ['2026-09-10']), null, 'üres nap: nincs');
  assert.equal(h.topHost({}, [TODAY]), null);
});

test('kulcsszavanként is: csak a kulcsszó okánál, a fogó szóval; a hét sora, a hídra a nap élbolya', () => {
  const h = load();
  let s = h.recordHit({}, TODAY, 'keyword', 'youtube.com', 21, 'Shorts');
  s = h.recordHit(s, TODAY, 'keyword', 'youtube.com', 21, 'shorts');
  s = h.recordHit(s, TODAY, 'keyword', 'instagram.com', 22, 'reels');
  s = h.recordHit(s, TODAY, 'closed', 'reddit.com', 22, 'reels'); // nem kulcsszó ok: a szó nem számít
  s = h.recordHit(s, '2026-09-11', 'keyword', 'x.com', 9, 'live'); // nyolc napja: nem a hété
  const week = h.lastDays(TODAY, 7);
  assert.deepEqual(h.keywordsWeek(s, week), [{ keyword: 'shorts', count: 2 }, { keyword: 'reels', count: 1 }], 'kisbetűs, a legnagyobb elöl');
  assert.equal(h.keywordsText(h.keywordsWeek(s, week)), 'Kulcsszavanként a héten: shorts 2 · reels 1');
  assert.equal(h.keywordsText([]), null);
  const row = h.hitsReport(s, TODAY).find((r) => r.day === TODAY) as { topKeywords?: [string, number][] };
  assert.deepEqual(row.topKeywords, [['shorts', 2], ['reels', 1]], 'a hídra a nap élbolya megy');
  let many = {};
  for (let i = 0; i < h.MAX_KEYWORDS_PER_DAY + 3; i++) many = h.recordHit(many, TODAY, 'keyword', 'a.example', 1, `k${i}`);
  assert.equal(h.keywordsWeek(many, [TODAY]).length, h.MAX_KEYWORDS_PER_DAY, 'a plafon fölött nincs új szó');
  assert.equal(h.hitsOn(many, TODAY), h.MAX_KEYWORDS_PER_DAY + 3, '…de az összegben benne van');
});

test('ami a héten nem fogott: a lista szavai a hét sorai nélkül — csak ha volt kulcsszó-megakadás', () => {
  const h = load();
  const rows = [{ keyword: 'shorts', count: 2 }];
  assert.deepEqual(h.idleKeywords(['Shorts', 'live', ' stream ', ''], rows), ['live', 'stream'], 'kisbetűsen, üres nélkül');
  assert.deepEqual(h.idleKeywords(['live'], []), [], 'kulcsszó-megakadás nélkül a hiány nem tény');
  assert.deepEqual(h.idleKeywords('nem lista', rows), []);
  assert.equal(h.idleKeywordsText(['live', 'stream']), 'A héten nem fogott: live, stream');
  assert.equal(h.idleKeywordsText([]), null);
});
