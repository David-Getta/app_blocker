import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { emptyFocus, mergeFocus, mergeHide, normalizeSyncFocus } from '../src/shared/sync/focus-merge';
import { adoptFocusRevision, bumpFocusRevision } from '../src/helper/revisions';
import { defaultState } from '../src/helper/state';

// A LISTA REJTÉSE a fiók egészére szól: a telefonon bekapcsolt rejtés a gépen is
// áll. A bekapcsolás egy koppintás (szigorítás), a kikapcsolás a készülék
// azonosítása (munka) — és a kifizetett kikapcsolás átmegy: a JEL dönt, azonos
// jelnél a rejtett. A Kotlin és Swift párja a fixtúrán (merge-cases.json) át
// ugyanezt a fésülést járja végig.

const doc = (dev: string, rev: number, hide: boolean, mark?: number) => ({
  ...emptyFocus(dev), rev, updatedAt: 100, updatedBy: dev,
  ...(hide ? { hideSiteList: true } : {}), ...(mark ? { hideSiteListRev: mark } : {}),
});

test('a rejtés fésülése: a jel dönt, azonos jelnél a rejtett, a régi kliens semleges', () => {
  // A nagyobb jelű, kifizetett kikapcsolás átmegy — a rejtés nem támad fel egy régi blobból.
  assert.equal(mergeFocus(doc('a', 5, false, 5), doc('b', 3, true, 3)).hideSiteList, undefined);
  assert.equal(mergeFocus(doc('a', 3, true, 3), doc('b', 5, false, 5)).hideSiteList, undefined);
  // A nagyobb jelű rejtés átmegy.
  assert.equal(mergeFocus(doc('a', 5, true, 5), doc('b', 3, false, 3)).hideSiteList, true);
  // Azonos jelnél a rejtett — a szigorúbb irány.
  assert.equal(mergeFocus(doc('a', 4, true, 4), doc('b', 4, false, 4)).hideSiteList, true);
  assert.equal(mergeFocus(doc('a', 4, false, 4), doc('b', 4, true, 4)).hideSiteList, true);
  // A régi kliens (jel nélkül) nem tud kikapcsolni: a jeles rejtés marad.
  assert.equal(mergeFocus(doc('a', 9, false), doc('b', 2, true, 2)).hideSiteList, true);
  // A jel a nagyobb; rejtés nélkül nincs mező.
  assert.equal(mergeFocus(doc('a', 5, true, 5), doc('b', 3, false, 3)).hideSiteListRev, 5);
  assert.equal(mergeFocus(doc('a', 1, false), doc('b', 1, false)).hideSiteListRev, undefined);
  // Sorrendfüggetlen.
  const x = doc('a', 6, true, 6);
  const y = doc('b', 6, false, 2);
  assert.equal(mergeFocus(x, y).hideSiteList, mergeFocus(y, x).hideSiteList);
  // A tiszta szabály is.
  assert.equal(mergeHide(0, true, 0, false), true, 'jel nélkül a rejtett nyer');
  assert.equal(mergeHide(2, false, 1, true), false, 'a nagyobb jelű kikapcsolás nyer');
});

test('a bejövő rejtés-jel csak a blob rev-jéig érvényes, a rejtés csak igazként utazik', () => {
  const n = normalizeSyncFocus({ ...doc('a', 3, true, 3) }, 'a');
  assert.equal(n.hideSiteList, true);
  assert.equal(n.hideSiteListRev, 3);
  const over = normalizeSyncFocus({ ...doc('a', 3, true), hideSiteListRev: 9 }, 'a');
  assert.equal(over.hideSiteListRev, undefined, 'a rev fölötti jel eldobva');
  const off = normalizeSyncFocus({ ...doc('a', 3, false), hideSiteList: false }, 'a');
  assert.equal(off.hideSiteList, undefined, 'a hamis nem mező');
});

test('a rejtés be- és kikapcsolása lépteti a blobot, és a jele a blob száma; az átvett jel marad', () => {
  const state = defaultState();
  const now = 1_700_000_000_000;
  assert.equal(bumpFocusRevision(state, 'dev', now), false, 'üres állapot: nincs mit léptetni');
  state.hideSiteList = true;
  assert.equal(bumpFocusRevision(state, 'dev', now + 1), true, 'a bekapcsolás döntés');
  assert.equal(state.hideSiteListRev, state.focusRev);
  const rev = state.focusRev!;
  assert.equal(bumpFocusRevision(state, 'dev', now + 2), false, 'változatlan: nem léptet');
  delete state.hideSiteList;
  assert.equal(bumpFocusRevision(state, 'dev', now + 3), true, 'a kikapcsolás is döntés');
  assert.equal(state.hideSiteListRev, rev + 1);
  // Másik eszközről átvett rejtés: nincs léptetés, és egy későbbi saját, más
  // szerkesztés sem bélyegzi át a jelét (azzal a másik eszköz döntését írná felül).
  state.hideSiteList = true;
  state.hideSiteListRev = 7;
  adoptFocusRevision(state);
  assert.equal(bumpFocusRevision(state, 'dev', now + 4), false, 'az átvétel nem szerkesztés');
  state.focusPacks = [{ id: 'p1', name: 'Írás', allowSites: [], allowApps: [], defaultMinutes: 25 }];
  assert.equal(bumpFocusRevision(state, 'dev', now + 5), true);
  assert.equal(state.hideSiteListRev, 7, 'az átvett rejtés jele marad');
});
