// Véletlen összefésülések: a két összefésülés (oldal, munkamenet-blob)
// szimmetrikus, idempotens, és három eszköz bármilyen sorrendben ugyanoda jut.
//
// Ez nem a szabályokat teszteli — azokat a merge-hostnames és a
// focus-pack-marks tesztjei —, hanem azt, hogy a szabályok EGYÜTT nem hagynak
// olyan sarkot, ahol a végeredmény a push-sorrendtől függ. Egy ilyen sarok
// nem összeomlás, hanem két gép, ami örökké egymást írja felül. Rögzített
// magú véletlen, hogy egy bukás megismételhető legyen.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mergeSite, type SyncSite } from '../src/shared/sync/merge';
import { emptyFocus, mergeFocus, type SyncFocus } from '../src/shared/sync/focus-merge';
import type { FocusPack } from '../src/shared/focus';
import type { Band } from '../src/shared/schedule';

/** Determinisztikus véletlen (LCG): a mag a hibaüzenetben áll, a bukás megismételhető. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'yt.be'];
const DEVICES = ['gep-a', 'gep-b', 'telefon'];

function randomSite(r: () => number, device: string): SyncSite {
  const hostnames = HOSTS.filter((h, i) => i === 0 || r() < 0.5);
  const marks: Record<string, number> = {};
  for (const h of HOSTS.slice(1)) if (r() < 0.4) marks[h] = 1 + Math.floor(r() * 5);
  return {
    id: 'site_1', domain: 'youtube.com', hostnames, addedAt: 1_000,
    ...(Object.keys(marks).length ? { hostnameMarks: marks } : {}),
    pauseUntil: null, pendingDeleteAt: r() < 0.15 ? 5_000 + Math.floor(r() * 3) : null,
    dailyLimitSeconds: r() < 0.4 ? 600 * (1 + Math.floor(r() * 3)) : undefined,
    alias: r() < 0.3 ? `n${Math.floor(r() * 3)}` : undefined,
    rev: 1 + Math.floor(r() * 5), updatedAt: 100 + Math.floor(r() * 5), updatedBy: device,
  };
}

/**
 * A NEVEK és a JELEIK — ezek fésülődnek nevenként. A rekord többi mezője
 * (keret, fedőnév) a rekord-szintű nyertesé, és ott a törlésre várás
 * továbbvitele (`carryPendingDelete`) egy olyan köztes rekordot ad, ami
 * egyik eszközön sem létezett: három eszköznél a nyertes a sorrendtől is
 * függhet. Ez régi adósság, nem a nevek szabályáé — itt nem ezt mérjük.
 */
function siteKey(s: SyncSite): string {
  return JSON.stringify([
    [...s.hostnames].sort(), s.hostnameMarks ? Object.entries(s.hostnameMarks).sort() : null, s.rev,
  ]);
}

test('oldal: szimmetrikus, idempotens, és három eszköz bármilyen sorrendben ugyanoda jut', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed);
    const [a, b, c] = DEVICES.map((d) => randomSite(r, d));
    const ab = mergeSite(a, b);
    assert.equal(siteKey(ab), siteKey(mergeSite(b, a)), `szimmetria, mag ${seed}`);
    assert.equal(siteKey(mergeSite(ab, ab)), siteKey(ab), `idempotens, mag ${seed}`);
    const abc = mergeSite(ab, c);
    const bca = mergeSite(mergeSite(b, c), a);
    const cab = mergeSite(mergeSite(c, a), b);
    assert.equal(siteKey(abc), siteKey(bca), `három eszköz, más sorrend (bca), mag ${seed}`);
    assert.equal(siteKey(abc), siteKey(cab), `három eszköz, más sorrend (cab), mag ${seed}`);
    // Lazítás jel nélkül nincs: ami mindkét oldalon benne volt, és egyiknek
    // sincs rá jele, az az eredményben is benne van.
    for (const h of a.hostnames) {
      if (b.hostnames.includes(h) && !(a.hostnameMarks?.[h]) && !(b.hostnameMarks?.[h])) {
        assert.ok(ab.hostnames.includes(h), `jel nélküli közös név nem tűnhet el: ${h}, mag ${seed}`);
      }
    }
  }
});

const PACK_IDS = ['p1', 'p2', 'p3', 'p4'];
const WIN: Band = { days: [1, 2, 3, 4, 5], startMin: 540, endMin: 720 };

function randomFocus(r: () => number, device: string): SyncFocus {
  const packs: FocusPack[] = PACK_IDS.filter(() => r() < 0.6).map((id) => ({
    id, name: `csomag ${id} v${Math.floor(r() * 3)}`, allowSites: ['quizlet.com'], allowApps: [],
    defaultMinutes: 50, ...(r() < 0.4 ? { recurrence: WIN } : {}),
  }));
  const marks: Record<string, number> = {};
  for (const id of PACK_IDS) if (r() < 0.4) marks[id] = 1 + Math.floor(r() * 5);
  const rev = 1 + Math.floor(r() * 5);
  // A jel sosem nagyobb a blob rev-jénél (a bemenet is így tisztít): a
  // csomag nélküli menet lehetetlensége erre épül.
  for (const id of Object.keys(marks)) marks[id] = Math.min(marks[id], rev);
  // A menet lejárata és kezdése is csak pár értéket vesz fel: legyen sok
  // döntetlen, mert éppen a döntetlen-lánc az, ami sorrendfüggő tud lenni.
  const run = r() < 0.4 && packs.length > 0
    ? {
        packId: packs[Math.floor(r() * packs.length)].id,
        startedAt: 10 + 60_000 * Math.floor(r() * 2),
        endsAt: 610_000 + 60_000 * Math.floor(r() * 2),
      }
    : null;
  return {
    ...emptyFocus(device), packs, ...(Object.keys(marks).length ? { packMarks: marks } : {}),
    run, rev, updatedAt: 100 + Math.floor(r() * 5), updatedBy: device,
  };
}

function focusKey(f: SyncFocus): string {
  return JSON.stringify([
    [...f.packs].sort((x, y) => (x.id < y.id ? -1 : 1)).map((p) => [p.id, p.name, p.recurrence ?? null]),
    f.packMarks ? Object.entries(f.packMarks).sort() : null,
    f.run, f.rev,
  ]);
}

test('munkamenet-blob: a csomagok halmaza és a jelek sorrendtől függetlenek', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed);
    const [a, b, c] = DEVICES.map((d) => randomFocus(r, d));
    const ab = mergeFocus(a, b);
    assert.equal(focusKey(ab), focusKey(mergeFocus(b, a)), `szimmetria, mag ${seed}`);
    assert.equal(focusKey(mergeFocus(ab, ab)), focusKey(ab), `idempotens, mag ${seed}`);
    const abc = mergeFocus(ab, c);
    assert.equal(focusKey(abc), focusKey(mergeFocus(mergeFocus(b, c), a)), `három eszköz (bca), mag ${seed}`);
    assert.equal(focusKey(abc), focusKey(mergeFocus(mergeFocus(c, a), b)), `három eszköz (cab), mag ${seed}`);
    // A jeles csomag a nagyobb jel változatában marad: ha az egyik oldalon
    // ablakos csomag áll a nagyobb jellel, az ablak az eredményben is ott van.
    // A futó menet csomagja a blob rev-jével számít jeleltnek (hatásos jel).
    for (const p of a.packs) {
      const ma = effectiveMark(a, p.id);
      const mb = effectiveMark(b, p.id);
      if (ma > mb && p.recurrence) {
        assert.ok(ab.packs.find((x) => x.id === p.id)?.recurrence, `a nagyobb jel ablaka marad: ${p.id}, mag ${seed}`);
      }
    }
    // Csomag nélküli menet nem születik: a menet csomagja mindig a listán van.
    for (const m of [ab, mergeFocus(ab, c)]) {
      if (m.run) assert.ok(m.packs.some((p) => p.id === m.run!.packId), `a menet csomagja a listán van, mag ${seed}`);
    }
  }
});

function effectiveMark(f: SyncFocus, id: string): number {
  const own = f.packMarks?.[id] ?? 0;
  return f.run?.packId === id && f.packs.some((p) => p.id === id) ? Math.max(own, f.rev) : own;
}
