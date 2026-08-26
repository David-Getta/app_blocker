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
import {
  changeFocus, claimDelay, deleteFocusPack, saveFocusPack, startFocus, submitAnswer, tick,
} from '../src/helper/referee';
import { defaultState, type HelperState, type SessionRec } from '../src/helper/state';
import { MAX_FOCUS_LOG, type FocusPack } from '../src/shared/focus';

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

test('a naturally expired session is written to the log', () => {
  // Enélkül a statisztika csak a leállított meneteket látná — vagyis pont a
  // rossz felét. Aki mindent végigvisz, azt hinné, hogy nem is használja.
  const st = stateWithPack();
  startFocus(st, 'p1', 1, NOW);
  tick(st, NOW + 61_000);
  assert.equal(st.focusLog?.length, 1);
  const row = st.focusLog![0];
  assert.equal(row.packName, 'Nyelvtanulás', 'a csomag AKKORI neve marad meg');
  assert.equal(row.stopped, false, 'magától járt le');
  // A TERVEZETT vég kerül be, nem a takarítás pillanata: a `tick` késhet pár
  // másodpercet, és egy „51 perces” ötvenperces menet apró, de fölösleges
  // hazugság lenne.
  assert.equal(row.endedAt, row.plannedEndsAt);
});

test('a session stopped by a challenge is logged as stopped', () => {
  const st = stateWithPack();
  startFocus(st, 'p1', 50, NOW);
  const planned = st.focusRun!.endsAt;
  changeFocus(st, null, NOW);
  // A próbatétel teljesítése: a bíró záró ága.
  finishChallenge(st, NOW + 5_000);
  assert.equal(st.focusRun, null);
  assert.equal(st.focusLog?.length, 1);
  assert.equal(st.focusLog![0].stopped, true, 'próbatétellel ért véget');
  assert.ok(st.focusLog![0].endedAt < planned, 'a tervezettnél korábban');
});

test('the log does not grow without bound', () => {
  const st = stateWithPack();
  for (let i = 0; i < MAX_FOCUS_LOG + 15; i++) {
    startFocus(st, 'p1', 1, NOW + i * 120_000);
    tick(st, NOW + i * 120_000 + 61_000);
  }
  assert.equal(st.focusLog?.length, MAX_FOCUS_LOG);
});

/**
 * A folyamatban lévő próbatétel VÉGIGCSINÁLÁSA.
 *
 * Nem trükközünk: ugyanazon az úton megy, mint a felhasználó — csak a
 * válaszokat tudjuk. Így a teszt azt méri, ami tényleg történik, nem egy
 * megkerülő ösvényt.
 */
function finishChallenge(st: HelperState, now: number): void {
  let guard = 0;
  while (st.session && guard++ < 200) {
    const step = st.session.steps[st.session.stepIndex];
    if (step.type === 'DELAY') {
      // A várakozó lépés nem válasszal megy: a bíró a türelmi idő letelte után
      // engedi tovább.
      step.claimableAt = now - 1;
      claimDelay(st, st.session.id, now);
      continue;
    }
    submitAnswer(st, st.session.id, solveStep(step, now), now);
  }
}

function solveStep(step: SessionRec['steps'][number], now: number): string {
  switch (step.type) {
    case 'TRANSCRIBE': return step.text;
    case 'MATH_CHAIN': return String(step.problems[step.pos].a);
    case 'MEMORY':
      // A mutatás és a várakozás ideje letelt — ezt szimuláljuk.
      step.armedAt = now - step.showMs - step.waitMs - 1000;
      return step.code;
    case 'REVERSE': return [...step.text].reverse().join('');
    default: throw new Error(`ismeretlen lépés: ${step.type}`);
  }
}

test('a session cannot be started from a pack that does not exist', () => {
  const st = defaultState();
  assert.throws(() => startFocus(st, 'nincs', 50, NOW), /Ismeretlen csomag/);
  assert.throws(() => changeFocus(st, null, NOW), /Nem fut/);
});
