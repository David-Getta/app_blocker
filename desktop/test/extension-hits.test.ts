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
  recordHit: (state: unknown, day: string, reason: string) => { days: Record<string, { total: number; byReason: Record<string, number> }> };
  sweepHits: (state: unknown, today: string) => { days: Record<string, unknown> };
  hitsOn: (state: unknown, day: string) => number;
  hitsSummary: (state: unknown, today: string) => { today: number; week: number };
  hitsReport: (state: unknown, today: string) => { day: string; total: number; byReason: Record<string, number> }[];
  hitsText: (s: { today: number; week: number }) => string | null;
  hitsRows: (state: unknown, today: string) => { day: string; total: number; detail: string }[];
}

function load(): Hits {
  const src = fs.readFileSync(path.join(extensionDir(), 'hits.js'), 'utf8').replace(/^export /gm, '');
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn { RETENTION_DAYS, dayKey, lastDays, recordHit, sweepHits, hitsOn, hitsSummary, hitsReport, hitsText, hitsRows };`)() as Hits;
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

test('összegzés és a hídra menő sorok: ma és az elmúlt 7 nap, üres nap nem sor', () => {
  const h = load();
  let s = {};
  s = h.recordHit(s, TODAY, 'keyword');
  s = h.recordHit(s, '2026-09-12', 'closed'); // a hét legrégebbi napja: benne
  s = h.recordHit(s, '2026-09-11', 'closed'); // nyolc napja: nincs benne
  assert.deepEqual(h.hitsSummary(s, TODAY), { today: 1, week: 2 });
  assert.deepEqual(h.hitsReport(s, TODAY), [
    { day: '2026-09-12', total: 1, byReason: { closed: 1 } },
    { day: TODAY, total: 1, byReason: { keyword: 1 } },
  ]);
  assert.deepEqual(h.hitsSummary({}, TODAY), { today: 0, week: 0 });
  assert.equal(h.hitsOn({ days: { [TODAY]: { total: -3 } } }, TODAY), 0, 'a negatív nem szám');
  assert.equal(h.hitsRows(s, TODAY)[0].day, TODAY, 'a legfrissebb elöl');
  assert.equal(h.hitsRows(s, TODAY)[0].detail, 'kulcsszó 1');
});

test('a mondat: üres héten nincs; ma nélkül a hét; mával mindkettő', () => {
  const h = load();
  assert.equal(h.hitsText({ today: 0, week: 0 }), null);
  assert.equal(h.hitsText({ today: 0, week: 5 }), 'Ma még nem állított meg a böngésző; az elmúlt 7 napban 5 megakadás.');
  assert.equal(h.hitsText({ today: 2, week: 5 }), 'Ma 2 megakadás — a böngésző ennyiszer vitt a tiltó lapra; az elmúlt 7 napban 5.');
});

test('a nap kulcsa helyi idő szerint, és az utolsó napok a mai nappal zárnak', () => {
  const h = load();
  assert.equal(h.dayKey(new Date(2026, 8, 18, 0, 30)), TODAY);
  assert.deepEqual(h.lastDays(TODAY, 3), ['2026-09-16', '2026-09-17', TODAY]);
  assert.deepEqual(h.lastDays('2026-03-01', 2), ['2026-02-28', '2026-03-01'], 'hónapforduló');
});
