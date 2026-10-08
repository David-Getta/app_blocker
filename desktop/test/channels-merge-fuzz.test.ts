import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { isFilterLoosening, type ChannelFilter } from '../src/shared/channels';
import { mergeChannels, type SyncChannels } from '../src/shared/sync/channels-merge';
import { bumpChannelsRevision } from '../src/helper/revisions';
import { defaultState, type HelperState } from '../src/helper/state';

/**
 * Véletlen-teszt a csatorna-szűrők fésülésére.
 *
 * Az ígéret: egy eszköz INGYENES szerkesztése — szigorítás, vagy bármi egy
 * kikapcsolt szűrőn, akárhányszor, akármekkorára felhúzva a számlálóját —
 * semmit nem lazíthat azon, ami a másik eszközön él: bekapcsolt szűrőt nem
 * kapcsol ki, nem visz el, és csatornát sem nyit meg rajta. A fizetett
 * lazítás viszont átmegy. Mellette: a fésülés szimmetrikus, idempotens és
 * elnyelő (a már fésültet újra fésülve ugyanaz jön ki) — ezen múlik, hogy két
 * eszköz nem írja örökké egymást.
 *
 * Az egyetlen kimondott kivétel: két bekapcsolt, egymástól diszjunkt
 * engedélylista egyenlő számlálóval — ott a rövidebb marad, mert üres lista
 * nem lehet (lásd docs/feature-channel-filter.md).
 *
 * A generátor magja rögzített, tehát egy elhasalás visszajátszható.
 */

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const HOSTS = ['a.com', 'b.com', 'c.com', 'd.com'];
const KEYS = ['@1', '@2', '@3', '@4'];

function randomAllow(r: () => number): string[] {
  const out = KEYS.filter(() => r() < 0.5);
  return out.length > 0 ? out : [KEYS[Math.floor(r() * KEYS.length)]];
}

/**
 * Egy véletlen szerkesztés a helyi kapu szabályai szerint (felvétel,
 * módosítás — néha gazdagép-cserével —, törlés). `freeOnly` mellett csak ami
 * ingyen van: ami lazítana, az elmarad.
 */
function randomOp(state: HelperState, r: () => number, freeOnly: boolean, ids: { n: number }): void {
  const list = state.channelFilters ?? [];
  const unused = HOSTS.filter((h) => !list.some((f) => f.host === h));
  const roll = r();
  if (roll < 0.3) {
    if (unused.length === 0) return;
    const host = unused[Math.floor(r() * unused.length)];
    state.channelFilters = [...list, { id: `chf_${ids.n++}`, host, allow: randomAllow(r), enabled: r() < 0.6 }];
    return;
  }
  if (list.length === 0) return;
  const i = Math.floor(r() * list.length);
  const cur = list[i];
  if (roll < 0.45) {
    if (freeOnly && cur.enabled) return;
    // A bekapcsolt szűrő törlése próbatétel: a bíró a teljesítéskor lépteti
    // a régi gazdagép számlálóját — itt ezt utánozzuk.
    if (cur.enabled) paid(state, cur.host);
    state.channelFilters = list.filter((_, j) => j !== i);
    return;
  }
  const host = r() < 0.15 && unused.length > 0 ? unused[Math.floor(r() * unused.length)] : cur.host;
  let allow = r() < 0.5 ? randomAllow(r) : cur.allow.filter(() => r() < 0.7);
  if (allow.length === 0) allow = [cur.allow[0]];
  const next = { host, allow, enabled: r() < 0.6 };
  if (isFilterLoosening(cur, next)) {
    if (freeOnly) return;
    paid(state, cur.host);
  }
  state.channelFilters = list.map((f, j) => (j === i ? { id: cur.id, ...next } : f));
}

/** A bíró könyvelése egy kifizetett lazításnál: a régi gazdagép számlálója nő. */
function paid(state: HelperState, host: string): void {
  state.channelLoosens = { ...(state.channelLoosens ?? {}), [host]: (state.channelLoosens?.[host] ?? 0) + 1 };
}

function blob(s: HelperState, device: string): SyncChannels {
  return {
    filters: s.channelFilters ?? [], rev: s.channelsRev ?? 0, updatedAt: s.channelsUpdatedAt ?? 0,
    updatedBy: s.channelsUpdatedBy ?? device,
    ...(s.channelMarks ? { marks: s.channelMarks } : {}),
    ...(s.channelLoosens ? { loosens: s.channelLoosens } : {}),
  };
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

/** A tartalom, amin a szinkron múlik: a szűrők sorrendben (a lista halmazként), a jelek, a számlálók. */
function content(c: SyncChannels): unknown {
  return {
    filters: c.filters.map((f) => ({ id: f.id, host: f.host, allow: [...f.allow].sort(), enabled: f.enabled })),
    marks: c.marks ?? {},
    loosens: c.loosens ?? {},
  };
}

/** Egy közös ős és két leszármazott: X a `freeOnly` szerint szerkeszt, Y bármit. */
function scenario(seed: number, xFreeOnly: boolean) {
  const r = rng(seed);
  const ids = { n: 0 };
  const base = defaultState();
  let now = 1000;
  bumpChannelsRevision(base, 'o', now);
  for (let k = 0; k < 6; k++) {
    randomOp(base, r, false, ids);
    bumpChannelsRevision(base, 'o', ++now);
  }
  // Mindkét eszköz ugyanazt az őst látta — utána külön utakon jártak.
  const x = clone(base);
  const y = clone(base);
  const xn = 1 + Math.floor(r() * 12);
  for (let k = 0; k < xn; k++) {
    randomOp(x, r, xFreeOnly, ids);
    bumpChannelsRevision(x, 'x', ++now);
  }
  const yn = Math.floor(r() * 5);
  for (let k = 0; k < yn; k++) {
    randomOp(y, r, false, ids);
    bumpChannelsRevision(y, 'y', ++now);
  }
  return { bx: blob(x, 'x'), by: blob(y, 'y') };
}

function find(c: SyncChannels, host: string): ChannelFilter | undefined {
  return c.filters.find((f) => f.host === host);
}

test('ingyenes szerkesztés nem lazít a másik eszközön; a fizetett lazítás átmegy', () => {
  for (let seed = 1; seed <= 3000; seed++) {
    const ctx = `mag ${seed}`;
    const { bx, by } = scenario(seed, true);
    const m = mergeChannels(bx, by);
    assert.deepEqual(content(mergeChannels(by, bx)), content(m), `${ctx}: a fésülés nem szimmetrikus`);
    for (const fy of by.filters) {
      if (!fy.enabled) continue;
      const fm = find(m, fy.host);
      assert.ok(fm && fm.enabled, `${ctx}: a bekapcsolt szűrő eltűnt vagy kikapcsolt: ${fy.host}`);
      const fx = find(bx, fy.host);
      const corner = !!fx && fx.enabled && !fx.allow.some((k) => fy.allow.includes(k))
        && (bx.loosens?.[fy.host] ?? 0) === (by.loosens?.[fy.host] ?? 0);
      if (!corner) {
        assert.ok(fm.allow.every((k) => fy.allow.includes(k)), `${ctx}: csatorna nyílt meg ingyen: ${fy.host}`);
      }
    }
    // A fizetett lazítás átmegy: ahol Y-nak több a számlálója, ott az övé, egészében.
    for (const h of HOSTS) {
      if ((by.loosens?.[h] ?? 0) <= (bx.loosens?.[h] ?? 0)) continue;
      const fy = find(by, h);
      const fm = find(m, h);
      assert.equal(!!fm, !!fy, `${ctx}: a fizetett levétel nem ért át: ${h}`);
      if (fy && fm) {
        assert.equal(fm.enabled, fy.enabled, `${ctx}: a fizetett kikapcsolás nem ért át: ${h}`);
        assert.deepEqual([...fm.allow].sort(), [...fy.allow].sort(), `${ctx}: a fizetett bővítés nem ért át: ${h}`);
      }
    }
    // Az ingyenes oldal számlálója nem nőhetett.
    for (const h of HOSTS) {
      assert.ok((bx.loosens?.[h] ?? 0) <= (by.loosens?.[h] ?? 0), `${ctx}: ingyenes szerkesztés számlálót léptetett: ${h}`);
    }
  }
});

test('a fésülés idempotens és elnyelő — a fésültet újra fésülve ugyanaz jön ki', () => {
  for (let seed = 1; seed <= 3000; seed++) {
    const ctx = `mag ${seed}`;
    const { bx, by } = scenario(seed, false);
    const m = mergeChannels(bx, by);
    assert.deepEqual(content(mergeChannels(by, bx)), content(m), `${ctx}: a fésülés nem szimmetrikus`);
    assert.deepEqual(content(mergeChannels(m, m)), content(m), `${ctx}: nem idempotens`);
    assert.deepEqual(content(mergeChannels(bx, m)), content(m), `${ctx}: nem elnyelő (helyi)`);
    assert.deepEqual(content(mergeChannels(m, by)), content(m), `${ctx}: nem elnyelő (bejövő)`);
    assert.ok(m.rev >= Math.max(bx.rev, by.rev), `${ctx}: a fésült rev visszalépett`);
    // Oldalanként egy szűrő, egyedi azonosítóval.
    assert.equal(new Set(m.filters.map((f) => f.host)).size, m.filters.length, `${ctx}: dupla oldal`);
    assert.equal(new Set(m.filters.map((f) => f.id)).size, m.filters.length, `${ctx}: dupla azonosító`);
  }
});
