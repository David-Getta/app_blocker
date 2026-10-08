// Véletlen oldal-listák: mit ígér a lista fésülése, és mit NEM.
//
// A rekordonkénti fésülés sorrendfüggetlen (merge-fuzz). A LISTA fésülése
// erre épül, de a domain szerinti összevonás eldobja a beolvasztott
// azonosítót — ezért nem minden esetben az. Ez a teszt kimondja, hol áll a
// sorrendfüggetlenség, és mi áll ott is, ahol nem:
//
//   1. Szimmetrikus és idempotens — mindig.
//   2. Három eszköz bármilyen sorrendben ugyanoda jut — ha nincs olyan
//      domain, amelyre két azonosító szól, és valamelyiknek sírköve van.
//   3. A domain legújabban felvett példányát csak a saját sírköve viheti el —
//      MINDEN sorrendben. Ez a régi törlés és az újra felvett oldal esete: ha
//      a régi törlés hálózat nélkül ment végig, és egy elavult eszköz addigra
//      a kettőt egybe vonta, a régi sírköve sem viheti el az újat.
//   4. A kiszolgálón át futó szinkron mindig megáll: néhány kör után minden
//      eszköz ugyanazt a listát tartja (melyiket, az a sorrendtől függhet).
//
// Rögzített magú véletlen (merge-random.ts `randomListCase`): két azonosító
// ugyanarra a domainre, élő, váró, halott, visszavont és régi kérés.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { foldedIds, isGone, mergeSite, mergeSiteLists, type SyncSite } from '../src/shared/sync/merge';
import { listConformanceKey, randomListCase, rng } from './merge-random';
import { fuzzSeeds } from './fuzz-depth';

const m = mergeSiteLists;
const key = (l: SyncSite[]): string => JSON.stringify(listConformanceKey(l));

/** A hat sorrend, ahogy három eszköz egymás után fésülhet. */
function allOrders(a: SyncSite[], b: SyncSite[], c: SyncSite[]): SyncSite[][] {
  return [m(m(a, b), c), m(m(b, c), a), m(m(c, a), b), m(m(a, c), b), m(m(b, a), c), m(m(c, b), a)];
}

/** Azonosítónként az összes másolat fésülve — ez sorrendfüggetlen. */
function joinById(all: SyncSite[]): Map<string, SyncSite> {
  const byId = new Map<string, SyncSite>();
  for (const s of all) {
    const mine = byId.get(s.id);
    byId.set(s.id, mine ? mergeSite(mine, s) : s);
  }
  return byId;
}

/** Van-e domain két azonosítóval, amelynek valamelyik másolata halott. */
function foldMeetsTombstone(all: SyncSite[]): boolean {
  const ids = new Map<string, Set<string>>();
  for (const s of all) ids.set(s.domain, (ids.get(s.domain) ?? new Set()).add(s.id));
  return all.some((s) => (ids.get(s.domain)?.size ?? 0) > 1 && isGone(s));
}

/** A domainek, amelyeknek a legújabban felvett példánya azonosító szerint fésülve él. */
function newestAlive(all: SyncSite[]): string[] {
  const newest = new Map<string, SyncSite>();
  for (const s of joinById(all).values()) {
    const cur = newest.get(s.domain);
    if (!cur || s.addedAt > cur.addedAt || (s.addedAt === cur.addedAt && s.id > cur.id)) newest.set(s.domain, s);
  }
  return [...newest.values()].filter((s) => !isGone(s)).map((s) => s.domain);
}

const liveDomains = (l: SyncSite[]): Set<string> => new Set(l.filter((s) => !isGone(s)).map((s) => s.domain));

test('lista: szimmetrikus és idempotens — mindig', () => {
  for (let seed = 1; seed <= fuzzSeeds(3000); seed++) {
    const { a, b, c } = randomListCase(rng(seed));
    const ab = m(a, b);
    assert.equal(key(ab), key(m(b, a)), `szimmetria, mag ${seed}`);
    assert.equal(key(m(ab, ab)), key(ab), `idempotens, mag ${seed}`);
    const abc = m(ab, c);
    assert.equal(key(m(abc, abc)), key(abc), `idempotens három eszköz után, mag ${seed}`);
  }
});

test('lista: három eszköz bármilyen sorrendben ugyanoda jut, ha nincs domain-pár sírkővel', () => {
  let checked = 0;
  for (let seed = 1; seed <= fuzzSeeds(3000); seed++) {
    const { a, b, c } = randomListCase(rng(seed));
    if (foldMeetsTombstone([...a, ...b, ...c])) continue;
    checked++;
    const orders = allOrders(a, b, c);
    const want = key(orders[0]);
    orders.forEach((r, i) => assert.equal(key(r), want, `sorrend ${i}, mag ${seed}`));
    // Egy már látott lista újra fésülve nem mozdít semmit.
    for (const x of [a, b, c]) assert.equal(key(m(orders[0], x)), want, `újra fésülve, mag ${seed}`);
  }
  assert.ok(checked > fuzzSeeds(3000) / 3, `kevés eset jutott ide: ${checked}`);
});

test('lista: a legújabban felvett példányt csak a saját sírköve viheti el — minden sorrendben', () => {
  let protectedCases = 0;
  for (let seed = 1; seed <= fuzzSeeds(3000); seed++) {
    const { a, b, c } = randomListCase(rng(seed));
    const all = [...a, ...b, ...c];
    const must = newestAlive(all);
    if (foldMeetsTombstone(all) && must.length > 0) protectedCases++;
    allOrders(a, b, c).forEach((r, i) => {
      const live = liveDomains(r);
      for (const d of must) assert.ok(live.has(d), `${d} eltűnt, sorrend ${i}, mag ${seed}`);
    });
  }
  assert.ok(protectedCases > 0, 'a véletlen sosem hozott olyan esetet, ahol a védelem számít');
});

test('lista: a kiszolgálón át futó szinkron néhány kör után megáll', () => {
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (let seed = 1; seed <= fuzzSeeds(500); seed++) {
    const { a, b, c } = randomListCase(rng(seed));
    const must = newestAlive([...a, ...b, ...c]);
    for (const p of perms) {
      const dev = [a, b, c];
      let server: SyncSite[] = [];
      let rounds = 0;
      for (;;) {
        const before = key(server) + dev.map(key).join('#');
        for (const i of p) { server = m(dev[i], server); dev[i] = server; }
        rounds++;
        if (before === key(server) + dev.map(key).join('#')) break;
        assert.ok(rounds <= 6, `nem áll meg, mag ${seed}, sorrend ${p.join('')}`);
      }
      for (const d of must) assert.ok(liveDomains(server).has(d), `${d} eltűnt a kiszolgálón, mag ${seed}`);
    }
  }
});

test('az összevonás nyoma: melyik helyi azonosító olvadt bele egy másikba', () => {
  const rec = (id: string, domain: string, extra: Partial<SyncSite> = {}): SyncSite => ({
    id, domain, hostnames: [domain], addedAt: 1_000, pauseUntil: null, pendingDeleteAt: null,
    rev: 1, updatedAt: 100, updatedBy: 'gep-a', ...extra,
  });
  const local = [rec('s1', 'youtube.com'), rec('s2', 'reddit.com'), rec('s4', 'x.com')];
  const merged = [
    rec('s3', 'youtube.com', { addedAt: 3_000 }), rec('s2', 'reddit.com'),
    rec('s5', 'x.com', { pendingDeleteAt: 5_000, deleteLoosens: 1, goneLoosens: 1 }),
  ];
  assert.deepEqual([...foldedIds(local, merged)], [['s1', 's3']],
    'a megmaradt azonosító nem olvadt bele semmibe; halott rekordba nem olvad semmi');
});
