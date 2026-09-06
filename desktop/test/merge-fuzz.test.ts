// Véletlen összefésülések: a két összefésülés (oldal, munkamenet-blob)
// szimmetrikus, idempotens, és három eszköz bármilyen sorrendben ugyanoda jut.
//
// Ez nem a szabályokat teszteli — azokat a merge-hostnames és a
// focus-pack-marks tesztjei —, hanem azt, hogy a szabályok EGYÜTT nem hagynak
// olyan sarkot, ahol a végeredmény a push-sorrendtől függ. Egy ilyen sarok
// nem összeomlás, hanem két gép, ami örökké egymást írja felül. Rögzített
// magú véletlen, hogy egy bukás megismételhető legyen — a generátor a
// merge-random.ts, a Kotlin- és Swift-tükör ugyanazt a sorozatot járja be.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mergeSite, type SyncSite } from '../src/shared/sync/merge';
import { mergeFocus, type SyncFocus } from '../src/shared/sync/focus-merge';
import { DEVICES, randomFocus, randomSite, rng } from './merge-random';

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
    for (const m of [ab, abc]) {
      if (m.run) assert.ok(m.packs.some((p) => p.id === m.run!.packId), `a menet csomagja a listán van, mag ${seed}`);
    }
  }
});

function effectiveMark(f: SyncFocus, id: string): number {
  const own = f.packMarks?.[id] ?? 0;
  return f.run?.packId === id && f.packs.some((p) => p.id === id) ? Math.max(own, f.rev) : own;
}
