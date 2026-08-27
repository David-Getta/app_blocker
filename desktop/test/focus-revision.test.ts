import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { bumpFocusRevision } from '../src/helper/revisions';
import { defaultState, type HelperState } from '../src/helper/state';
import type { FocusPack } from '../src/shared/focus';

/**
 * A munkamenet számlálója és az ÓRA-ÁTÁLLÍTÁS.
 *
 * A segéd alvásból ébredve elnyeli az óra ugrását: a futó menet kezdését és
 * végét ugyanannyival tolja el, hogy a menet ne legyen „lejárt”. Ez nem
 * döntés, csak helyi újraértelmezés — a felhasználó nem csinált semmit.
 *
 * A lenyomat viszont korábban az ABSZOLÚT időpontokat nézte, tehát az eltolás
 * változásnak látszott, és léptette a számlálót. Következmény: az alvó eszköz
 * „még fut” állapota legyőzte az ébren lévő eszköz szabályos, próbatétellel
 * megszerzett lezárását — a menet VISSZATÉRT a másik gépen.
 *
 * Ezért néz a lenyomat HOSSZAT. Egy egyenletes eltolás nem változtatja meg.
 */

const NOW = 1_800_000_000_000;
const PACK: FocusPack = {
  id: 'p1', name: 'Nyelvtanulás', allowSites: ['google.com'], allowApps: ['Word'],
  defaultMinutes: 50,
};

function running(): HelperState {
  const st = defaultState();
  st.focusPacks = [PACK];
  st.focusRun = { packId: 'p1', startedAt: NOW, endsAt: NOW + 50 * 60_000 };
  bumpFocusRevision(st, 'gep', NOW);
  return st;
}

test('az óra-ugrás elnyelése NEM lépteti a számlálót', () => {
  const st = running();
  const before = st.focusRev;
  const shift = 8 * 3600_000;
  st.focusRun = {
    ...st.focusRun!,
    startedAt: st.focusRun!.startedAt + shift,
    endsAt: st.focusRun!.endsAt + shift,
  };
  assert.equal(bumpFocusRevision(st, 'gep', NOW + shift), false);
  assert.equal(st.focusRev, before, 'egy eltolás nem szerkesztés');
});

test('a menet MEGHOSSZABBÍTÁSA viszont léptet', () => {
  // Ez a valódi különbség: a hossz változott, tehát döntés történt.
  const st = running();
  const before = st.focusRev ?? 0;
  st.focusRun = { ...st.focusRun!, endsAt: st.focusRun!.endsAt + 10 * 60_000 };
  assert.equal(bumpFocusRevision(st, 'gep', NOW + 1000), true);
  assert.equal(st.focusRev, before + 1);
});

test('a menet leállítása léptet', () => {
  const st = running();
  const before = st.focusRev ?? 0;
  st.focusRun = null;
  assert.equal(bumpFocusRevision(st, 'gep', NOW + 1000), true);
  assert.equal(st.focusRev, before + 1);
});

test('egy csomag szerkesztése léptet', () => {
  const st = running();
  const before = st.focusRev ?? 0;
  st.focusPacks = [{ ...PACK, allowSites: ['google.com', 'wikipedia.org'] }];
  assert.equal(bumpFocusRevision(st, 'gep', NOW + 1000), true);
  assert.equal(st.focusRev, before + 1);
});

// -------------------------------------------------------- formátumváltás

/**
 * A régi alakú lenyomat a lemezen.
 *
 * Frissítés után ez a valóság minden eszközön. Ha ilyenkor a kör vakon
 * léptetne, egy ÜRES eszköz 1-esre ugrana, és az üres listája legyőzhetné a
 * gépen felvett csomagokat — ez a hiba egyszer már majdnem megtörtént.
 */
function oldStyleFp(st: HelperState): string {
  // Ugyanaz, amit a régi algoritmus adott: kimásolva, mert a teszt épp azt
  // ellenőrzi, hogy a kód FELISMERI a régi alakot.
  const crypto = require('node:crypto') as typeof import('node:crypto');
  const packs = [...(st.focusPacks ?? [])]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => [p.id, p.name, [...p.allowSites].sort(), [...p.allowApps].sort(), p.defaultMinutes]);
  const run = st.focusRun
    ? [st.focusRun.packId, st.focusRun.startedAt, st.focusRun.endsAt]
    : null;
  return crypto.createHash('sha256').update(JSON.stringify([packs, run]))
    .digest('hex').slice(0, 16);
}

test('a formátumváltás önmagában NEM léptet', () => {
  const st = running();
  st.focusRevFp = oldStyleFp(st); // mintha frissítés előttről maradt volna
  const before = st.focusRev;
  assert.equal(bumpFocusRevision(st, 'gep', NOW + 1000), false);
  assert.equal(st.focusRev, before);
  assert.ok(st.focusRevFp!.startsWith('2|'), 'az új alakot viszont átvette');
});

test('a formátumváltás nem NYELI EL a közben történt szerkesztést', () => {
  // A veszélyes eset: a felhasználó frissítés után, az első mentés előtt még
  // hozzáír a csomaghoz. Ha a váltás vakon átvenné az új lenyomatot, az a
  // szerkesztés SOHA nem érne át a többi eszközre — csendben.
  const st = running();
  st.focusRevFp = oldStyleFp(st);
  st.focusPacks = [{ ...PACK, allowApps: ['Word', 'Excel'] }];
  const before = st.focusRev ?? 0;
  assert.equal(bumpFocusRevision(st, 'gep', NOW + 1000), true);
  assert.equal(st.focusRev, before + 1);
});

test('ÜRES eszközön a formátumváltás sem léptet', () => {
  // A legfontosabb sor ebben a fájlban. Egy üres eszköz 1-es számlálóval és
  // friss időbélyeggel legyőzné a gépen felvett csomagokat, és csendben
  // letörölné őket.
  const st = defaultState();
  st.focusRevFp = oldStyleFp(st);
  assert.equal(bumpFocusRevision(st, 'telefon', NOW), false);
  assert.equal(st.focusRev, undefined);
});
