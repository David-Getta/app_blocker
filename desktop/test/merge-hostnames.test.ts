// A hosztnevek fésülése: egyenlő revnél egyesülnek, nagyobb revnél a nyertesé.
//
// A hosztnév-lista a tiltás része (ezek mennek a hosts fájlba). Egy név
// levétele lazítás, ami csak próbatétel után, rev-emeléssel mehet át — azt a
// nagyobb rev viszi. Egy versenyhelyzet sosem oldhat fel semmit.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mergeSite, type SyncSite } from '../src/shared/sync/merge';

function site(over: Partial<SyncSite>): SyncSite {
  return {
    id: 'site_1', domain: 'youtube.com', hostnames: ['youtube.com'],
    addedAt: 1_000, pauseUntil: null, pendingDeleteAt: null,
    rev: 3, updatedAt: 100, updatedBy: 'a',
    ...over,
  };
}

test('egyenlő rev: a hosztnevek egyesülnek — a versenyhelyzet nem old fel', () => {
  const a = site({ hostnames: ['youtube.com', 'www.youtube.com'], updatedAt: 100, updatedBy: 'a' });
  const b = site({ hostnames: ['youtube.com', 'music.youtube.com'], updatedAt: 200, updatedBy: 'b' });
  const expected = ['music.youtube.com', 'www.youtube.com', 'youtube.com'];
  assert.deepEqual(mergeSite(a, b).hostnames, expected);
  assert.deepEqual(mergeSite(b, a).hostnames, expected, 'szimmetrikus');
});

test('nagyobb rev: a levétel átmegy — a próbatétel mögötte van', () => {
  const trimmed = site({ hostnames: ['youtube.com'], rev: 4, updatedAt: 300 });
  const old = site({ hostnames: ['youtube.com', 'music.youtube.com'], rev: 3 });
  assert.deepEqual(mergeSite(trimmed, old).hostnames, ['youtube.com']);
  assert.deepEqual(mergeSite(old, trimmed).hostnames, ['youtube.com']);
});

// ------------------------------------------------------------------ jelek
//
// A név JELE a rekord rev-je, amelyik felvette vagy levette. Enélkül két baj
// van: egyenlő revnél az egyesítés visszahozná a kifizetett levételt, ha a
// másik eszköz ugyanabban a körben bármi mást írt; nagyobb revnél a nyertes
// rekord egyben vinné a régi listáját, ha kétszer írt.

test('egyenlő rev, a levételnek jele van: nem jön vissza, a másik gép szerkesztése marad', () => {
  const removed = site({ hostnames: ['youtube.com'], hostnameMarks: { 'music.youtube.com': 3 }, updatedAt: 100 });
  const other = site({ hostnames: ['music.youtube.com', 'youtube.com'], alias: 'tube', updatedAt: 200, updatedBy: 'b' });
  for (const [x, y] of [[removed, other], [other, removed]]) {
    const m = mergeSite(x, y);
    assert.deepEqual(m.hostnames, ['youtube.com'], 'a kifizetett levétel áll');
    assert.equal(m.alias, 'tube', 'a másik szerkesztés nem veszett el');
    assert.deepEqual(m.hostnameMarks, { 'music.youtube.com': 3 }, 'a jel utazik tovább');
  }
});

test('nagyobb rev a régi névvel: a jel akkor is dönt — a kétszer író gép nem hozza vissza', () => {
  const removed = site({ hostnames: ['youtube.com'], hostnameMarks: { 'music.youtube.com': 3 }, rev: 3 });
  const twice = site({ hostnames: ['music.youtube.com', 'youtube.com'], rev: 5, alias: 'tube', updatedBy: 'b' });
  const m = mergeSite(twice, removed);
  assert.deepEqual(m.hostnames, ['youtube.com']);
  assert.equal(m.alias, 'tube', 'a nagyobb rev a többi mezőt viszi');
});

test('újra felvéve nagyobb jellel: a felvétel nyer a régi levétel fölött', () => {
  const removed = site({ hostnames: ['youtube.com'], hostnameMarks: { 'music.youtube.com': 3 }, rev: 3 });
  const readded = site({ hostnames: ['music.youtube.com', 'youtube.com'], hostnameMarks: { 'music.youtube.com': 6 }, rev: 6 });
  for (const [x, y] of [[removed, readded], [readded, removed]]) {
    const m = mergeSite(x, y);
    assert.deepEqual(m.hostnames, ['music.youtube.com', 'youtube.com']);
    assert.deepEqual(m.hostnameMarks, { 'music.youtube.com': 6 });
  }
});

test('a régebbi rekord ingyenes felvétele sem vész el a nagyobb rev mögött', () => {
  const newer = site({ hostnames: ['youtube.com'], rev: 5 });
  const older = site({ hostnames: ['m.youtube.com', 'youtube.com'], hostnameMarks: { 'm.youtube.com': 4 }, rev: 4, updatedBy: 'b' });
  assert.deepEqual(mergeSite(newer, older).hostnames, ['m.youtube.com', 'youtube.com']);
});

test('egyenlő jel vagy jel nélkül: a bővebb nyer — a régi kliens is így fésül', () => {
  const a = site({ hostnames: ['youtube.com'], hostnameMarks: { 'music.youtube.com': 4 } });
  const b = site({ hostnames: ['music.youtube.com', 'youtube.com'], hostnameMarks: { 'music.youtube.com': 4 }, updatedBy: 'b' });
  assert.deepEqual(mergeSite(a, b).hostnames, ['music.youtube.com', 'youtube.com'], 'döntetlen: bent marad');
  const plain = site({ hostnames: ['youtube.com'] });
  const legacy = site({ hostnames: ['m.youtube.com', 'youtube.com'], updatedBy: 'b' });
  const m = mergeSite(plain, legacy);
  assert.deepEqual(m.hostnames, ['m.youtube.com', 'youtube.com']);
  assert.equal(m.hostnameMarks, undefined, 'jel nélkül nem keletkezik jel');
});

test('egyenlő rev, szigorúbb rekord: a szigorúbb nyer, a nevek attól még egyesülnek', () => {
  const stricter = site({ hostnames: ['youtube.com'], dailyLimitSeconds: 600 });
  const looser = site({ hostnames: ['youtube.com', 'm.youtube.com'], dailyLimitSeconds: 3600, updatedBy: 'b' });
  const m = mergeSite(stricter, looser);
  assert.equal(m.dailyLimitSeconds, 600);
  assert.deepEqual(m.hostnames, ['m.youtube.com', 'youtube.com']);
});
