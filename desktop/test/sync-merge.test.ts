// Az összefésülés nem oldhat fel semmit.
//
// Ez a szinkron egyetlen igazán veszélyes pontja: ha a fésülés bármikor a
// lazább oldal felé dől, akkor két eszközzel és egy jól időzített művelettel
// próbatétel nélkül lehet feloldani. A tesztek nagy része ezért nem azt nézi,
// hogy „jó-e az eredmény”, hanem hogy NEM LETT-E LAZÁBB.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  blockedMinutesPerWeek, compareStrictness, mergeSite, mergeSiteLists, type SyncSite,
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

test('a schedule is measured by structure, so two timezones agree', () => {
  // Ha az összevetés a gép helyi idejét használná, két eszköz két különböző
  // eredményre jutna, és a szinkron sosem állna meg.
  assert.equal(blockedMinutesPerWeek(undefined), 7 * 1440, 'menetrend nélkül minden perc tiltva');
  assert.equal(blockedMinutesPerWeek({ mode: 'always', bands: [] }), 7 * 1440);
  assert.equal(blockedMinutesPerWeek(WORK), 5 * 8 * 60, 'H–P 9–17 = heti 2400 perc');
  assert.equal(blockedMinutesPerWeek(EVENING), 7 * 8 * 60, '22–06 minden nap = heti 3360 perc');
  const allow: Schedule = { mode: 'scheduled_allow', bands: WORK.bands };
  assert.equal(blockedMinutesPerWeek(allow), 7 * 1440 - 5 * 8 * 60, 'a megengedő a komplemens');
});

test('the stricter record wins when neither is newer', () => {
  const strict = site({ rev: 4, dailyLimitSeconds: 600 });
  const loose = site({ rev: 4, dailyLimitSeconds: 3600, updatedAt: 9_999, updatedBy: 'gep-b' });
  // A lazább FRISSEBB — mégsem nyer, mert a rev egyenlő: nincs mögötte munka.
  assert.equal(mergeSite(strict, loose).dailyLimitSeconds, 600);
  assert.equal(mergeSite(loose, strict).dailyLimitSeconds, 600, 'a sorrend nem számít');
});

test('a loosening only lands with a higher rev', () => {
  const strict = site({ rev: 4, dailyLimitSeconds: 600 });
  const earned = site({ rev: 5, dailyLimitSeconds: 3600, updatedBy: 'gep-b' });
  assert.equal(mergeSite(strict, earned).dailyLimitSeconds, 3600, 'a próbatétel megvolt');

  const stale = site({ rev: 3, dailyLimitSeconds: 7200, updatedAt: 99_999, updatedBy: 'gep-b' });
  assert.equal(mergeSite(strict, stale).dailyLimitSeconds, 600, 'régi, lazább rekord nem lazít');
});

test('a pause never travels between devices as a loosening', () => {
  const now = 1_700_000_000_000;
  const blocked = site({ rev: 7 });
  const paused = site({ rev: 7, pauseUntil: now + 30 * 60_000, updatedBy: 'gep-b' });
  assert.equal(mergeSite(blocked, paused).pauseUntil, null, 'egyenlő rev: a blokkolt marad');
});

test('a pending deletion is not lost just because the other device wrote later', () => {
  const deleting = site({ rev: 3, pendingDeleteAt: 9_000_000 });
  const newer = site({ rev: 9, alias: 'A videós', updatedBy: 'gep-b' });
  const m = mergeSite(deleting, newer);
  assert.equal(m.alias, 'A videós', 'a frissebb rekord mezői jönnek');
  assert.equal(m.pendingDeleteAt, null,
    'a nagyobb rev azt jelenti, hogy KÉSŐBB vonták vissza a törlést');

  // Fordítva: az újabb rekord NEM a törlés visszavonása, mert régebbi rev-ű.
  const older = site({ rev: 2, alias: 'A videós', updatedBy: 'gep-b' });
  const m2 = mergeSite(deleting, older);
  assert.equal(m2.pendingDeleteAt, 9_000_000, 'a törlés folyamatban marad');
});

test('two deletions in flight keep the earlier deadline', () => {
  const a = site({ rev: 3, pendingDeleteAt: 9_000_000 });
  const b = site({ rev: 4, pendingDeleteAt: 8_000_000, updatedBy: 'gep-b' });
  assert.equal(mergeSite(a, b).pendingDeleteAt, 8_000_000);
  assert.equal(mergeSite(b, a).pendingDeleteAt, 8_000_000);
});

test('the merge is symmetric and settles on one answer', () => {
  const a = site({ rev: 4, schedule: WORK, updatedAt: 10, updatedBy: 'gep-a' });
  const b = site({ rev: 4, schedule: EVENING, updatedAt: 10, updatedBy: 'gep-b' });
  const ab = mergeSite(a, b);
  const ba = mergeSite(b, a);
  assert.deepEqual(ab, ba, 'mindkét eszköz ugyanazt kapja');
  assert.equal(blockedMinutesPerWeek(ab.schedule), 7 * 8 * 60, 'a többet tiltó marad');
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
  assert.equal(m[0].id, 'a', 'a régebbi azonosító marad — arra hivatkozhat egy futó próba');
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

test('strictness ranks deletion, pause, schedule and budget in that order', () => {
  const plain = site();
  assert.equal(compareStrictness(plain, site({ pendingDeleteAt: 1 })), -1, 'a törlésre váró lazább');
  assert.equal(compareStrictness(plain, site({ pauseUntil: 999 })), -1, 'a szünetelő lazább');
  assert.equal(compareStrictness(site({ schedule: WORK }), plain), 1, 'a menetrend nélküli szigorúbb');
  assert.equal(compareStrictness(site({ dailyLimitSeconds: 600 }), plain), -1, 'a keret szigorít');
  assert.equal(compareStrictness(plain, site()), 0);
});
