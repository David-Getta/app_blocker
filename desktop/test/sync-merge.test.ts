// Az összefésülés nem oldhat fel semmit.
//
// Ez a szinkron egyetlen igazán veszélyes pontja: ha a fésülés bármikor a
// lazább oldal felé dől, akkor két eszközzel és egy jól időzített művelettel
// próbatétel nélkül lehet feloldani. A tesztek nagy része ezért nem azt nézi,
// hogy „jó-e az eredmény”, hanem hogy NEM LETT-E LAZÁBB.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  joinBurst, joinLimit, joinSchedule, mergeSite, mergeSiteLists, type SyncSite,
} from '../src/shared/sync/merge';
import type { Schedule } from '../src/shared/schedule';

const WORK: Schedule = {
  mode: 'scheduled_block',
  bands: [{ days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 17 * 60 }],
};
const EVENING: Schedule = {
  mode: 'scheduled_block',
  bands: [{ days: [0, 1, 2, 3, 4, 5, 6], startMin: 22 * 60, endMin: 6 * 60 }],
};

function site(over: Partial<SyncSite> = {}): SyncSite {
  return {
    id: 'site_1', domain: 'youtube.com', hostnames: ['youtube.com'],
    addedAt: 1_000, pauseUntil: null, pendingDeleteAt: null,
    rev: 1, updatedAt: 5_000, updatedBy: 'gep-a',
    ...over,
  };
}

test('a menetrendek szigorúbb alakja az unió — szerkezet szerint, időzónától függetlenül', () => {
  // Ha az összevetés a gép helyi idejét használná, két eszköz két különböző
  // eredményre jutna, és a szinkron sosem állna meg.
  const both = joinSchedule(WORK, EVENING)!;
  assert.equal(both.mode, 'scheduled_block');
  assert.equal(blocked(both, 1, 10 * 60), true, 'hétfő délelőtt: a munkaidő tilt');
  assert.equal(blocked(both, 3, 23 * 60), true, 'szerda este: az esti sáv tilt');
  assert.equal(blocked(both, 6, 12 * 60), false, 'szombat délben egyik sem');
  assert.deepEqual(joinSchedule(EVENING, WORK), both, 'a sorrend nem számít');
  assert.equal(joinSchedule(WORK, undefined), undefined, 'a menetrend nélküli (mindig tilt) lefed mindent');
  assert.equal(joinSchedule(WORK, WORK), WORK, 'ugyanaz marad, nem íródik újra');
  const wider: Schedule = { mode: 'scheduled_block', bands: [{ days: [1, 2, 3, 4, 5], startMin: 8 * 60, endMin: 18 * 60 }] };
  assert.equal(joinSchedule(WORK, wider), wider, 'ha az egyik lefedi a másikat, az marad');
  // A megengedő mód a komplemens: ami ott nincs megengedve, az tilt.
  const allow: Schedule = { mode: 'scheduled_allow', bands: WORK.bands };
  assert.deepEqual(joinSchedule(allow, WORK), { mode: 'always', bands: [] },
    'a munkaidőn kívül tilt + munkaidőben tilt = mindig');
});

function blocked(s: Schedule, day: number, minute: number): boolean {
  return s.bands.some((b) => b.days.includes(day as never) && minute >= b.startMin && minute < b.endMin)
    === (s.mode === 'scheduled_block');
}

test('egyenlő számlálónál mezőnként a szigorúbb — nem az egyik rekord egészében', () => {
  // A régi szabály a rekordokat rendezte (előbb a menetrend, aztán a keret):
  // a menetrendben szigorúbb, keretben lazább rekord egészében nyert, és a
  // máshol lecsökkentett keret ingyen visszanőtt.
  const a = site({ rev: 4, schedule: WORK, dailyLimitSeconds: 3600 });
  const b = site({ rev: 4, dailyLimitSeconds: 600, schedule: EVENING, updatedBy: 'gep-b' });
  for (const m of [mergeSite(a, b), mergeSite(b, a)]) {
    assert.equal(m.dailyLimitSeconds, 600, 'a kisebb keret');
    assert.deepEqual(m.schedule, joinSchedule(WORK, EVENING), 'a két menetrend uniója');
  }
  const burst = mergeSite(site({ burstSeconds: 300, cooldownSeconds: 600 }),
    site({ burstSeconds: 600, cooldownSeconds: 1200, updatedBy: 'gep-b' }));
  assert.deepEqual([burst.burstSeconds, burst.cooldownSeconds], [300, 1200], 'a kisebb adag és a hosszabb szünet');
});

test('lazítás csak a kifizetett számlálóval megy át — a nagyobb rev önmagában semmit', () => {
  const strict = site({ rev: 4, dailyLimitSeconds: 600 });
  const earned = site({ rev: 5, dailyLimitSeconds: 3600, limitLoosens: 1, updatedBy: 'gep-b' });
  assert.equal(mergeSite(strict, earned).dailyLimitSeconds, 3600, 'a próbatétel megvolt');
  assert.equal(mergeSite(earned, strict).dailyLimitSeconds, 3600);
  // A TRÜKK: egy elavult eszköz ingyenes szerkesztésekkel felhúzza a rev-et.
  const stale = site({ rev: 99, dailyLimitSeconds: 7200, updatedAt: 99_999, updatedBy: 'gep-b' });
  assert.equal(mergeSite(strict, stale).dailyLimitSeconds, 600, 'régi, lazább rekord nem lazít');
  assert.equal(mergeSite(stale, strict).dailyLimitSeconds, 600);
  // A számláló mezőnként: a keret lazítása nem viszi el a máshol felvett menetrendet.
  const scheduled = site({ rev: 6, schedule: WORK, dailyLimitSeconds: 600 });
  const earnedEvening = site({ rev: 5, schedule: EVENING, dailyLimitSeconds: 3600, limitLoosens: 1, updatedBy: 'gep-b' });
  const m = mergeSite(scheduled, earnedEvening);
  assert.equal(m.dailyLimitSeconds, 3600);
  assert.deepEqual(m.schedule, joinSchedule(WORK, EVENING), 'a menetrend a saját számlálója szerint dől el');
});

test('a fedőnév és az indok a frissebb rekordé — azok nem tiltanak', () => {
  const older = site({ rev: 3, alias: 'Régi', reason: 'régi indok' });
  const newer = site({ rev: 5, alias: 'Új', reason: 'új indok', updatedBy: 'gep-b' });
  for (const m of [mergeSite(older, newer), mergeSite(newer, older)]) {
    assert.equal(m.alias, 'Új');
    assert.equal(m.reason, 'új indok');
    assert.equal(m.rev, 5);
  }
});

test('a pause never travels between devices as a loosening', () => {
  const now = 1_700_000_000_000;
  const blocked = site({ rev: 7 });
  const paused = site({ rev: 7, pauseUntil: now + 30 * 60_000, updatedBy: 'gep-b' });
  assert.equal(mergeSite(blocked, paused).pauseUntil, null, 'a blokkolt marad');
});

test('a törlésre várás nem tűnik el csendben — a visszavonás csak az ismerőjétől jön', () => {
  const deleting = site({ rev: 3, pendingDeleteAt: 9_000_000, deleteLoosens: 1 });
  // A másik eszköz nem is tudott a kérésről — a nagyobb rev-je ellenére sem dobja el.
  const unaware = site({ rev: 9, alias: 'A videós', updatedBy: 'gep-b' });
  const m = mergeSite(deleting, unaware);
  assert.equal(m.alias, 'A videós', 'a frissebb rekord fedőneve jön');
  assert.equal(m.pendingDeleteAt, 9_000_000, 'a kifizetett kérés megmarad');
  // Aki látta a kérést (a számlálója ugyanannyi) és visszavonta: az ingyen van, és átmegy.
  const cancelled = site({ rev: 4, deleteLoosens: 1, updatedBy: 'gep-b' });
  assert.equal(mergeSite(deleting, cancelled).pendingDeleteAt, null);
  assert.equal(mergeSite(cancelled, deleting).pendingDeleteAt, null);
});

test('két független törlés-kérés: egyenlő számlálónál a későbbi határidő', () => {
  const a = site({ rev: 3, pendingDeleteAt: 9_000_000, deleteLoosens: 1 });
  const b = site({ rev: 4, pendingDeleteAt: 8_000_000, deleteLoosens: 1, updatedBy: 'gep-b' });
  assert.equal(mergeSite(a, b).pendingDeleteAt, 9_000_000);
  assert.equal(mergeSite(b, a).pendingDeleteAt, 9_000_000);
  // Az újra kért (két kérés) nyer — az övé a frissebb kifizetett döntés.
  const again = site({ rev: 6, pendingDeleteAt: 7_000_000, deleteLoosens: 2 });
  assert.equal(mergeSite(a, again).pendingDeleteAt, 7_000_000);
});

test('the merge is symmetric and settles on one answer', () => {
  const a = site({ rev: 4, schedule: WORK, updatedAt: 10, updatedBy: 'gep-a' });
  const b = site({ rev: 4, schedule: EVENING, updatedAt: 10, updatedBy: 'gep-b' });
  const ab = mergeSite(a, b);
  const ba = mergeSite(b, a);
  assert.deepEqual(ab, ba, 'mindkét eszköz ugyanazt kapja');
  assert.deepEqual(ab.schedule, joinSchedule(WORK, EVENING), 'mindkettő tiltása marad');
  // És stabil: az eredményt visszafésülve nem mozdul.
  assert.deepEqual(mergeSite(ab, a), ab);
  assert.deepEqual(mergeSite(ab, b), ab);
});

test('signing in unions the lists instead of replacing them', () => {
  const local = [site({ id: 'a', domain: 'youtube.com' })];
  const remote = [site({ id: 'b', domain: 'reddit.com', addedAt: 2_000 })];
  const m = mergeSiteLists(local, remote);
  assert.deepEqual(m.map((s) => s.domain), ['youtube.com', 'reddit.com']);

  // Egy ÜRES fiókkal belépve sem tűnhet el semmi — különben a kijelentkezés
  // és a visszalépés lenne a legolcsóbb feloldás.
  assert.deepEqual(mergeSiteLists(local, []).map((s) => s.domain), ['youtube.com']);
  assert.deepEqual(mergeSiteLists([], remote).map((s) => s.domain), ['reddit.com']);
});

test('the same domain added on two devices becomes one record', () => {
  const a = site({ id: 'a', domain: 'youtube.com', addedAt: 1_000, hostnames: ['youtube.com'] });
  const b = site({
    id: 'b', domain: 'youtube.com', addedAt: 2_000, updatedBy: 'gep-b',
    hostnames: ['youtube.com', 'youtu.be', 'm.youtube.com'],
  });
  const m = mergeSiteLists([a], [b]);
  assert.equal(m.length, 1, 'két sor ugyanarról az oldalról félrevezető lenne');
  assert.equal(m[0].id, 'b', 'az újabban felvett azonosító marad — a régi törlés sírköve így nem viheti el');
  assert.equal(m[0].addedAt, 2_000, 'a felvétel ideje is az övé: a következő összevonás ebből tudja, melyik az újabb');
  assert.deepEqual(m[0].hostnames, ['m.youtube.com', 'youtu.be', 'youtube.com'],
    'a hosztnevek EGYESÜLNEK: az egyesítés a szigorúbb');
});

test('merging is idempotent and order-independent across a list', () => {
  const a = [site({ id: 'a', rev: 2, dailyLimitSeconds: 600 })];
  const b = [site({ id: 'a', rev: 2, dailyLimitSeconds: 1200, updatedBy: 'gep-b' })];
  const once = mergeSiteLists(a, b);
  assert.deepEqual(mergeSiteLists(once, b), once, 'újra lefuttatva nem mozdul');
  assert.deepEqual(mergeSiteLists(b, a), once, 'a sorrend nem számít');
});

test('a keret és az adag szigorúbb alakja', () => {
  assert.equal(joinLimit(600, 3600), 600);
  assert.equal(joinLimit(undefined, 3600), 3600, 'a keret nélküli a leglazább');
  assert.equal(joinLimit(undefined, undefined), undefined);
  assert.deepEqual(joinBurst({ burstSeconds: 300, cooldownSeconds: 900 }, {}), { burstSeconds: 300, cooldownSeconds: 900 });
  assert.deepEqual(joinBurst({ burstSeconds: 300, cooldownSeconds: 600 }, { burstSeconds: 200, cooldownSeconds: 900 }),
    { burstSeconds: 200, cooldownSeconds: 900 }, 'mindkettő szigorúbbja');
});

// ------------------------------------------------------------ véletlen-teszt

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const POOL: (Schedule | undefined)[] = [
  WORK, EVENING, undefined,
  { mode: 'scheduled_allow', bands: [{ days: [0, 6], startMin: 600, endMin: 720 }] },
  { mode: 'scheduled_block', bands: [{ days: [2, 4], startMin: 0, endMin: 1440 }] },
];

/** A heti rács egy menetrendre — a teszt saját, a magtól független mércéje. */
function gridOf(s: Schedule | undefined): boolean[] {
  const out: boolean[] = [];
  for (let d = 0; d < 7; d++) {
    for (let m = 0; m < 1440; m += 15) {
      if (!s || s.mode === 'always') { out.push(true); continue; }
      const prev = (d + 6) % 7;
      const inBand = s.bands.some((b) => (b.endMin > b.startMin
        ? b.days.includes(d as never) && m >= b.startMin && m < b.endMin
        : (b.days.includes(d as never) && m >= b.startMin) || (b.days.includes(prev as never) && m < b.endMin)));
      out.push(s.mode === 'scheduled_block' ? inBand : !inBand);
    }
  }
  return out;
}

/** Ingyenes szigorítás egy mezőn — a kapu szabályai szerint, számláló nélkül. */
function freeTighten(r: () => number, s: SyncSite): SyncSite {
  const roll = r();
  if (roll < 0.25) return { ...s, dailyLimitSeconds: Math.max(60, Math.min(s.dailyLimitSeconds ?? 7200, 600 * (1 + Math.floor(r() * 3))) - 60) };
  if (roll < 0.5) return { ...s, schedule: joinSchedule(s.schedule, POOL[Math.floor(r() * POOL.length)]) };
  if (roll < 0.75) {
    const cur = s.burstSeconds !== undefined ? [s.burstSeconds, s.cooldownSeconds ?? 300] : [1800, 300];
    return { ...s, burstSeconds: Math.max(60, cur[0] - 300), cooldownSeconds: cur[1] + 300 };
  }
  return { ...s, pendingDeleteAt: null };
}

/** Bármilyen szerkesztés — a lazítás próbatétellel, tehát a számlálójával. */
function anyEdit(r: () => number, s: SyncSite): SyncSite {
  if (r() < 0.5) return freeTighten(r, s);
  const roll = r();
  if (roll < 0.25) return { ...s, dailyLimitSeconds: r() < 0.3 ? undefined : 3600, limitLoosens: (s.limitLoosens ?? 0) + 1 };
  if (roll < 0.5) return { ...s, schedule: POOL[Math.floor(r() * POOL.length)] ?? WORK, scheduleLoosens: (s.scheduleLoosens ?? 0) + 1 };
  if (roll < 0.75) return { ...s, burstSeconds: undefined, cooldownSeconds: undefined, burstLoosens: (s.burstLoosens ?? 0) + 1 };
  return { ...s, pendingDeleteAt: 9_000_000, deleteLoosens: (s.deleteLoosens ?? 0) + 1 };
}

test('VÉLETLEN: egy eszköz ingyenes szerkesztése semmit nem lazít a másikén; a fizetett lazítás átmegy', () => {
  for (let seed = 1; seed <= 2000; seed++) {
    const r = rng(seed);
    const ctx = `mag ${seed}`;
    let base = site({ rev: 1 + Math.floor(r() * 3), dailyLimitSeconds: r() < 0.5 ? 1800 : undefined, schedule: POOL[Math.floor(r() * POOL.length)] });
    for (let k = 0; k < 3; k++) base = anyEdit(r, base);
    // X csak ingyen szerkeszt — akárhányszor, a rev-et akármeddig felhúzva; Y bármit.
    let x = { ...base, updatedBy: 'x' };
    for (let k = 0, n = 1 + Math.floor(r() * 8); k < n; k++) x = { ...freeTighten(r, x), rev: x.rev + 1 };
    let y = { ...base, updatedBy: 'y' };
    for (let k = 0, n = Math.floor(r() * 4); k < n; k++) y = { ...anyEdit(r, y), rev: y.rev + 1 };
    const m = mergeSite(x, y);
    assert.deepEqual(mergeSite(y, x), m, `${ctx}: a fésülés nem szimmetrikus`);
    assert.deepEqual(mergeSite(m, m), m, `${ctx}: nem idempotens`);
    const paid = (k: 'deleteLoosens' | 'scheduleLoosens' | 'limitLoosens' | 'burstLoosens') => (y[k] ?? 0) > (x[k] ?? 0);
    // A keret: kifizetett lazításnál Y-é; különben legfeljebb akkora, mint Y-é.
    if (paid('limitLoosens')) assert.equal(m.dailyLimitSeconds, y.dailyLimitSeconds, `${ctx}: a fizetett keret nem ért át`);
    else if (y.dailyLimitSeconds !== undefined) {
      assert.ok(m.dailyLimitSeconds !== undefined && m.dailyLimitSeconds <= y.dailyLimitSeconds, `${ctx}: a keret ingyen nőtt`);
    }
    // A menetrend: kifizetett lazításnál Y-é; különben minden percet tilt, amit Y tilt.
    if (paid('scheduleLoosens')) assert.deepEqual(m.schedule, y.schedule, `${ctx}: a fizetett menetrend nem ért át`);
    else {
      const gm = gridOf(m.schedule);
      gridOf(y.schedule).forEach((v, i) => assert.ok(!v || gm[i], `${ctx}: a menetrend ingyen nyitott ki egy percet`));
    }
    // Az adag: kifizetett lazításnál Y-é; különben legalább olyan szigorú.
    if (paid('burstLoosens')) assert.deepEqual([m.burstSeconds, m.cooldownSeconds], [y.burstSeconds, y.cooldownSeconds], `${ctx}: a fizetett adag nem ért át`);
    else if (y.burstSeconds !== undefined) {
      assert.ok(m.burstSeconds !== undefined && m.burstSeconds <= y.burstSeconds
        && (m.cooldownSeconds ?? 0) >= (y.cooldownSeconds ?? 0), `${ctx}: az adag ingyen lazult`);
    }
    // A törlés: kifizetett kérésnél Y-é; különben csak akkor vár, ha Y is.
    if (paid('deleteLoosens')) assert.equal(m.pendingDeleteAt, y.pendingDeleteAt, `${ctx}: a fizetett törlés nem ért át`);
    else if (y.pendingDeleteAt === null) assert.equal(m.pendingDeleteAt, null, `${ctx}: törlés indult ingyen`);
  }
});
