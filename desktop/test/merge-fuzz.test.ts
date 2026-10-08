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
import { DEVICES, FOCUS_MERGE_NOW, randomFocus, randomSite, rng, siteConformanceKey } from './merge-random';
import { windowKey } from '../src/shared/lockdown';
import { keywordMarksKey, keywordsKey } from '../src/shared/keywords';
import { partnerKey } from '../src/shared/partner';

/**
 * A rekord EGÉSZE: a nevek és a jeleik, a részleges szabályok és a jeleik, a
 * menetrend, a keret, az adag, a törlésre várás, a számlálók, a fedőnév — és
 * a szünet is. Mezőnként (a neveknél és a szabályoknál elemenként) fésülődik
 * minden, és mindegyik szabály sorrendfüggetlen; ha egy is nem az, két eszköz
 * örökké egymást írná.
 */
function siteKey(s: SyncSite): string {
  return `${siteConformanceKey(s)} pause=${s.pauseUntil ?? '-'}`;
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

/**
 * A csomagok HALMAZA, a jelek, a rev, a napló és a többi jeles mező — és a
 * csomagok VÁLTOZATA is, kivéve azét, amin valamelyik bemenet menete fut.
 *
 * A FUTÓ MENET ÉS A CSOMAGJA itt külön kérdés. A menet egyetlen hely: két
 * egyidejű menetből a szigorúbb marad, a másik kiesik. Ha a kiesett menetet
 * leváltó menetet egy harmadik eszköz sírköve (naplósora) zárja le, akkor az
 * a sorrend, amelyikben a kiesett menet a lezárás UTÁN találkozik a
 * leváltóval, megtartja — amelyikben előtte, az nem. Ugyanígy a csomagja: a
 * futó menet csomagja nem törölhető (`runPack`), de a kiesett menetéé már
 * igen. Mindkét kimenet biztonságos — egyik sem lazít olyat, amiért senki nem
 * fizetett —, és a szinkron a következő körökben egy állapotra áll be. Ezt a
 * doksi kimondja; a menetet ezért külön tulajdonságok mérik (`runSafety`).
 */
function focusKey(f: SyncFocus, runIds: Set<string>, withRun: boolean): string {
  return JSON.stringify([
    [...f.packs].filter((p) => withRun || !runIds.has(p.id))
      .sort((x, y) => (x.id < y.id ? -1 : 1)).map((p) => (runIds.has(p.id)
        ? [p.id]
        : [p.id, p.name, [...p.allowSites].sort(), [...p.allowApps].sort(), p.defaultMinutes, p.recurrence ?? null])),
    f.packMarks ? Object.entries(f.packMarks).sort() : null,
    withRun ? f.run : null, f.rev,
    // A zárlat és az ablakok a jelükkel — tartalom szerint, rendezve.
    f.lockdown ?? null,
    (f.lockdownWindows ?? []).map(windowKey).sort(),
    f.lockdownWindowsRev ?? null,
    // A rejtés, a kulcsszavak és a megbízott a jelükkel — mint a Kotlin és a
    // Swift fuzz kulcsában: ami a fésülésben dől el, az itt is mérve van.
    f.hideSiteList === true, f.hideSiteListRev ?? null,
    keywordsKey(f.keywords ?? []), f.keywordsRev ?? null, keywordMarksKey(f.keywordMarks),
    partnerKey(f.partner), f.partnerRev ?? null,
    (f.partnerCo ?? []).map(partnerKey), (f.partnersGone ?? []).map((g) => `${g.id}@${g.at}`),
    // A napló a fésült sorrendben: egyesítés teljes rendezéssel — sorrendfüggetlen.
    f.log.map((e) => [e.packId, e.startedAt, e.endedAt, e.plannedEndsAt, e.stopped, e.window === true, e.cuts ?? 0, e.origin ?? null]),
  ]);
}

/**
 * A futó menet biztonsága egy fésülés után: a menet a bemenetek egyikéé (nem
 * születik új), a fésült napló nem zárja le, és a csomagja a listán van.
 */
function runSafety(m: SyncFocus, inputs: SyncFocus[], seed: number): void {
  if (!m.run) return;
  assert.ok(inputs.some((f) => JSON.stringify(f.run) === JSON.stringify(m.run)), `a menet egy bemeneté, mag ${seed}`);
  assert.ok(m.packs.some((p) => p.id === m.run!.packId), `a menet csomagja a listán van, mag ${seed}`);
  const again = mergeFocus(m, { ...m, run: null }, FOCUS_MERGE_NOW);
  assert.deepEqual(again.run, m.run, `a fésült napló nem zárja le a fésült menetet, mag ${seed}`);
}

/** Sorrendtől független-e a menet: nincs rövidítés, eltolás, és a menetre szóló sírkő. */
function plainRuns(fs: SyncFocus[]): boolean {
  return fs.every((f) => !f.run || (!f.run.cuts && f.run.origin === undefined))
    && !fs.some((f) => f.log.some((e) => fs.some((g) => g.run && g.run.packId === e.packId
      && (g.run.origin ?? g.run.startedAt) === (e.origin ?? e.startedAt))));
}

test('munkamenet-blob: a csomagok halmaza és a jelek sorrendtől függetlenek', () => {
  const now = FOCUS_MERGE_NOW;
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed);
    const [a, b, c] = DEVICES.map((d) => randomFocus(r, d));
    const runIds = new Set([a, b, c].flatMap((f) => (f.run ? [f.run.packId] : [])));
    const full = (f: SyncFocus) => focusKey(f, runIds, true);
    const noRun = (f: SyncFocus) => focusKey(f, runIds, false);
    const ab = mergeFocus(a, b, now);
    assert.equal(full(ab), full(mergeFocus(b, a, now)), `szimmetria, mag ${seed}`);
    assert.equal(full(mergeFocus(ab, ab, now)), full(ab), `idempotens, mag ${seed}`);
    const abc = mergeFocus(ab, c, now);
    const bca = mergeFocus(mergeFocus(b, c, now), a, now);
    const cab = mergeFocus(mergeFocus(c, a, now), b, now);
    assert.equal(noRun(abc), noRun(bca), `három eszköz (bca), mag ${seed}`);
    assert.equal(noRun(abc), noRun(cab), `három eszköz (cab), mag ${seed}`);
    // Ahol a menetre nincs sírkő, rövidítés és eltolás, ott a menet is
    // sorrendtől független: a szigorúbb marad, mindig ugyanaz.
    if (plainRuns([a, b, c])) {
      assert.deepEqual(bca.run, abc.run, `három eszköz, a menet (bca), mag ${seed}`);
      assert.deepEqual(cab.run, abc.run, `három eszköz, a menet (cab), mag ${seed}`);
    }
    // A jeles csomag a nagyobb jel változatában marad: ha az egyik oldalon
    // ablakos csomag áll a nagyobb jellel, az ablak az eredményben is ott van.
    // A futó menet csomagja is: a mezői a jel szerinti győztesé, csak a
    // fehérlistája metszet (`runPack`) — az ablaka marad.
    for (const p of a.packs) {
      const ma = a.packMarks?.[p.id] ?? 0;
      const mb = b.packMarks?.[p.id] ?? 0;
      if (ma > mb && p.recurrence) {
        assert.ok(ab.packs.find((x) => x.id === p.id)?.recurrence, `a nagyobb jel ablaka marad: ${p.id}, mag ${seed}`);
      }
    }
    for (const m of [ab, abc, bca, cab]) runSafety(m, [a, b, c], seed);
  }
});
