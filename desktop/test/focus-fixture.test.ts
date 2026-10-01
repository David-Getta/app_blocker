// Megfelelőségi fixtúra a MUNKAMENET MAGJÁRA: ugyanaz a csomag, napló és
// időpont ugyanazt a döntést adja a gépen, az Androidon és az iPhone-on.
//
// Az ismétlődő menet (a csomag heti ablaka) minden eszközön MAGÁTÓL indul: a
// bíró minden körben megkérdezi, melyik ablak esedékes. Ha a három mag más
// előfordulást számolna, vagy két egyszerre esedékes ablak közül mást
// választana, a menet az egyik eszközön elindulna, a másikon nem — vagy más
// csomaggal. A lezárás a naplóba ír, ami a fiókon utazik; a hátralévő idő
// szövege a három kezdőlapon áll.
//
// Hat szekció, UTC-ben (a napok és az órák helyi időben számolnak; a Swift
// kimondva kihagy, ha nem tudja beállítani): az ismétlődés (minden csomag
// mostani előfordulása, az esedékes ablak — holtversenyben a kisebb
// azonosító, kódegység szerint —, és hogy a futó menet ablak-menet-e); az
// ablak-menet a határokon; a lezárás (a 200 soros napló vágásával); a
// legutóbb használt csomag; a hátralévő idő szövege; és a percek tisztítása
// (a nagy szám a Kotlinban túlcsordult).
//
//   UPDATE_FOCUS_FIXTURE=1 npm test     — a fájl újraírása

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MAX_FOCUS_LOG, closeIfEnded, dueRecurrence, formatRemaining, isWindowRun, lastUsedPack, normalizeMinutes, occurrenceAt,
  type FocusLogEntry, type FocusPack, type FocusRun,
} from '../src/shared/focus';
import { isValidBand, type Band, type Weekday } from '../src/shared/schedule';
import { rng } from './merge-random';

process.env.TZ = 'UTC';

const FIXTURE = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'focus-cases.json');
const WEEK = Date.UTC(2026, 8, 28); // hétfő
const DAY = 24 * 3600_000;
const MIN = 60_000;
/** A hét `day` napjának (0 = vasárnap) `minute` perce — a hét hétfővel kezdődik. */
const at = (day: number, minute: number): number => WEEK + ((day + 6) % 7) * DAY + minute * MIN;

interface PackIn { id: string; name: string; band: Band | null }
interface RecurrenceCase {
  seed: number; now: number; packs: PackIn[]; run: FocusRun | null; log: FocusLogEntry[];
  occ: [string, number | null, number | null][]; due: [string, number, number] | null; windowRun: boolean | null;
}
interface WindowRunCase { packs: PackIn[]; run: FocusRun; out: boolean }
interface CloseCase {
  now: number; packs: PackIn[]; run: FocusRun | null; logLength: number;
  out: { entry: FocusLogEntry; logLength: number; first: number; last: number } | null;
}
interface LastUsedCase { packs: string[]; log: [string, number][]; out: string | null }
interface Fixture {
  note: string; version: number; recurrence: RecurrenceCase[]; windowRun: WindowRunCase[]; close: CloseCase[];
  lastUsed: LastUsedCase[]; remaining: [number, string][]; minutes: [number, number | null][];
}

function warm(seed: number): () => number { const r = rng(seed); for (let i = 0; i < 4; i++) r(); return r; }
function pick<T>(r: () => number, arr: T[]): T { return arr[Math.floor(r() * arr.length)]; }

function toPacks(packs: PackIn[]): FocusPack[] {
  return packs.map((p) => ({
    id: p.id, name: p.name, allowSites: [], allowApps: [], defaultMinutes: 30,
    ...(p.band ? { recurrence: p.band } : {}),
  }) as FocusPack);
}

/** Csomag-azonosítók: a kódegység-rend buktatói („B” a „a” előtt, „10” a „9” előtt). */
const IDS = ['p_a', 'p_b', 'p_B', 'p_10', 'p_9', 'pack-z'];
const STARTS = [0, 30, 59, 60, 479, 480, 540, 600, 1020, 1320, 1380, 1439];
const LENGTHS = [15, 59, 60, 90, 180, 240, 480];

function randomBand(r: () => number): Band {
  const roll = r();
  if (roll < 0.08) return { days: [], startMin: 540, endMin: 600 };                      // nincs nap
  if (roll < 0.12) return { days: [1, 2], startMin: 1440, endMin: 60 };                  // rossz kezdés
  if (roll < 0.16) return { days: [3], startMin: 600, endMin: 0 };                       // rossz vég
  if (roll < 0.20) return { days: [0, 1, 2, 3, 4, 5, 6], startMin: 600, endMin: 600 };   // egész napos (érvényes)
  const days = [0, 1, 2, 3, 4, 5, 6].filter(() => r() < 0.45) as Weekday[];
  if (days.length === 0) days.push(Math.floor(r() * 7) as Weekday);
  const startMin = pick(r, STARTS);
  let endMin = (startMin + pick(r, LENGTHS)) % 1440;
  if (endMin === 0) endMin = 1440;
  return { days, startMin, endMin };
}

function logEntry(packId: string, startedAt: number, endsAt: number, stopped = false): FocusLogEntry {
  return { packId, packName: `csomag ${packId}`, startedAt, endedAt: endsAt, plannedEndsAt: endsAt, stopped };
}

// ------------------------------------------------------------- ismétlődés

function recurrenceCases(): RecurrenceCase[] {
  const out: RecurrenceCase[] = [];
  for (let seed = 1; seed <= 160; seed++) {
    const r = warm(7000 + seed);
    const ids = [...IDS].sort(() => r() - 0.5).slice(0, 1 + Math.floor(r() * 4));
    const packs: PackIn[] = [];
    for (const id of ids) {
      // Néha ugyanaz a sáv, mint az előzőé: két egyszerre esedékes ablak — a holtverseny.
      const band = r() < 0.15 ? null : (packs.length && r() < 0.3 && packs[packs.length - 1].band ? { ...packs[packs.length - 1].band! } : randomBand(r));
      packs.push({ id, name: `csomag ${id}`, band });
    }
    // Az időpont: a fele egy sáv szélén (perc pontosan, előtte, utána), a fele bárhol a héten.
    let now: number;
    const edged = packs.find((p) => p.band && isValidBand(p.band));
    if (edged && r() < 0.6) {
      const b = edged.band!;
      const day = pick(r, b.days);
      const overnight = b.endMin <= b.startMin;
      const atEnd = r() < 0.5;
      const base = atEnd ? b.endMin : b.startMin;
      const dayShift = atEnd && overnight ? 1 : 0;
      const minute = base + pick(r, [-2, -1, 0, 0, 1, 2]);
      now = at(day, 0) + dayShift * DAY + minute * MIN + pick(r, [0, 0, 1000, 59_000]);
    } else {
      now = WEEK + Math.floor(r() * 9 * DAY) - DAY;
    }
    const tsPacks = toPacks(packs);
    const occOf = (p: PackIn) => (p.band && isValidBand(p.band) ? occurrenceAt(p.band, now) : null);
    // A futó menet: nincs, az egyik csomagé (fut vagy lejárt), vagy az ablaké pontosan.
    let run: FocusRun | null = null;
    const roll = r();
    const target = pick(r, packs);
    const occT = occOf(target);
    if (roll < 0.2 && occT) run = { packId: target.id, startedAt: occT.startsAt, endsAt: occT.endsAt };
    else if (roll < 0.45) run = { packId: target.id, startedAt: now - 30 * MIN, endsAt: now + pick(r, [-1, 0, 1, 30]) * MIN };
    // A napló: néha az ablak saját menete (elköltve), néha egy kézi menet az ablakon belül (nem az).
    const log: FocusLogEntry[] = [];
    for (const p of packs) {
      const o = occOf(p);
      if (o && r() < 0.35) log.push(logEntry(p.id, o.startsAt, o.endsAt, r() < 0.5));
      else if (o && r() < 0.25) log.push(logEntry(p.id, o.startsAt + MIN, o.startsAt + 2 * MIN));
    }
    if (r() < 0.3) log.push(logEntry(pick(r, IDS), now - 3 * DAY, now - 3 * DAY + 45 * MIN));
    const occ = packs.filter((p) => p.band && isValidBand(p.band)).map((p) => {
      const o = occOf(p);
      return [p.id, o ? o.startsAt : null, o ? o.endsAt : null] as [string, number | null, number | null];
    });
    const due = dueRecurrence(tsPacks, run, log, now);
    const runPack = run ? packs.find((p) => p.id === run!.packId) : undefined;
    const windowRun = run && (!runPack?.band || isValidBand(runPack.band)) ? isWindowRun(run, tsPacks) : null;
    out.push({ seed, now, packs, run, log, occ, due: due ? [due.pack.id, due.startsAt, due.endsAt] : null, windowRun });
  }
  return out;
}

// ------------------------------------------------------------- ablak-menet

function windowRunCases(): WindowRunCase[] {
  const out: WindowRunCase[] = [];
  for (let seed = 1; seed <= 40; seed++) {
    const r = warm(7500 + seed);
    let band = randomBand(r);
    while (!isValidBand(band)) band = randomBand(r);
    const packs: PackIn[] = [{ id: 'p_a', name: 'A', band }, { id: 'p_b', name: 'B', band: null }];
    const day = pick(r, band.days);
    const o = occurrenceAt(band, at(day, band.startMin))!;
    const shift = pick(r, [0, 0, 0, 1, -1, 60_000, -60_000]);
    const which = r();
    const run: FocusRun = which < 0.7
      ? { packId: 'p_a', startedAt: o.startsAt + (r() < 0.5 ? shift : 0), endsAt: o.endsAt + (r() < 0.5 ? shift : 0) }
      : { packId: which < 0.85 ? 'p_b' : 'p_x', startedAt: o.startsAt, endsAt: o.endsAt };
    out.push({ packs, run, out: isWindowRun(run, toPacks(packs)) });
  }
  return out;
}

// ------------------------------------------------------------------ lezárás

function closeCases(): CloseCase[] {
  const out: CloseCase[] = [];
  for (let seed = 1; seed <= 30; seed++) {
    const r = warm(8000 + seed);
    let band = randomBand(r);
    while (!isValidBand(band)) band = randomBand(r);
    const day = pick(r, band.days);
    const o = occurrenceAt(band, at(day, band.startMin))!;
    const asWindow = r() < 0.5;
    const run: FocusRun | null = r() < 0.1 ? null
      : asWindow ? { packId: 'p_a', startedAt: o.startsAt, endsAt: o.endsAt }
        : { packId: pick(r, ['p_a', 'p_gone']), startedAt: o.startsAt + 5 * MIN, endsAt: o.startsAt + 50 * MIN };
    const packs: PackIn[] = [{ id: 'p_a', name: pick(r, ['Nyelvtanulás', 'Olvasás', 'Ő']), band }];
    const logLength = pick(r, [0, 1, 3, MAX_FOCUS_LOG - 1, MAX_FOCUS_LOG]);
    const ends = run ? run.endsAt : WEEK;
    const now = ends + pick(r, [-1, 0, 1, 5 * MIN]);
    const log = Array.from({ length: logLength }, (_, i) => logEntry('p_old', WEEK - (logLength - i) * DAY, WEEK - (logLength - i) * DAY + 30 * MIN));
    const res = closeIfEnded(run, toPacks(packs), log, now);
    out.push({
      now, packs, run, logLength,
      out: res ? {
        entry: { ...res.log[res.log.length - 1], window: res.log[res.log.length - 1].window === true },
        logLength: res.log.length, first: res.log[0].startedAt, last: res.log[res.log.length - 1].startedAt,
      } : null,
    });
  }
  return out;
}

// ---------------------------------------------------- legutóbb használt csomag

function lastUsedCases(): LastUsedCase[] {
  const out: LastUsedCase[] = [];
  for (let seed = 1; seed <= 40; seed++) {
    const r = warm(8500 + seed);
    // Minden tizedik esetben nincs csomag: akkor nincs mit javasolni (null).
    const packs = seed % 10 === 0 ? [] : IDS.filter(() => r() < 0.5);
    const log: [string, number][] = Array.from({ length: Math.floor(r() * 6) }, () => [
      pick(r, [...IDS, 'p_gone']), WEEK + pick(r, [0, 1, 1, 2, 3]) * DAY,   // sok egyforma kezdés: a holtverseny
    ]);
    const p = lastUsedPack(toPacks(packs.map((id) => ({ id, name: id, band: null }))),
      log.map(([id, at]) => logEntry(id, at, at + 30 * MIN)));
    out.push({ packs, log, out: p ? p.id : null });
  }
  return out;
}

const REMAINING = [
  -60_000, -1, 0, 1, 59_999, 60_000, 60_001, 119_999, 120_000, 120_001, 3_540_000, 3_599_999, 3_600_000,
  3_600_001, 5_400_000, 7_200_000, 7_260_000, 28_800_000, 2 * 86_400_000,
];
const MINUTES = [-1e20, -5, 0, 0.4, 0.5, 0.6, 1, 1.5, 2.5, 45, 479.4, 479.5, 480, 481, 100_000, 3e9, 1e20];

function buildFixture(): Fixture {
  return {
    note: 'Generálja és őrzi: desktop/test/focus-fixture.test.ts (UPDATE_FOCUS_FIXTURE=1 npm test). '
      + 'Az ismétlődés (a csomagok mostani előfordulása, az esedékes ablak, ablak-menet-e a futó menet), az '
      + 'ablak-menet a határokon, a lezárás (a 200 soros napló vágásával), a legutóbb használt csomag, a hátralévő '
      + 'idő szövege és a percek tisztítása — UTC-ben. Olvassa: android/jvm-tests FocusFixtureTest, '
      + 'ios/SharedTests FocusFixtureTests. Csupa ASCII.',
    version: 1,
    recurrence: recurrenceCases(), windowRun: windowRunCases(), close: closeCases(), lastUsed: lastUsedCases(),
    remaining: REMAINING.map((ms) => [ms, formatRemaining(ms)]),
    minutes: MINUTES.map((v) => [v, normalizeMinutes(v)]),
  };
}

function ascii(json: string): string {
  let out = '';
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    out += code < 0x7f ? json[i] : '\\u' + code.toString(16).padStart(4, '0');
  }
  return out;
}

function render(f: Fixture): string {
  const rows = (items: unknown[]) => items.map((c) => '  ' + ascii(JSON.stringify(c))).join(',\n');
  return `{\n "note": ${ascii(JSON.stringify(f.note))},\n "version": ${f.version},\n`
    + ` "recurrence": [\n${rows(f.recurrence)}\n ],\n`
    + ` "windowRun": [\n${rows(f.windowRun)}\n ],\n`
    + ` "close": [\n${rows(f.close)}\n ],\n`
    + ` "lastUsed": [\n${rows(f.lastUsed)}\n ],\n`
    + ` "remaining": [\n${rows(f.remaining)}\n ],\n`
    + ` "minutes": [\n${rows(f.minutes)}\n ]\n}\n`;
}

test('a munkamenet fixtúrája friss, és nem elfajult', () => {
  const built = buildFixture();
  const rec = built.recurrence;
  assert.ok(rec.filter((c) => c.due).length > 20 && rec.some((c) => !c.due), 'esedékes és nem esedékes ablak is');
  assert.ok(rec.some((c) => c.due && c.packs.filter((p) => p.band && JSON.stringify(p.band) === JSON.stringify(c.packs.find((q) => q.id === c.due![0])!.band)).length > 1),
    'van holtverseny két egyforma ablak között');
  assert.ok(rec.some((c) => c.occ.some((o) => o[1] !== null && o[2]! <= o[1]! + 0)) === false, 'az előfordulás vége a kezdete után van');
  assert.ok(rec.some((c) => c.windowRun === true) && rec.some((c) => c.windowRun === false));
  assert.ok(built.windowRun.some((c) => c.out) && built.windowRun.some((c) => !c.out));
  assert.ok(built.close.some((c) => c.out === null) && built.close.some((c) => c.out?.entry.window) && built.close.some((c) => c.out && !c.out.entry.window));
  assert.ok(built.close.some((c) => c.out && c.out.logLength === MAX_FOCUS_LOG && c.logLength === MAX_FOCUS_LOG), 'a napló vágása előjön');
  assert.ok(built.lastUsed.some((c) => c.out === null) && built.lastUsed.filter((c) => c.out).length > 10);
  assert.equal(normalizeMinutes(3e9), 480, 'a nagy szám a plafonra vág, nem fordul át');
  const text = render(built);
  if (process.env.UPDATE_FOCUS_FIXTURE) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, text);
  }
  assert.ok(fs.existsSync(FIXTURE), `nincs fixture: ${FIXTURE} — UPDATE_FOCUS_FIXTURE=1 npm test`);
  const onDisk = fs.readFileSync(FIXTURE, 'utf8');
  assert.equal(
    onDisk, text,
    'a fixtures/focus-cases.json elavult a gép szabályához képest — UPDATE_FOCUS_FIXTURE=1 npm test, '
      + 'aztán a Kotlin (FocusFixtureTest) és a Swift (FocusFixtureTests) teszt mutatja meg, hol csúszott el a tükör',
  );
  assert.ok(/^[\x00-\x7f]*$/.test(onDisk), 'a fixtúra nem csupa ASCII');
});
