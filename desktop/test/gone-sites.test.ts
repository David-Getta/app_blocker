// A végigment törlés SÍRKÖVE (shared/sync/merge.ts `isGone`).
//
// Eddig a végigment törlés örökre a fiókban maradt: a hiányzó rekord sosem
// jelent törlést, tehát minden kör visszahozta, a bíró újra törölte, és a
// mentése új kört ütemezett — a gép félpercenként húzott, és az oldal egy-egy
// pillanatra visszakerült a hosts fájlba. Egy régi, a kérést sem látott eszköz
// pedig feltámaszthatta. Itt a szabály darabjai; a teljes kör a
// sync-client.test.ts-ben, valódi kiszolgálóval.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-gone-'));
process.env.BREAKER_STATE = path.join(tmp, 'state.json');

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  capGone, isGone, MAX_GONE_SITES, mergeSite, mergeSiteLists, settleIncoming, splitMerged, tombstoneOf,
  type SyncSite,
} from '../src/shared/sync/merge';
import { normalizeIncomingSites } from '../src/helper/sync-client';
import { tick } from '../src/helper/referee';
import { defaultState, loadState, saveState, type SiteRec } from '../src/helper/state';

function site(over: Partial<SyncSite> = {}): SyncSite {
  return {
    id: 's1', domain: 'x.com', hostnames: ['x.com'], addedAt: 1_000, pauseUntil: null, pendingDeleteAt: null,
    rev: 3, updatedAt: 100, updatedBy: 'gep-a', ...over,
  };
}

const stone = (over: Partial<SyncSite> = {}) =>
  site({ pendingDeleteAt: 5_000, deleteLoosens: 1, goneLoosens: 1, ...over });

test('halott: a végigment kérés a legutóbbi, és senki nem vonta vissza', () => {
  assert.equal(isGone(stone()), true);
  assert.equal(isGone(stone({ pendingDeleteAt: null })), false, 'visszavonva (egyenlő számláló, nem vár)');
  assert.equal(isGone(stone({ deleteLoosens: 2 })), false, 'új kérés jött (nagyobb számláló)');
  assert.equal(isGone(site({ pendingDeleteAt: 5_000 })), false, 'jel nélkül nincs sírkő');
  assert.equal(isGone(site({ pendingDeleteAt: 5_000, goneLoosens: 0 })), false);
});

test('a sírkő csak kifizetett törlésnek jár, és a rekord minden mezőjét viszi', () => {
  const s = site({ pendingDeleteAt: 5_000, deleteLoosens: 2, pauseUntil: 9_000, dailyLimitSeconds: 600 });
  const t = tombstoneOf(s)!;
  assert.equal(t.goneLoosens, 2);
  assert.equal(t.pauseUntil, null, 'a szünet nem utazik');
  assert.equal(t.dailyLimitSeconds, 600, 'ha egy visszavonás feltámasztja, a kerete ne vesszen el');
  assert.equal(isGone(t), true);
  assert.equal(tombstoneOf(site({ pendingDeleteAt: 5_000 })), null, 'a régi, számláló nélküli kérés nem kap sírkövet');
  assert.equal(tombstoneOf(site({ deleteLoosens: 1 })), null, 'ami nem vár, az nem ment végig');
});

test('a régi eszköz rekordja a sírkővel fésülve halott — nem támasztja fel az oldalt', () => {
  // A régi eszköz nem látta a kérést, és azóta ingyen szerkesztett: nagyobb a rev-je.
  const stale = site({ rev: 9, updatedAt: 900, alias: 'iksz', updatedBy: 'telefon' });
  for (const m of [mergeSite(stone(), stale), mergeSite(stale, stone())]) {
    assert.equal(isGone(m), true);
    assert.equal(m.alias, 'iksz', 'a fedőnév a frissebb rekordé — a halott rekordon sem számít');
  }
  const [only] = mergeSiteLists([stone()], [stale]);
  assert.equal(isGone(only), true);
});

test('a visszavonás és az új kérés feltámaszt — a sírkő nem erősebb a kérés szabályánál', () => {
  // Aki látta a kérést (egyenlő számláló), és visszavonta: a szigorítás ingyen van.
  const cancelled = site({ deleteLoosens: 1, rev: 4, updatedBy: 'telefon' });
  const m1 = mergeSite(stone(), cancelled);
  assert.equal(isGone(m1), false);
  assert.equal(m1.pendingDeleteAt, null);
  assert.equal(m1.goneLoosens, 1, 'a jel marad — a következő kérés már nagyobb számlálóval jön');
  // Újra kérték, kifizetve: nagyobb számláló, új határidő — él, és vár.
  const again = site({ deleteLoosens: 2, pendingDeleteAt: 90_000, rev: 6 });
  const m2 = mergeSite(stone(), again);
  assert.equal(isGone(m2), false);
  assert.equal(m2.pendingDeleteAt, 90_000);
});

test('a halott rekord kimarad a domain szerinti összevonásból: az újra felvett oldal él', () => {
  const readded = site({ id: 's2', addedAt: 7_000, rev: 1 });
  const m = mergeSiteLists([stone()], [readded]);
  assert.deepEqual(m.map((s) => [s.id, isGone(s)]), [['s2', false], ['s1', true]], 'az élők elöl, a halottak a végén');
  assert.equal(m[0].pendingDeleteAt, null, 'a régi kérés nem viszi magával az újat');
});

test('a sírkövek plafonja: a legkésőbbi határidejűek maradnak, holtversenyben az azonosító', () => {
  const many = Array.from({ length: MAX_GONE_SITES + 3 }, (_, i) =>
    stone({ id: `g${i}`, addedAt: 1_000 + i, pendingDeleteAt: i < 4 ? 1_000 : 5_000 + i }));
  const kept = mergeSiteLists(many, []);
  assert.equal(kept.length, MAX_GONE_SITES);
  assert.deepEqual(many.filter((s) => !kept.some((k) => k.id === s.id)).map((s) => s.id), ['g1', 'g2', 'g3'],
    'a legkorábbi határidejűek esnek ki — a négyből a g0 marad (kódegység szerint előrébb)');
  assert.deepEqual(capGone([stone({ id: 'b' }), stone({ id: 'a' })]).map((s) => s.id), ['a', 'b']);
});

test('előkészítés: az esedékes idegen rekord sírkő lesz — a helyi és a régi nem', () => {
  const now = 6_000;
  const zombie = site({ id: 'z', pendingDeleteAt: 5_000, deleteLoosens: 1 });
  const legacy = site({ id: 'l', pendingDeleteAt: 5_000 });
  const future = site({ id: 'f', pendingDeleteAt: 9_000, deleteLoosens: 1 });
  const mine = site({ id: 'm', pendingDeleteAt: 5_000, deleteLoosens: 1 });
  const out = settleIncoming([zombie, legacy, future, mine], new Set(['m']), now);
  assert.equal(out[0].goneLoosens, 1, 'a fiókban maradt, végigment kérés sírkő lesz');
  assert.equal(out[1], legacy, 'a számláló nélküli nem — azt a fésülés nem tudja visszavonástól megkülönböztetni');
  assert.equal(out[2], future, 'ami itt még nem esedékes, az még vár');
  assert.equal(out[3], mine, 'a helyi rekord sorsát a bíró dönti el');
});

test('a fiókban maradt kifizetett törlés sírkőként nem viszi magával az újra felvett, azonos domainű oldalt', () => {
  const now = 6_000;
  const zombie = site({ id: 'z', addedAt: 1_000, pendingDeleteAt: 5_000, deleteLoosens: 1 });
  const readded = site({ id: 'n', addedAt: 5_500, rev: 1 });
  const merged = mergeSiteLists([readded], settleIncoming([zombie], new Set(['n']), now));
  const split = splitMerged(merged, new Set(['n']), now);
  assert.deepEqual(split.sites.map((s) => [s.id, s.pendingDeleteAt]), [['n', null]]);
  assert.deepEqual(split.gone.map((s) => s.id), ['z']);
  // Előkészítés nélkül a domain szerinti összevonás a régebbi azonosítót
  // tartaná, a kifizetett kéréssel együtt — az újra felvett oldal is törlődne.
  const naive = mergeSiteLists([readded], [zombie]);
  assert.deepEqual(naive.map((s) => [s.id, s.pendingDeleteAt]), [['z', 5_000]]);
});

test('szétosztás: a helyi és a még nem esedékes marad, az esedékes halott sírkő, a régi kimarad', () => {
  const now = 6_000;
  const merged = [
    site({ id: 'alive' }),
    stone({ id: 'local-dead' }),
    stone({ id: 'not-due', pendingDeleteAt: 9_000 }),
    stone({ id: 'dead' }),
    site({ id: 'counted-due', pendingDeleteAt: 5_000, deleteLoosens: 1 }),
    site({ id: 'legacy-due', pendingDeleteAt: 5_000 }),
  ];
  const split = splitMerged(merged, new Set(['alive', 'local-dead']), now);
  assert.deepEqual(split.sites.map((s) => s.id), ['alive', 'local-dead', 'not-due', 'counted-due']);
  assert.deepEqual(split.gone.map((s) => s.id), ['dead']);
});

test('a bíró: a kifizetett törlés végén sírkő marad, a régi kérés után nem; zárlat alatt nincs végrehajtás', () => {
  const st = defaultState();
  const rec = (over: Partial<SiteRec>): SiteRec => ({
    id: 's1', domain: 'x.com', hostnames: ['x.com'], addedAt: 1, pauseUntil: null, pendingDeleteAt: 5_000,
    rev: 4, updatedAt: 10, updatedBy: 'gep', revFp: 'fp', revHosts: ['x.com'], ...over,
  });
  st.sites = [rec({ deleteLoosens: 2 }), rec({ id: 's2', domain: 'y.com', hostnames: ['y.com'] })];
  st.goneSites = [{ ...rec({ deleteLoosens: 1 }), goneLoosens: 1, pendingDeleteAt: 1_000 }];
  assert.equal(tick(st, 6_000), true);
  assert.equal(st.sites.length, 0);
  assert.equal(st.goneSites!.length, 1, 'ugyanannak az azonosítónak egy sírköve van: az újabb');
  const g = st.goneSites![0];
  assert.deepEqual([g.id, g.goneLoosens, g.deleteLoosens, g.pendingDeleteAt, g.revFp, g.revHosts],
    ['s1', 2, 2, 5_000, undefined, undefined], 'a helyi gyorsítótárak nem kerülnek a sírkőre');

  const locked = defaultState();
  locked.sites = [rec({ deleteLoosens: 1 })];
  locked.lockdown = { startedAt: 0, until: 99_000 };
  tick(locked, 6_000);
  assert.equal(locked.sites.length, 1, 'zárlat alatt a kifizetett törlés is visszavonódik');
  assert.equal(locked.sites[0].pendingDeleteAt, null);
  assert.equal(locked.goneSites, undefined);
});

test('a dróton a sírkő jele legfeljebb a törlés számlálója', () => {
  const raw = (over: Record<string, unknown>) => ({
    id: 's1', domain: 'x.com', hostnames: ['x.com'], addedAt: 1, pendingDeleteAt: 5_000, rev: 5, updatedAt: 1, updatedBy: 'a',
    deleteLoosens: 2, ...over,
  });
  const [ok, bigger, noDel, frac] = normalizeIncomingSites([
    raw({ goneLoosens: 2 }), raw({ goneLoosens: 3 }), raw({ goneLoosens: 1, deleteLoosens: undefined }), raw({ goneLoosens: 1.5 }),
  ]);
  assert.equal(ok.goneLoosens, 2);
  assert.equal(bigger.goneLoosens, undefined, 'a nagyobb jel szemét — a fésülés sosem ír ilyet');
  assert.equal(noDel.goneLoosens, undefined, 'számláló nélkül nincs sírkő');
  assert.equal(frac.goneLoosens, undefined);
});

test('az állapotfájl sírkövei: csak tömb, csak halott, a plafonnal', () => {
  const st = defaultState();
  const g = (over: Partial<SiteRec>): SiteRec => ({
    id: 'g', domain: 'x.com', hostnames: ['x.com'], addedAt: 1, pauseUntil: null, pendingDeleteAt: 5_000,
    rev: 3, deleteLoosens: 1, goneLoosens: 1, ...over,
  });
  st.goneSites = [
    g({ id: 'ok' }), g({ id: 'cancelled', pendingDeleteAt: null }), g({ id: 'big', goneLoosens: 2 }),
    g({ id: 'junk', deleteLoosens: 9 }), 'szemét' as unknown as SiteRec,
  ];
  saveState(st);
  assert.deepEqual(loadState().goneSites?.map((x) => x.id), ['ok']);
  (st as unknown as Record<string, unknown>).goneSites = { nem: 'tömb' };
  saveState(st);
  assert.equal(loadState().goneSites, undefined, 'ami nem tömb, az nincs — a bíró nem akad el rajta');
});
