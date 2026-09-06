// A csomagok jelei: a csomaglista csomagonként fésülődik, nem egyben.
//
// A blob rev-jét a telefon egy menet indításával is lépteti. Jel nélkül egy
// azonos rev-ű, frissebb telefon-blob egyben hozta a RÉGI listáját, és a
// gépen frissen felvett ablak csendben eltűnt. A jel a csomaghoz tartozik.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  capPackMarks, emptyFocus, MAX_PACK_MARKS, mergeFocus, normalizeSyncFocus, sameFocus, type SyncFocus,
} from '../src/shared/sync/focus-merge';
import type { FocusPack } from '../src/shared/focus';
import type { Band } from '../src/shared/schedule';
import { adoptFocusRevision, bumpFocusRevision } from '../src/helper/revisions';
import { defaultState } from '../src/helper/state';

const WIN: Band = { days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 12 * 60 };
const pack = (id: string, over: Partial<FocusPack> = {}): FocusPack => ({
  id, name: `csomag ${id}`, allowSites: ['quizlet.com'], allowApps: [], defaultMinutes: 50, ...over,
});
const focus = (over: Partial<SyncFocus>): SyncFocus => ({ ...emptyFocus('gep'), ...over });

test('a gépen felvett ablak nem tűnik el a telefon egyidejű menet-indításától', () => {
  // A telefon blobja SZÁNDÉKOSAN az újabb (azonos rev, frissebb idő, később
  // rendezett azonosító): az „utolsó író nyer” őt választaná — a jel dönt.
  const desktop = focus({
    packs: [pack('p1', { recurrence: WIN })], packMarks: { p1: 6 }, rev: 6, updatedAt: 100, updatedBy: 'gep',
  });
  const phone = focus({
    packs: [pack('p1')], run: { packId: 'p1', startedAt: 150, endsAt: 150 + 3_000_000 },
    rev: 6, updatedAt: 200, updatedBy: 'telefon',
  });
  for (const [x, y] of [[desktop, phone], [phone, desktop]] as const) {
    const m = mergeFocus(x, y);
    assert.deepEqual(m.packs.map((p) => p.id), ['p1']);
    assert.deepEqual(m.packs[0].recurrence, WIN, 'az ablak marad');
    assert.ok(m.run, 'a telefon menete is marad');
    assert.deepEqual(m.packMarks, { p1: 6 });
  }
});

test('a törlés jele legyőzi a régebbi listát; jel nélkül az újabb blob dönt, ahogy eddig', () => {
  const deleted = focus({ packs: [pack('p2')], packMarks: { p1: 7 }, rev: 7, updatedAt: 100 });
  const stale = focus({ packs: [pack('p1'), pack('p2')], rev: 6, updatedAt: 50, updatedBy: 'telefon' });
  assert.deepEqual(mergeFocus(stale, deleted).packs.map((p) => p.id), ['p2']);
  assert.deepEqual(mergeFocus(deleted, stale).packMarks, { p1: 7 }, 'a sírkő utazik tovább');

  const newer = focus({ packs: [pack('p2')], rev: 7, updatedAt: 100 });
  const older = focus({ packs: [pack('p1'), pack('p2')], rev: 6, updatedAt: 50, updatedBy: 'telefon' });
  const m = mergeFocus(older, newer);
  assert.deepEqual(m.packs.map((p) => p.id), ['p2'], 'jel nélkül az újabb blob listája');
  assert.equal(m.packMarks, undefined, 'jel nélkül nem keletkezik jel');
});

test('újra felvéve nagyobb jellel a törlés fölött; a csak a régebbin élő csomag a végére kerül', () => {
  const readded = focus({ packs: [pack('p1', { name: 'új' })], packMarks: { p1: 9 }, rev: 9, updatedAt: 300 });
  const tomb = focus({ packs: [pack('p3')], packMarks: { p1: 7, p3: 8 }, rev: 8, updatedAt: 200, updatedBy: 'telefon' });
  const m = mergeFocus(tomb, readded);
  assert.deepEqual(m.packs.map((p) => p.id), ['p1', 'p3']);
  assert.equal(m.packs[0].name, 'új');
  assert.deepEqual(m.packMarks, { p1: 9, p3: 8 });
});

test('a törlés jele nem hagy csomag nélküli menetet: a menet csomagja marad', () => {
  // A gép törölte a csomagot (jellel), a telefon ugyanabban a körben menetet
  // indított rá. A menet a szigorúbb: a csomagja marad, a jele a menetes blob
  // rev-je. Csomag nélküli menet — amit a fogadó eldob, a küldő meg minden
  // körben újra feltölt — nem születik.
  const deleted = focus({ packs: [pack('p2')], packMarks: { p1: 7 }, rev: 7, updatedAt: 100 });
  const running = focus({
    packs: [pack('p1'), pack('p2')], run: { packId: 'p1', startedAt: 150, endsAt: 150 + 3_000_000 },
    rev: 7, updatedAt: 200, updatedBy: 'telefon',
  });
  for (const [x, y] of [[deleted, running], [running, deleted]] as const) {
    const m = mergeFocus(x, y);
    assert.deepEqual(m.packs.map((p) => p.id).sort(), ['p1', 'p2']);
    assert.equal(m.run?.packId, 'p1');
    assert.deepEqual(m.packMarks, { p1: 7 });
  }
  // Ha a törlés nagyobb rev-vel jött (próbatétel utáni leállítással), a
  // menet is elveszett — és vele a csomag: nincs csomag nélküli menet.
  const stopped = focus({ ...deleted, rev: 8, packMarks: { p1: 8 } });
  const m = mergeFocus(running, stopped);
  assert.equal(m.run, null);
  assert.deepEqual(m.packs.map((p) => p.id), ['p2']);
});

test('a jelek plafonja egy szabály: a jelen lévő csomagok jele marad, a töröltekből a legfrissebbek', () => {
  const marks: Record<string, number> = { 'p-jelen': 3 };
  for (let i = 0; i < 300; i++) marks[`t${String(i).padStart(3, '0')}`] = 100 + (i % 7);
  const capped = capPackMarks(marks, ['p-jelen'])!;
  assert.equal(Object.keys(capped).length, MAX_PACK_MARKS);
  assert.equal(capped['p-jelen'], 3, 'a jelen lévő csomag jele bent marad, pedig a legkisebb');
  const gone = Object.entries(capped).filter(([id]) => id !== 'p-jelen').map(([, v]) => v);
  assert.equal(gone.length, MAX_PACK_MARKS - 1);
  assert.ok(gone.every((v) => v > 100), 'a legrégebbi (100-as) jelekből estek ki');
  assert.equal(capPackMarks({}, []), undefined);
  // A fésülés és a bemenet is ezzel a plafonnal ad vissza.
  const a = focus({ packs: [pack('p-jelen')], packMarks: Object.fromEntries(Object.entries(marks).slice(0, 256)), rev: 200 });
  const b = focus({ packs: [pack('p-jelen')], packMarks: Object.fromEntries(Object.entries(marks).slice(30)), rev: 200, updatedBy: 'telefon' });
  assert.ok(Object.keys(mergeFocus(a, b).packMarks!).length <= MAX_PACK_MARKS);
  const n = normalizeSyncFocus({ ...a, packMarks: marks, rev: 150 }, 'x');
  assert.equal(n.packMarks?.['p-jelen'], 3);
  assert.ok(Object.keys(n.packMarks!).length <= MAX_PACK_MARKS);
  // A rev fölötti jel a bemeneten kiesik: a jel annak a blobnak a rev-je, amelyik írta.
  assert.deepEqual(normalizeSyncFocus({ ...focus({ packs: [pack('p1')], rev: 3 }), packMarks: { p1: 9, p2: 2 } }, 'x').packMarks, { p2: 2 });
});

test('a valódi jel legyőzi a menet indítását: a gép szerkesztése marad a telefon régi változata fölött', () => {
  // A gép rev 6-on bővítette az ablakot (jel 6); a telefon ugyanabban a
  // körben — a régi változattal — menetet indított (a menet jele hatásos,
  // rev 6). Egyenlő hatásos jel: a jelenlét nem kérdés, a VÁLTOZAT a valódi
  // jelé. A menet marad, a szerkesztés is.
  const wide: Band = { days: [1, 2, 3, 4, 5], startMin: 540, endMin: 780 };
  const desktop = focus({ packs: [pack('p1', { recurrence: wide })], packMarks: { p1: 6 }, rev: 6, updatedAt: 100 });
  const phone = focus({
    packs: [pack('p1', { recurrence: WIN })], run: { packId: 'p1', startedAt: 150, endsAt: 150 + 3_000_000 },
    rev: 6, updatedAt: 200, updatedBy: 'telefon',
  });
  for (const [x, y] of [[desktop, phone], [phone, desktop]] as const) {
    const m = mergeFocus(x, y);
    assert.deepEqual(m.packs[0].recurrence, wide, 'a gép bővített ablaka marad');
    assert.equal(m.run?.packId, 'p1', 'a telefon menete is marad');
    assert.deepEqual(m.packMarks, { p1: 6 });
  }
});

test('a 30-as plafon vágásából a menet csomagja és a jeles csomag nem esik ki', () => {
  // Az újabb blob tele van (30 jeltelen csomag), a régebbin egy 31. csomag
  // fut. A menet csomagja elöl áll, tehát bent marad; helyette egy jeltelen
  // esik ki. Csomag nélküli menet a vágásból sem születik.
  const full = Array.from({ length: 30 }, (_, i) => pack(`f${String(i).padStart(2, '0')}`));
  const newer = focus({ packs: full, rev: 6, updatedAt: 200, updatedBy: 'telefon' });
  const older = focus({
    packs: [...full.slice(0, 29), pack('q')], run: { packId: 'q', startedAt: 10, endsAt: 600_010 },
    rev: 6, updatedAt: 100,
  });
  for (const [x, y] of [[newer, older], [older, newer]] as const) {
    const m = mergeFocus(x, y);
    assert.equal(m.packs.length, 30);
    assert.equal(m.run?.packId, 'q');
    assert.ok(m.packs.some((p) => p.id === 'q'), 'a menet csomagja a listán van');
  }
  // A JELES (frissen felvett, ablakos) csomag sem esik ki egy jeltelen mögött.
  const marked = focus({
    packs: [...full.slice(0, 29), pack('w', { recurrence: WIN })], packMarks: { w: 7 }, rev: 7, updatedAt: 300,
  });
  const stale = focus({ packs: full, rev: 6, updatedAt: 100, updatedBy: 'telefon' });
  assert.ok(mergeFocus(stale, marked).packs.some((p) => p.id === 'w'), 'a jeles ablak marad');
});

test('azonos kulcs (rev, idő, eszköz), más tartalom: a tartalom dönt, mindkét sorrendben ugyanúgy', () => {
  // Egy fésülés után minden eszköz a győztes kulcsát veszi át, a tartalma
  // viszont a saját fésülése: két ilyen blob kulcsa egyezik. Ha az első
  // argumentum nyerne, az két eszköz örök oda-vissza írása lenne.
  const x = focus({ packs: [pack('p1', { name: 'X' })], rev: 3, updatedAt: 100, updatedBy: 'gep' });
  const y = focus({ packs: [pack('p1', { name: 'Y' })], rev: 3, updatedAt: 100, updatedBy: 'gep' });
  assert.equal(mergeFocus(x, y).packs[0].name, mergeFocus(y, x).packs[0].name);
  assert.ok(sameFocus(mergeFocus(x, y), mergeFocus(y, x)));
});

test('a normalizálásban kieső csomag jele is kiesik, a valódi törlésé marad', () => {
  // Egy üres nevű csomag kiesik — a jele is, különben a jel meg a hiánya
  // együtt sírkő lenne, és a csomag mindenhol törlődne. A p3 jele valódi
  // törlés (nincs ilyen csomag a listán): az marad.
  const raw = {
    packs: [pack('p1', { name: '   ' }), pack('p2')], run: null, log: [],
    packMarks: { p1: 3, p3: 2 }, rev: 5, updatedAt: 1, updatedBy: 'gep',
  };
  const n = normalizeSyncFocus(raw, 'x');
  assert.deepEqual(n.packs.map((p) => p.id), ['p2']);
  assert.deepEqual(n.packMarks, { p3: 2 });
  // Ha minden jel kiesik, nincs üres objektum.
  assert.equal(normalizeSyncFocus({ ...raw, packMarks: { p1: 3 } }, 'x').packMarks, undefined);
});

test('a jelek átjönnek a dróton — csak a valódiak —, és a különbségük feltöltést ér', () => {
  const raw = {
    packs: [pack('p1')], run: null, log: [],
    packMarks: { p1: 3, '': 2, p9: -1, px: 'x' }, rev: 3, updatedAt: 1, updatedBy: 'gep',
  };
  const n = normalizeSyncFocus(raw, 'x');
  assert.deepEqual(n.packMarks, { p1: 3 });
  assert.equal(normalizeSyncFocus({ ...raw, packMarks: {} }, 'x').packMarks, undefined);
  assert.equal(sameFocus(n, { ...n, packMarks: undefined }), false);
});

test('a léptetés jelet ad a változott csomagnak, a menet indítása nem; az átvétel az alap', () => {
  const st = defaultState();
  st.focusPacks = [pack('p1'), pack('p2')];
  bumpFocusRevision(st, 'gep', 10);
  assert.equal(st.focusRev, 1);
  assert.equal(st.focusPackMarks, undefined, 'az első léptetés jel nélkül');

  st.focusPacks = [pack('p1', { recurrence: WIN }), pack('p2')];
  bumpFocusRevision(st, 'gep', 20);
  assert.deepEqual(st.focusPackMarks, { p1: 2 }, 'az ablak felvétele jel');

  st.focusRun = { packId: 'p2', startedAt: 30, endsAt: 30 + 600_000 };
  bumpFocusRevision(st, 'gep', 30);
  assert.equal(st.focusRev, 3);
  assert.deepEqual(st.focusPackMarks, { p1: 2 }, 'a menet indítása nem jelöl csomagot');

  st.focusRun = null;
  st.focusPacks = [pack('p1', { recurrence: WIN })];
  bumpFocusRevision(st, 'gep', 40);
  assert.deepEqual(st.focusPackMarks, { p1: 2, p2: 4 }, 'a törlés is jel');

  st.focusPacks = [pack('p1', { recurrence: WIN }), pack('p3')];
  st.focusPackMarks = { p1: 2, p2: 4, p3: 5 };
  st.focusRev = 5;
  adoptFocusRevision(st);
  st.focusPacks = [pack('p1', { recurrence: WIN }), pack('p3', { name: 'más' })];
  bumpFocusRevision(st, 'gep', 60);
  assert.deepEqual(st.focusPackMarks, { p1: 2, p2: 4, p3: 6 }, 'az átvett lista az alap');
});
