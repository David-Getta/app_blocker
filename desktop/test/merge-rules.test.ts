// Részleges szabályok a szinkronban.
//
// Két kimenetel van, ami rosszabb, mint ha a szabályok egyáltalán nem
// szinkronizálódnának:
//
//   1. egy szabály CSENDBEN eltűnik (a felhasználó azt hiszi, tilt, és nem);
//   2. egy kifizetett eltávolítás visszajön (a próbatétel értéktelen lesz).
//
// A legalattomosabb az első egy változata: egy RÉGI app-verzió nem ismeri a
// mezőt, tehát ami átmegy rajta, abból eltűnik. Ha ezt „mindent töröltek”-ként
// értenénk, elég lenne egy frissítetlen telefon a fiókban.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mergeSite, mergeSiteLists, type SyncSite } from '../src/shared/sync/merge';
import { normalizeRule } from '../src/shared/urlrules';

const R = (s: string) => normalizeRule(s)!;

function site(extra: Partial<SyncSite> = {}): SyncSite {
  return {
    id: 'site_1', domain: 'youtube.com', hostnames: ['youtube.com'], addedAt: 1000,
    pauseUntil: null, pendingDeleteAt: null,
    rev: 1, updatedAt: 1000, updatedBy: 'gep-a',
    ...extra,
  };
}

const labels = (s: SyncSite) => (s.rules ?? []).map((r) => `${r.host}${r.path}`).sort();

test('rules added on two devices at once are both kept', () => {
  // Egyenlő rev: senki nem „újabb”. Ha ilyenkor egy egész listát választanánk,
  // az egyik eszközön felvett szabály némán elveszne — a felhasználó pedig azt
  // hinné, hogy felvette.
  const a = site({ rev: 5, rules: [R('youtube.com/@egy')] });
  const b = site({ rev: 5, rules: [R('youtube.com/@ketto')], updatedBy: 'gep-b' });
  assert.deepEqual(labels(mergeSite(a, b)), ['youtube.com/@egy', 'youtube.com/@ketto']);
  // Szimmetrikus: minden eszköz ugyanarra jut, különben örökké írnák egymást.
  assert.deepEqual(labels(mergeSite(b, a)), labels(mergeSite(a, b)));
});

test('a removal that was paid for is not resurrected', () => {
  // Az eltávolítás próbatételbe kerül, és SÍRKÖVET kap: a szabály jele a rev,
  // amelyik levette. A régi listát hordozó eszköz jele kisebb — nem hozza vissza.
  const before = site({ rev: 5, rules: [R('youtube.com/@egy'), R('youtube.com/@ketto')] });
  const after = site({ rev: 6, rules: [R('youtube.com/@ketto')], ruleMarks: { 'youtube.com/@egy': 6 }, updatedAt: 2000 });
  assert.deepEqual(labels(mergeSite(before, after)), ['youtube.com/@ketto']);
  assert.deepEqual(labels(mergeSite(after, before)), ['youtube.com/@ketto']);
  assert.deepEqual(mergeSite(before, after).ruleMarks, { 'youtube.com/@egy': 6 }, 'a sírkő utazik tovább');

  // És az utolsó szabály levétele sem jön vissza.
  const empty = site({ rev: 7, rules: [], ruleMarks: { 'youtube.com/@egy': 6, 'youtube.com/@ketto': 7 }, updatedAt: 3000 });
  assert.deepEqual(labels(mergeSite(after, empty)), []);
  assert.deepEqual(labels(mergeSite(before, empty)), []);

  // A régi eszköz ingyenes szerkesztései (nagyobb rev) sem hozzák vissza:
  // a szabály jele dönt, nem a rekordé.
  const busy = site({ rev: 40, rules: [R('youtube.com/@egy'), R('youtube.com/@ketto')], alias: 'tube', updatedBy: 'gep-b' });
  assert.deepEqual(labels(mergeSite(busy, after)), ['youtube.com/@ketto']);
  assert.equal(mergeSite(busy, after).alias, 'tube', 'a fedőnév a frissebb rekordé');
});

test('an app version that does not know the field cannot delete the rules', () => {
  // EZ A LEGVESZÉLYESEBB ESET. Egy régi kliens a mezőt nem érti, tehát ami
  // átmegy rajta, abból hiányzik. Ha a hiányt „mindent töröltek”-nek vennénk,
  // elég lenne egy frissítetlen telefon a fiókban, és a gépen felvett összes
  // szabály csendben eltűnne — próbatétel nélkül, jelzés nélkül.
  const mine = site({ rev: 5, rules: [R('youtube.com/@egy')], ruleMarks: { 'youtube.com/@egy': 5 } });
  const old = site({ rev: 9, updatedAt: 9000, updatedBy: 'regi-telefon' }); // nincs `rules` kulcs
  assert.deepEqual(labels(mergeSite(mine, old)), ['youtube.com/@egy'],
    'a nagyobb rev sem törölhet olyan mezőt, amiről nem tud');
  assert.deepEqual(labels(mergeSite(old, mine)), ['youtube.com/@egy']);
  assert.deepEqual(mergeSite(old, mine).ruleMarks, { 'youtube.com/@egy': 5 }, 'a jelek is a tudó oldaléi');

  // Az üres lista a SÍRKÖVEIVEL valódi állítás: „volt, és levettem”.
  const emptied = site({ rev: 9, rules: [], ruleMarks: { 'youtube.com/@egy': 9 }, updatedAt: 9000 });
  assert.deepEqual(labels(mergeSite(mine, emptied)), []);
  // Sírkő nélkül viszont nem — egy jel nélküli levétel (régi kliens) nem
  // tarthatja meg magát: egyenlő jelnél a jelenlét nyer.
  const unmarked = site({ rev: 9, rules: [], updatedAt: 9000 });
  assert.deepEqual(labels(mergeSite(mine, unmarked)), ['youtube.com/@egy']);
});

test('a free addition with a higher mark does not take the rule the other device added', () => {
  // A REGI HIBA: a lista egy jellel utazott, és az ingyenes felvétel nagyobb
  // jellel EGÉSZÉBEN vitte a listáját — a másik eszközön közben felvett szabály
  // csendben eltűnt. Szabályonként mindkettő megmarad.
  const a = site({ rev: 10, rules: [R('youtube.com/@egy'), R('youtube.com/@t')], ruleMarks: { 'youtube.com/@t': 10 }, rulesRev: 10 });
  const b = site({ rev: 4, rules: [R('youtube.com/@egy'), R('youtube.com/@s')], ruleMarks: { 'youtube.com/@s': 4 }, rulesRev: 4, updatedBy: 'gep-b' });
  for (const m of [mergeSite(a, b), mergeSite(b, a)]) {
    assert.deepEqual(labels(m), ['youtube.com/@egy', 'youtube.com/@s', 'youtube.com/@t']);
    assert.deepEqual(m.ruleMarks, { 'youtube.com/@s': 4, 'youtube.com/@t': 10 });
    assert.equal(m.rulesRev, 10, 'a lista-jelből a nagyobb megy tovább — a régi kliensek abból fésülnek');
  }
});

test('per rule the higher mark decides: a paid removal beats a higher rev, a later re-add beats the removal', () => {
  const kept = site({ rev: 6, rules: [R('youtube.com/@egy')], ruleMarks: { 'youtube.com/@egy': 2 } });
  const removed = site({ rev: 4, rules: [], ruleMarks: { 'youtube.com/@egy': 4 }, updatedBy: 'gep-b' });
  assert.deepEqual(labels(mergeSite(kept, removed)), []);
  assert.deepEqual(labels(mergeSite(removed, kept)), []);
  const readded = site({ rev: 8, rules: [R('youtube.com/@egy')], ruleMarks: { 'youtube.com/@egy': 8 } });
  assert.deepEqual(labels(mergeSite(removed, readded)), ['youtube.com/@egy']);
  assert.deepEqual(mergeSite(readded, removed).ruleMarks, { 'youtube.com/@egy': 8 });
  // Egyenlő jelnél a jelenlét: sorrendtől független, és sosem lazább.
  const here = site({ rev: 4, rules: [R('youtube.com/@egy')], ruleMarks: { 'youtube.com/@egy': 4 } });
  assert.deepEqual(labels(mergeSite(removed, here)), ['youtube.com/@egy']);
  assert.deepEqual(labels(mergeSite(here, removed)), ['youtube.com/@egy']);
});

test('three devices in any order agree, an old client among them too', () => {
  const old = site({ rev: 9, updatedBy: 'telefon' });
  const d = site({ rev: 2, rules: [R('youtube.com/@egy')], ruleMarks: { 'youtube.com/@egy': 2 }, rulesRev: 2 });
  const e = site({ rev: 3, rules: [], ruleMarks: { 'youtube.com/@egy': 3 }, rulesRev: 3, updatedBy: 'gep-b' });
  const f = site({ rev: 5, rules: [R('youtube.com/@ketto')], ruleMarks: { 'youtube.com/@ketto': 5 }, rulesRev: 5, updatedBy: 'gep-c' });
  const orders = [
    mergeSite(mergeSite(mergeSite(old, d), e), f),
    mergeSite(mergeSite(mergeSite(f, e), d), old),
    mergeSite(mergeSite(old, f), mergeSite(e, d)),
    mergeSite(mergeSite(d, f), mergeSite(old, e)),
  ];
  for (const m of orders) {
    assert.deepEqual(labels(m), ['youtube.com/@ketto']);
    assert.deepEqual(m.ruleMarks, { 'youtube.com/@egy': 3, 'youtube.com/@ketto': 5 });
    assert.equal(m.rulesRev, 5);
  }
});

test('a site that never had rules stays without the field', () => {
  // Ha minden rekordba beletennénk egy üres tömböt, két szerkezetileg azonos
  // lista különbözőnek látszana, és a szinkron minden körben feltöltene.
  const a = site({ rev: 2 });
  const b = site({ rev: 3, updatedAt: 2000 });
  assert.equal(Object.prototype.hasOwnProperty.call(mergeSite(a, b), 'rules'), false);
});

test('junk from the other device does not become a rule', () => {
  // A szinkronon át érkező adat ugyanolyan megbízhatatlan, mint bármi más. Egy
  // út nélküli „szabály” az EGÉSZ oldalt jelentené a bővítményben — vagyis a
  // gyengébb réteg többet tiltana, mint amit bárki beállított.
  const a = site({
    rev: 5,
    rules: [
      { host: 'youtube.com', path: '' },                    // nincs út
      { host: '', path: '/@valaki' },                       // nincs hoszt
      { host: 'youtube.com', path: '/@ok' },
      { host: 'youtube.com', path: '/@ok' },                // duplikátum
      { host: 'M.YouTube.com', path: '/@Masik' },           // mobil hoszt, nagybetű
      null as unknown as { host: string; path: string },
    ],
  });
  const b = site({ rev: 5, updatedBy: 'gep-b' });
  assert.deepEqual(labels(mergeSite(a, b)), ['youtube.com/@masik', 'youtube.com/@ok']);
});

test('the rule list cannot grow without bound through sync', () => {
  // Két eszköz ötven-ötven szabállyal: az egyesítés száz lenne. A korlát nem
  // szépészet — a lista minden körben felmegy és lejön, titkosítva.
  const many = (prefix: string) => Array.from({ length: 50 }, (_, i) => R(`youtube.com/@${prefix}${i}`));
  const a = site({ rev: 5, rules: many('a') });
  const b = site({ rev: 5, rules: many('b'), updatedBy: 'gep-b' });
  assert.equal(mergeSite(a, b).rules!.length, 50);
});

test('rules survive a whole-list merge, and the union is stable', () => {
  const a: SyncSite[] = [site({ rev: 4, rules: [R('youtube.com/@egy')] })];
  const b: SyncSite[] = [site({ rev: 4, rules: [R('youtube.com/@ketto')], updatedBy: 'gep-b' })];
  const once = mergeSiteLists(a, b);
  assert.deepEqual(labels(once[0]), ['youtube.com/@egy', 'youtube.com/@ketto']);
  // Kétszer lefuttatva ugyanaz: enélkül a két eszköz felváltva írná felül
  // egymást, és a szinkron sosem érne véget.
  assert.deepEqual(mergeSiteLists(once, b), once);
  assert.deepEqual(mergeSiteLists(b, once), once);
});
