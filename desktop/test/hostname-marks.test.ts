// A hosztnevek jelei a segédben: a `commit()` eleji rev-léptetés írja őket,
// a lista változásából. Itt azt nézzük, hogy PONTOSAN az kap jelet, ami
// változott — se több, se kevesebb —, és hogy a jelek nem hízhatnak a
// végtelenségig.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { adoptRevision, bumpRevisions } from '../src/helper/revisions';
import { defaultState, type HelperState, type SiteRec } from '../src/helper/state';

function withSite(hostnames: string[]): HelperState {
  const st = defaultState();
  st.sites = [{
    id: 's1', domain: 'x.com', hostnames, addedAt: 1, pauseUntil: null, pendingDeleteAt: null,
  }];
  return st;
}

const first = (st: HelperState): SiteRec => st.sites[0];

test('az első léptetés jel nélkül megy, utána a felvétel és a levétel is jelet kap', () => {
  const st = withSite(['www.x.com', 'x.com']);
  bumpRevisions(st, 'gep', 10);
  assert.equal(first(st).rev, 1);
  assert.equal(first(st).hostnameMarks, undefined, 'a felvételkor kapott nevek jel nélkül');
  assert.deepEqual(first(st).revHosts, ['www.x.com', 'x.com'], 'de a lista innentől el van téve');

  first(st).hostnames = ['x.com'];
  bumpRevisions(st, 'gep', 20);
  assert.equal(first(st).rev, 2);
  assert.deepEqual(first(st).hostnameMarks, { 'www.x.com': 2 }, 'a levétel a léptetett rev-et kapja');

  first(st).hostnames = ['m.x.com', 'www.x.com', 'x.com'];
  bumpRevisions(st, 'gep', 30);
  assert.deepEqual(first(st).hostnameMarks, { 'www.x.com': 3, 'm.x.com': 3 }, 'a visszavétel felülírja a régi jelet');

  // Más mező változása nem nyúl a jelekhez.
  first(st).alias = 'iksz';
  bumpRevisions(st, 'gep', 40);
  assert.equal(first(st).rev, 4);
  assert.deepEqual(first(st).hostnameMarks, { 'www.x.com': 3, 'm.x.com': 3 });

  // Változatlan rekordnál semmi nem történik.
  assert.equal(bumpRevisions(st, 'gep', 50), 0);
});

test('frissítés utáni első kör: a változatlan rekord is eltárolja a listát, hogy a következő változás jelet kapjon', () => {
  const st = withSite(['www.x.com', 'x.com']);
  first(st).rev = 7;
  bumpRevisions(st, 'gep', 10); // a lenyomat még hiányzik → ez léptet (8), és elteszi a listát
  assert.equal(first(st).rev, 8);
  first(st).hostnames = ['x.com'];
  bumpRevisions(st, 'gep', 20);
  assert.deepEqual(first(st).hostnameMarks, { 'www.x.com': 9 });
});

test('átvett rekord: az átvett lista az alap — a következő léptetés csak a valódi különbséget jelöli', () => {
  const st = withSite(['x.com']);
  st.sites[0] = adoptRevision({ ...first(st), hostnames: ['a.x.com', 'x.com'], rev: 3, hostnameMarks: { 'b.x.com': 2 } });
  assert.deepEqual(first(st).revHosts, ['a.x.com', 'x.com']);
  first(st).hostnames = ['x.com'];
  bumpRevisions(st, 'gep', 10);
  assert.deepEqual(first(st).hostnameMarks, { 'b.x.com': 2, 'a.x.com': 4 }, 'a régi jel marad, az új a léptetett rev');
});

test('a jelek száma korlátos: a levett nevek legrégebbi jelei esnek ki, a meglévőké marad', () => {
  const many = Array.from({ length: 70 }, (_, i) => `h${String(i).padStart(2, '0')}.x.com`);
  const st = withSite([...many, 'x.com']);
  bumpRevisions(st, 'gep', 10);
  first(st).hostnames = ['x.com'];
  bumpRevisions(st, 'gep', 20); // 70 levétel, mind 2-es jellel → 64 marad
  assert.equal(Object.keys(first(st).hostnameMarks ?? {}).length, 64);
  first(st).hostnames = ['uj.x.com', 'x.com'];
  bumpRevisions(st, 'gep', 30);
  const marks = first(st).hostnameMarks ?? {};
  assert.equal(marks['uj.x.com'], 3, 'a meglévő név jele bent van');
  assert.equal(Object.keys(marks).length, 64, 'a plafon tartja magát');
});
