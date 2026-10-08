// Az ablakos csomagok fésülése: az OSZTÁLY dönt, egészében — a kifizetett
// ablak-lazítások száma, aztán az, hogy van-e ablak —, az osztályon belül a
// SAJÁT jel.
//
// Az ablak és a fehérlista TILT (a menet magától indul), a jelet pedig egy
// ingyenes szerkesztés is lépteti. A jel-szabály alatt egy elavult eszköz
// egy átnevezéssel egészében visszahozta a régi változatot: a próbatétellel
// levett ablakot vissza, a máshol ingyen felvett ablakot el.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanOwnMarks, emptyFocus, mergeFocus, normalizeSyncFocus, sameFocus, type SyncFocus,
} from '../src/shared/sync/focus-merge';
import type { FocusPack } from '../src/shared/focus';
import type { Band } from '../src/shared/schedule';
import { bumpFocusRevision } from '../src/helper/revisions';
import { defaultState } from '../src/helper/state';

const WIN: Band = { days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 12 * 60 };
const LONG: Band = { days: [1, 2, 3, 4, 5], startMin: 8 * 60, endMin: 13 * 60 };
const SAT: Band = { days: [6], startMin: 8 * 60, endMin: 16 * 60 };
const pack = (id: string, over: Partial<FocusPack> = {}): FocusPack => ({
  id, name: `csomag ${id}`, allowSites: ['quizlet.com'], allowApps: [], defaultMinutes: 50, ...over,
});
const focus = (over: Partial<SyncFocus>): SyncFocus => ({ ...emptyFocus('gep'), ...over });
const both = (x: SyncFocus, y: SyncFocus): SyncFocus[] => [mergeFocus(x, y), mergeFocus(y, x)];

test('a kifizetett levétel nyer: egy elavult eszköz átnevezése nem hozza vissza az ablakot', () => {
  // A gép próbatétellel levette az ablakot (számláló 1); a telefon nem tudott
  // róla, és átnevezte a csomagot — a jele NAGYOBB. A jel-szabály alatt a
  // telefon régi, ablakos változata nyert volna, egészében.
  const paid = focus({ packs: [pack('p1')], packMarks: { p1: 4 }, packLoosens: { p1: 1 }, rev: 4 });
  const stale = focus({
    packs: [pack('p1', { name: 'átnevezve', recurrence: WIN })], packMarks: { p1: 7 }, rev: 7, updatedBy: 'telefon',
  });
  for (const m of both(paid, stale)) {
    assert.equal(m.packs[0].recurrence, undefined, 'az ablak levétele marad');
    assert.equal(m.packs[0].name, 'csomag p1', 'a győztes változat egészében');
    assert.deepEqual(m.packMarks, { p1: 7 }, 'a közös jel a nagyobb — a régi kliens ezt látja');
    assert.deepEqual(m.packLoosens, { p1: 1 });
    assert.deepEqual(m.packOwnMarks, { p1: 4 }, 'a győztes saját jele, mert kisebb a közösnél');
  }
});

test('az ingyen felvett ablak nyer egy azonos számú, ablak nélküli változat fölött — akármelyik jele nagyobb', () => {
  const windowed = focus({ packs: [pack('p1', { recurrence: WIN })], packMarks: { p1: 3 }, rev: 3 });
  const renamed = focus({
    packs: [pack('p1', { name: 'átnevezve', allowSites: ['quizlet.com', 'youtube.com'] })],
    packMarks: { p1: 8 }, rev: 8, updatedBy: 'telefon',
  });
  for (const m of both(windowed, renamed)) {
    assert.deepEqual(m.packs[0].recurrence, WIN, 'az ablak marad');
    assert.deepEqual(m.packs[0].allowSites, ['quizlet.com'], 'az ablaktalan változat bővítése nem megy át');
    assert.equal(m.packs[0].name, 'csomag p1', 'az ablakról nem tudó átnevezés elvész — kimondott korlát');
    assert.deepEqual(m.packOwnMarks, { p1: 3 });
  }
  // Az ablak nélküli TÖRLÉS sem viszi el: törölni csak levétel után lehet.
  const deleted = focus({ packs: [], packMarks: { p1: 9 }, rev: 9, updatedBy: 'telefon' });
  for (const m of both(windowed, deleted)) {
    assert.deepEqual(m.packs.map((p) => p.id), ['p1']);
    assert.deepEqual(m.packs[0].recurrence, WIN);
  }
});

test('két ablakos változat, azonos számmal: a hosszabb ablak, a fehérlisták metszete, a név a nagyobb saját jelé', () => {
  const a = focus({
    packs: [pack('p1', { name: 'régi név', recurrence: LONG, allowSites: ['anki.net', 'quizlet.com'] })],
    packMarks: { p1: 2 }, rev: 2,
  });
  const b = focus({
    packs: [pack('p1', { name: 'új név', recurrence: WIN, allowSites: ['duolingo.com', 'quizlet.com'] })],
    packMarks: { p1: 5 }, rev: 5, updatedBy: 'telefon',
  });
  for (const m of both(a, b)) {
    const p = m.packs[0];
    assert.deepEqual(p.recurrence, LONG, 'a hosszabb ablak (több heti perc)');
    assert.deepEqual(p.allowSites, ['quizlet.com'], 'a fehérlista csak szűkülhet');
    assert.equal(p.name, 'új név', 'a név szabad: a nagyobb saját jel viszi');
    assert.equal(m.packOwnMarks, undefined, 'azonos osztályban a saját jel a közös');
  }
  // Holtversenyben (azonos jel) a kódegység-sorrend — mindkét irányban ugyanaz.
  const c = focus({ packs: [pack('p1', { name: 'b', recurrence: SAT })], packMarks: { p1: 5 }, rev: 5 });
  const d = focus({ packs: [pack('p1', { name: 'a', recurrence: WIN })], packMarks: { p1: 5 }, rev: 5, updatedBy: 'x' });
  const [cd, dc] = both(c, d);
  assert.deepEqual(cd.packs, dc.packs);
  assert.equal(cd.packs[0].name, 'a');
  // Hétköznap 5×180 = 900 perc a szombati 480 ellen.
  assert.deepEqual(cd.packs[0].recurrence, WIN);
});

test('üres metszet: a rövidebb lista (holtversenyben a rendezett kulcs) — egy üres fehérlista mindent tiltana', () => {
  const a = focus({ packs: [pack('p1', { recurrence: WIN, allowSites: ['anki.net'] })], packMarks: { p1: 2 }, rev: 2 });
  const b = focus({
    packs: [pack('p1', { recurrence: WIN, allowSites: ['duolingo.com', 'quizlet.com'] })],
    packMarks: { p1: 2 }, rev: 2, updatedBy: 'telefon',
  });
  for (const m of both(a, b)) assert.deepEqual(m.packs[0].allowSites, ['anki.net']);
  const c = focus({ packs: [pack('p1', { recurrence: WIN, allowSites: ['quizlet.com'] })], packMarks: { p1: 2 }, rev: 2 });
  for (const m of both(a, c)) assert.deepEqual(m.packs[0].allowSites, ['anki.net'], 'a rendezett kulcs szerint');
  // Ha az egyik már üres, a metszet üres: ő maga kérte.
  const e = focus({ packs: [pack('p1', { recurrence: WIN, allowSites: [] })], packMarks: { p1: 2 }, rev: 2 });
  for (const m of both(a, e)) assert.deepEqual(m.packs[0].allowSites, []);
});

test('a SAJÁT jel: egy osztály-döntés vesztesének nagyobb jele nem dönt a győztes osztályon belül', () => {
  // A „a” eszköz elavult (nincs kifizetett lazítás), de a jele nagy, és
  // törölte a csomagot. A „b” és a „c” már a kifizetett levétel után él: a
  // „b”-ben a csomag megvan (saját jel 1), a „c”-ben törölve (saját jel 0).
  // A közös jel a nagyobb lenne mindenhol; ha az döntene, az nyerne, amelyik
  // az „a”-val ELŐBB találkozott — a sorrendtől függne.
  const a = focus({ packs: [], packMarks: { p3: 5 }, rev: 5 });
  const b = focus({ packs: [pack('p3')], packMarks: { p3: 1 }, packLoosens: { p3: 1 }, rev: 2, updatedBy: 'b' });
  const c = focus({ packs: [], packLoosens: { p3: 1 }, rev: 1, updatedBy: 'c' });
  const orders = [
    mergeFocus(mergeFocus(a, b), c), mergeFocus(mergeFocus(c, a), b), mergeFocus(mergeFocus(b, c), a),
    mergeFocus(mergeFocus(a, c), b), mergeFocus(mergeFocus(b, a), c), mergeFocus(mergeFocus(c, b), a),
  ];
  for (const m of orders) {
    assert.deepEqual(m.packs.map((p) => p.id), ['p3'], 'a „b” saját jele (1) a „c”-é (0) fölött');
    assert.deepEqual(m.packMarks, { p3: 5 });
    assert.deepEqual(m.packLoosens, { p3: 1 });
    assert.deepEqual(m.packOwnMarks, { p3: 1 });
  }
});

test('az osztályváltó helyi szerkesztés törli a saját jelet: annál a saját jel maga a közös', () => {
  const s = defaultState();
  s.focusPacks = [pack('p1'), pack('p2')];
  bumpFocusRevision(s, 'gep', 10);
  s.focusPackMarks = { p1: 1, p2: 1 };
  s.focusPackOwnMarks = { p1: 0, p2: 0 };
  s.focusPacks = [pack('p1', { name: 'új' }), pack('p2')];
  bumpFocusRevision(s, 'gep', 20);
  assert.equal(s.focusPackMarks?.p1, s.focusRev, 'a szerkesztett csomag jele a léptetés rev-je');
  assert.deepEqual(s.focusPackOwnMarks, { p2: 0 }, 'csak a szerkesztetté törlődik');
  s.focusPacks = [pack('p1', { name: 'új' })];
  bumpFocusRevision(s, 'gep', 30);
  assert.equal(s.focusPackOwnMarks, undefined, 'a törlés is szerkesztés');
});

test('a futó menet csomagja a törlés ellen is marad — de a kifizetetten levett ablaka nem jön vissza', () => {
  // A „b” próbatétellel levette az ablakot és törölte a csomagot; a „a”
  // közben (hálózat nélkül) elindította rá az ablakos menetet. A menet marad,
  // a csomagja is — de ablak nélkül: a levétel ki volt fizetve.
  const running = focus({
    packs: [pack('p1', { recurrence: WIN })], packMarks: { p1: 2 },
    run: { packId: 'p1', startedAt: 100, endsAt: 100 + 3 * 3_600_000 }, rev: 3,
  });
  const removed = focus({ packs: [], packMarks: { p1: 6 }, packLoosens: { p1: 1 }, rev: 6, updatedBy: 'telefon' });
  for (const m of both(running, removed)) {
    assert.equal(m.run?.packId, 'p1', 'a menet marad');
    assert.deepEqual(m.packs.map((p) => p.id), ['p1'], 'a csomagja is');
    assert.equal(m.packs[0].recurrence, undefined, 'az ablaka nem');
  }
});

test('a dróton: a saját jel nemnegatív egész, kisebb a csomag közös jelénél — különben nincs', () => {
  const n = normalizeSyncFocus({
    packs: [pack('p1'), pack('p2'), pack('p3')],
    packMarks: { p1: 4, p2: 4, p3: 4 },
    packLoosens: { p1: 2, p2: 9, p4: 1 },
    packOwnMarks: { p1: 0, p2: 4, p3: 2.5, p4: 1, p5: -1 },
    rev: 4, updatedAt: 1, updatedBy: 'x',
  }, 'x');
  assert.deepEqual(n.packOwnMarks, { p1: 0 }, 'a jelnél nem kisebb, a tört, a jel nélküli kiesik');
  assert.deepEqual(n.packLoosens, { p1: 2, p4: 1 }, 'a számláló legfeljebb a rev; a törölt csomagé marad');
  assert.equal(cleanOwnMarks({ p1: 1 }, undefined), undefined, 'közös jel nélkül nincs saját jel');
  assert.equal(cleanOwnMarks([1], { p1: 4 }), undefined);
});

test('a különbség feltöltést ér: a számláló és a saját jel is', () => {
  const base = focus({ packs: [pack('p1')], packMarks: { p1: 4 }, rev: 4 });
  assert.equal(sameFocus(base, { ...base, packLoosens: { p1: 1 } }), false);
  assert.equal(sameFocus(base, { ...base, packOwnMarks: { p1: 2 } }), false);
  assert.equal(sameFocus({ ...base, packOwnMarks: { p1: 2 } }, { ...base, packOwnMarks: { p1: 2 } }), true);
});

test('régi kliens blobja (számláló és saját jel nélkül): az alsó osztály szabálya a régi jel-szabály', () => {
  const older = focus({ packs: [pack('p1', { name: 'régi' })], packMarks: { p1: 3 }, rev: 3 });
  const newer = focus({ packs: [pack('p1', { name: 'új' })], packMarks: { p1: 5 }, rev: 5, updatedBy: 'telefon' });
  for (const m of both(older, newer)) {
    assert.equal(m.packs[0].name, 'új');
    assert.equal(m.packLoosens, undefined);
    assert.equal(m.packOwnMarks, undefined);
  }
});
