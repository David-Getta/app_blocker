// A NEHÉZSÉG SOSEM CSÖKKENHET.
//
// Ez a projekt egyetlen olyan ígérete, amit nem lehet félig betartani: a
// feloldás nem lesz könnyebb attól, hogy sokszor csinálod. Az ígéret nem
// szövegben él, hanem a `TIER_PARAMS` táblázat SZÁMAIBAN — és a számokat eddig
// semmi nem őrizte.
//
// Egy elgépelt sor (`[300, 420, 560, 520]`) azt jelentené, hogy a harmadik fok
// KÖNNYEBB a másodiknál: aki a héten hétszer oldott fel, könnyebb próbatételt
// kapna, mint aki négyszer. Semmi nem hasalna el tőle — se fordítás, se a
// meglévő tesztek —, és a felhasználó pont az ellenkezőjét kapná annak, amiért
// az appot használja.
//
// A három nyelv számbeli egyezését a `scripts/check-core-sync.js` őrzi, tehát
// ami itt igaz, az a telefonon és az iPhone-on is igaz.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTier, TIER_PARAMS } from '../src/shared/challenges';

/**
 * Melyik irány a NEHEZEBB.
 *
 * Nem mindegyik szám nő: a memória-lépésnél a rövidebb mutatási idő a
 * nehezebb. Épp ezért kell iránnyal együtt kimondani — egy „minden nőjön”
 * szabály itt hamis lenne, és vagy hibásan riasztana, vagy kivételt kapna, és
 * akkor pont ezt az egy sort nem őrizné semmi.
 */
const DIRECTION: Record<string, 'nő' | 'csökken'> = {
  transcribeChars: 'nő',      // több karaktert kell átgépelni
  mathLen: 'nő',              // hosszabb számolási lánc
  mathFactorMax: 'nő',        // nagyobb szorzók
  memoryLen: 'nő',            // hosszabb kód
  memoryShowMs: 'csökken',    // RÖVIDEBB ideig látszik
  memoryWaitMs: 'nő',         // tovább kell fejben tartani
  reverseWords: 'nő',         // hosszabb mondat visszafelé
};

test('minden nehézségi paraméter a nehezebb felé mozdul, fokról fokra', () => {
  for (const [name, dir] of Object.entries(DIRECTION)) {
    const row = TIER_PARAMS[name as keyof typeof TIER_PARAMS] as readonly number[];
    assert.equal(row.length, 4, `${name}: négy fok van`);
    for (let i = 1; i < row.length; i++) {
      const harder = dir === 'nő' ? row[i] > row[i - 1] : row[i] < row[i - 1];
      assert.ok(
        harder,
        `${name}: a ${i}. fok NEM nehezebb a ${i - 1}.-nál `
        + `(${row[i - 1]} -> ${row[i]}, elvárt irány: ${dir})`,
      );
    }
  }
});

test('a kényszerített várakozás is csak nőhet, alul és felül is', () => {
  // A várakozás [alsó, felső] percpár. Mindkét végének emelkednie kell: ha csak
  // a felső nőne, egy szerencsés sorsolás a magasabb fokon is adhatna rövidebb
  // várakozást, mint az alacsonyabbon — és a „nem lesz könnyebb” egy
  // kockadobás kérdése lenne.
  for (const name of ['pauseDelayMin', 'deleteDelayMin'] as const) {
    const rows = TIER_PARAMS[name] as readonly (readonly number[])[];
    assert.equal(rows.length, 4, `${name}: négy fok van`);
    for (const [lo, hi] of rows) {
      assert.ok(lo <= hi, `${name}: az alsó határ nem lehet nagyobb a felsőnél (${lo} > ${hi})`);
    }
    for (let i = 1; i < rows.length; i++) {
      assert.ok(
        rows[i][0] > rows[i - 1][0],
        `${name}: a ${i}. fok ALSÓ határa nem nőtt (${rows[i - 1][0]} -> ${rows[i][0]})`,
      );
      assert.ok(
        rows[i][1] > rows[i - 1][1],
        `${name}: a ${i}. fok FELSŐ határa nem nőtt (${rows[i - 1][1]} -> ${rows[i][1]})`,
      );
    }
  }
});

test('a törlés próbatétele sosem enyhébb a szünetnél', () => {
  // A törlés VÉGLEGES, a szünet nem. Ha a törlés olcsóbb lenne, a kibúvó
  // kézenfekvő: nem szünetet kérek, hanem letörlöm az oldalt, és holnap
  // visszaveszem — egy kattintással, próbatétel nélkül.
  const pause = TIER_PARAMS.pauseDelayMin;
  const del = TIER_PARAMS.deleteDelayMin;
  for (let i = 0; i < pause.length; i++) {
    assert.ok(del[i][0] >= pause[i][0], `${i}. fok: a törlés alsó határa kisebb a szünetnél`);
    assert.ok(del[i][1] >= pause[i][1], `${i}. fok: a törlés felső határa kisebb a szünetnél`);
  }
});

test('a fok a feloldások számával sosem csökken', () => {
  // A küszöbök (1 / 3 / 6) beállítás kérdése, a MONOTONITÁS nem az: ha egy
  // plusz feloldás alacsonyabb fokot adna, az egyenesen jutalmazná a sok
  // feloldást.
  const now = 1_000_000_000_000;
  let prev = -1;
  for (let n = 0; n <= 12; n++) {
    const log = Array.from({ length: n }, (_, i) => now - (i + 1) * 3600_000);
    const t = computeTier(log, now);
    assert.ok(t >= prev, `${n} feloldásnál a fok visszaesett (${prev} -> ${t})`);
    prev = t;
  }
  assert.equal(prev, 3, 'tizenkét feloldás a legmagasabb fok');
});

test('a hétnél régebbi feloldás nem számít, a jövőbeli sem', () => {
  // A hét az ablak: enélkül a fok soha nem menne vissza, és aki egyszer
  // rosszul járt, örökre a legnehezebb próbatételt kapná. Az önkontroll nem
  // büntetés.
  //
  // A JÖVŐBELI bélyeg pedig védekezés: egy elállított óra mellett ne lehessen
  // előre bekönyvelni feloldásokat — se enyhíteni, se rontani vele.
  const now = 1_000_000_000_000;
  const regi = Array.from({ length: 10 }, (_, i) => now - (8 + i) * 24 * 3600_000);
  assert.equal(computeTier(regi, now), 0);
  const jovobeli = Array.from({ length: 10 }, (_, i) => now + (i + 1) * 3600_000);
  assert.equal(computeTier(jovobeli, now), 0);
});
