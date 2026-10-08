// A szabálylista jele a segédben: a `commit()` eleji rev-léptetés írja, a
// lista változásából — ugyanaz az egy fogópont, mint a hosztnevek jeleié. Itt
// azt nézzük, hogy PONTOSAN a lista változása kap jelet, más mező nem nyúl
// hozzá, és a másik eszközről átvett jel marad.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { adoptRevision, bumpRevisions } from '../src/helper/revisions';
import { defaultState, type HelperState, type SiteRec } from '../src/helper/state';

function withSite(): HelperState {
  const st = defaultState();
  st.sites = [{
    id: 's1', domain: 'x.com', hostnames: ['x.com'], addedAt: 1, pauseUntil: null, pendingDeleteAt: null,
  }];
  return st;
}

const first = (st: HelperState): SiteRec => st.sites[0];

test('a lista változása a léptetett rev-et kapja; más mező nem nyúl a jelhez; az átvett jel marad', () => {
  const st = withSite();
  bumpRevisions(st, 'gep', 10);
  assert.equal(first(st).rev, 1);
  assert.equal(first(st).rulesRev, undefined, 'az első léptetés jel nélkül megy');
  assert.equal(first(st).revRulesKey, '-', 'de a kulcs innentől el van téve — a nincs-mező is kulcs');

  first(st).rules = [{ host: 'x.com', path: '/a' }];
  bumpRevisions(st, 'gep', 20);
  assert.equal(first(st).rev, 2);
  assert.equal(first(st).rulesRev, 2, 'a felvétel a léptetett rev-et kapja');

  first(st).alias = 'iksz';
  bumpRevisions(st, 'gep', 30);
  assert.equal(first(st).rev, 3);
  assert.equal(first(st).rulesRev, 2, 'más mező változása nem nyúl a jelhez');

  first(st).rules = [];
  bumpRevisions(st, 'gep', 40);
  assert.equal(first(st).rulesRev, 4, 'a levétel is jelet kap — az üres lista is lista');

  // Átvétel a másik eszközről: a jele marad egy saját, más szerkesztés után is.
  st.sites[0] = adoptRevision({ ...first(st), rules: [{ host: 'x.com', path: '/b' }], rulesRev: 7, rev: 7 });
  assert.equal(bumpRevisions(st, 'gep', 50), 0, 'az átvétel nem szerkesztés');
  first(st).alias = 'ipszilon';
  bumpRevisions(st, 'gep', 60);
  assert.equal(first(st).rev, 8);
  assert.equal(first(st).rulesRev, 7, 'az átvett jel marad');

  // A sorrend nem változás: ugyanaz a két szabály fordítva nem léptet és nem jelöl.
  first(st).rules = [{ host: 'x.com', path: '/c' }, { host: 'x.com', path: '/b' }];
  bumpRevisions(st, 'gep', 70);
  assert.equal(first(st).rulesRev, 9);
  first(st).rules = [{ host: 'x.com', path: '/b' }, { host: 'x.com', path: '/c' }];
  assert.equal(bumpRevisions(st, 'gep', 80), 0);
  assert.equal(first(st).rulesRev, 9);
});

test('szabályonként: a felvétel és a levétel is a léptetett rev-et kapja, a levett szabály jele sírkő', () => {
  const st = withSite();
  first(st).rules = [{ host: 'x.com', path: '/a' }];
  // Az első léptetés (nincs még eltett lista) jel nélkül megy — a frissítés
  // előtti szabályokra a jelenlét-nyer szabály áll.
  bumpRevisions(st, 'gep', 10);
  assert.equal(first(st).ruleMarks, undefined);
  assert.deepEqual(first(st).revRules, ['x.com/a']);

  first(st).rules = [{ host: 'x.com', path: '/a' }, { host: 'x.com', path: '/b' }];
  bumpRevisions(st, 'gep', 20);
  assert.equal(first(st).rev, 2);
  assert.deepEqual(first(st).ruleMarks, { 'x.com/b': 2 }, 'csak a felvett szabály kap jelet');

  first(st).rules = [{ host: 'x.com', path: '/b' }];
  bumpRevisions(st, 'gep', 30);
  assert.deepEqual(first(st).ruleMarks, { 'x.com/a': 3, 'x.com/b': 2 }, 'a levett szabály sírkövet kap');

  first(st).alias = 'iksz';
  bumpRevisions(st, 'gep', 40);
  assert.deepEqual(first(st).ruleMarks, { 'x.com/a': 3, 'x.com/b': 2 }, 'más mező nem nyúl a jelekhez');

  // Átvétel: a fésült lista és jelei maradnak, a saját léptetés nem jelöli újra.
  st.sites[0] = adoptRevision({
    ...first(st), rules: [{ host: 'x.com', path: '/c' }], ruleMarks: { 'x.com/a': 3, 'x.com/b': 7, 'x.com/c': 6 }, rev: 7,
  });
  first(st).alias = 'ipszilon';
  bumpRevisions(st, 'gep', 50);
  assert.equal(first(st).rev, 8);
  assert.deepEqual(first(st).ruleMarks, { 'x.com/a': 3, 'x.com/b': 7, 'x.com/c': 6 });
});
