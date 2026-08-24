// A munkamenet súrlódása.
//
// A funkció akkor ér valamit, ha a LEÁLLÍTÁSA nem egy gomb. Három kiskaput kell
// zárni, és mindegyik kézenfekvő:
//
//   1. leállítom -> ha ingyen van, a munkamenet egy „mégsem” gomb;
//   2. rövidítem -> ugyanaz, csak lassabban;
//   3. menet közben hozzáírok a fehérlistához, vagy indítok egy másik,
//      megengedőbb csomagot -> a munkamenet önmagát oldja fel, csendben.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { changeFocus, deleteFocusPack, saveFocusPack, startFocus, tick } from '../src/helper/referee';
import { defaultState, type HelperState } from '../src/helper/state';
import type { FocusPack } from '../src/shared/focus';

const NOW = 1_800_000_000_000;

const PACK: FocusPack = {
  id: 'p1', name: 'Nyelvtanulás', allowSites: ['google.com'], allowApps: ['Word'],
  defaultMinutes: 50,
};

function stateWithPack(): HelperState {
  const st = defaultState();
  saveFocusPack(st, PACK, NOW);
  return st;
}

test('starting a session is free, and it knows when it ends', () => {
  const st = stateWithPack();
  const r = startFocus(st, 'p1', 50, NOW);
  assert.equal(r.run.packId, 'p1');
  assert.equal(r.run.endsAt, NOW + 50 * 60_000);
  assert.equal(st.session, null, 'indítani nem kerül próbatételbe');
});

test('extending is free, stopping and shortening are not', () => {
  const st = stateWithPack();
  startFocus(st, 'p1', 50, NOW);
  const end = st.focusRun!.endsAt;

  const longer = changeFocus(st, end + 10 * 60_000, NOW);
  assert.equal(longer.applied, true, 'hosszabbítani szabad');
  assert.equal(st.session, null);

  const shorter = changeFocus(st, end - 10 * 60_000, NOW);
  assert.equal(shorter.applied, false, 'rövidíteni nem');
  assert.ok(shorter.session, 'próbatétel indul');
  assert.equal(st.focusRun!.endsAt, end + 10 * 60_000, 'addig a munkamenet FUT');
});

test('a second session cannot be started to escape the first', () => {
  // Ez a legkézenfekvőbb kiskapu: indítok egy „minden engedve” csomagot, és a
  // futó munkamenet semmivé válik — próbatétel nélkül.
  const st = stateWithPack();
  saveFocusPack(st, { ...PACK, id: 'p2', name: 'Minden', allowSites: [] }, NOW);
  startFocus(st, 'p1', 50, NOW);
  assert.throws(() => startFocus(st, 'p2', 5, NOW), /Már fut/);
  assert.equal(st.focusRun!.packId, 'p1');
});

test('the running pack is frozen', () => {
  // Menet közben a fehérlistához hozzáírni azt jelentené, hogy a munkamenet
  // önmagát oldja fel. Csendben, egyetlen mezőn keresztül.
  const st = stateWithPack();
  startFocus(st, 'p1', 50, NOW);
  assert.throws(
    () => saveFocusPack(st, { ...PACK, allowSites: ['google.com', 'youtube.com'] }, NOW),
    /épp fut/,
  );
  assert.throws(() => deleteFocusPack(st, 'p1', NOW), /épp fut/);
  // A TÖBBI csomag viszont szerkeszthető: az nem befolyásol semmit.
  const packs = saveFocusPack(st, { ...PACK, id: 'p2', name: 'Másik' }, NOW);
  assert.equal(packs.length, 2);
});

test('a finished challenge is what actually stops the session', () => {
  const st = stateWithPack();
  startFocus(st, 'p1', 50, NOW);
  changeFocus(st, null, NOW);            // leállítás kérése
  assert.ok(st.session, 'fut a próbatétel');
  assert.ok(st.focusRun, 'a munkamenet addig érvényes');

  // A bíró teljesítés-ága: a -1 azt jelenti, hogy le kell állítani.
  assert.equal(st.session!.pendingFocusEnd, -1);
});

test('an expired session clears itself', () => {
  // Enélkül egy ottfelejtett rekord örökre futó munkamenetnek látszana — a
  // felületen és a bővítményben egyaránt.
  const st = stateWithPack();
  startFocus(st, 'p1', 1, NOW);
  assert.equal(tick(st, NOW + 30_000), false, 'félidőben nincs mit tenni');
  assert.ok(st.focusRun);
  assert.equal(tick(st, NOW + 61_000), true);
  assert.equal(st.focusRun, null);
});

test('a session cannot be started from a pack that does not exist', () => {
  const st = defaultState();
  assert.throws(() => startFocus(st, 'nincs', 50, NOW), /Ismeretlen csomag/);
  assert.throws(() => changeFocus(st, null, NOW), /Nem fut/);
});
