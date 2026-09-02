import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  REOPEN_SLACK_MS, stepBurstNotices, type CoolingView,
} from '../src/shared/burst-notify';

const NOW = new Date(2026, 8, 2, 20, 0).getTime();

function cooling(id: string, until: number, label = id): CoolingView {
  return { id, label, closedReason: 'cooldown', closedUntil: until };
}

function open(id: string, label = id): CoolingView {
  return { id, label, closedUntil: 0 };
}

test('az első kör (indulás) csendben veszi fel a futó hűtést', () => {
  const r = stepBurstNotices(null, [cooling('a', NOW + 60_000)], NOW);
  assert.equal(r.notices.length, 0);
  assert.equal(r.watches['a']?.until, NOW + 60_000);
});

test('az indulásnál felvett hűtés LETELTE már szól — az tény, nem találgatás', () => {
  const r1 = stepBurstNotices(null, [cooling('a', NOW + 60_000)], NOW);
  // A hallgatási szabály csak a hamis „most telt be”-re vonatkozik; a letelt
  // szünet attól még bejelenthető tény, hogy a kezdetén nem voltunk ott.
  const r2 = stepBurstNotices(r1.watches, [open('a')], NOW + 61_000);
  assert.equal(r2.notices.length, 1);
  assert.equal(r2.notices[0].kind, 'reopened');
});

test('betelés: az újonnan hűlő oldal egyszer jelentkezik be', () => {
  const r1 = stepBurstNotices({}, [cooling('a', NOW + 600_000, 'gemini.google.com')], NOW);
  assert.equal(r1.notices.length, 1);
  assert.deepEqual(r1.notices[0], {
    kind: 'tripped', label: 'gemini.google.com', until: NOW + 600_000,
  });
  const r2 = stepBurstNotices(r1.watches, [cooling('a', NOW + 600_000)], NOW + 2000);
  assert.equal(r2.notices.length, 0);
});

test('letelt szünet: a hűlés eltűnése a vége körül „újra nyitva”-t szól', () => {
  const until = NOW + 600_000;
  const r1 = stepBurstNotices({}, [cooling('a', until)], NOW);
  const r2 = stepBurstNotices(r1.watches, [open('a', 'gemini.google.com')], until + 1000);
  assert.equal(r2.notices.length, 1);
  assert.equal(r2.notices[0].kind, 'reopened');
  // a friss (mostani) címke megy ki, nem a betéskori
  assert.equal(r2.notices[0].label, 'gemini.google.com');
  assert.deepEqual(r2.watches, {});
});

test('korai eltűnés (megváltott szünet, levett szabály) néma', () => {
  const until = NOW + 600_000;
  const r1 = stepBurstNotices({}, [cooling('a', until)], NOW);
  const r2 = stepBurstNotices(r1.watches, [open('a')], until - REOPEN_SLACK_MS - 1);
  assert.equal(r2.notices.length, 0);
  assert.deepEqual(r2.watches, {});
});

test('a közben törölt oldal letelte is néma', () => {
  const until = NOW + 600_000;
  const r1 = stepBurstNotices({}, [cooling('a', until)], NOW);
  const r2 = stepBurstNotices(r1.watches, [], until + 1000);
  assert.equal(r2.notices.length, 0);
  assert.deepEqual(r2.watches, {});
});

test('két oldal egymástól függetlenül jelentkezik', () => {
  const r1 = stepBurstNotices({}, [cooling('a', NOW + 100_000)], NOW);
  const r2 = stepBurstNotices(
    r1.watches,
    [cooling('a', NOW + 100_000), cooling('b', NOW + 200_000, 'b-oldal')],
    NOW + 2000,
  );
  assert.equal(r2.notices.length, 1);
  assert.equal(r2.notices[0].label, 'b-oldal');
  // az „a” a lejárta után is JELEN van a listában (nyitva) — a hiánya törlés
  // lenne, az néma
  const r3 = stepBurstNotices(
    r2.watches, [open('a'), cooling('b', NOW + 200_000)], NOW + 101_000,
  );
  assert.equal(r3.notices.length, 1);
  assert.equal(r3.notices[0].kind, 'reopened');
  assert.equal(r3.notices[0].label, 'a');
});

test('a megnőtt lejárat némán követődik, és a vége az új időhöz igazodik', () => {
  const r1 = stepBurstNotices({}, [cooling('a', NOW + 100_000)], NOW);
  const r2 = stepBurstNotices(r1.watches, [cooling('a', NOW + 300_000)], NOW + 2000);
  assert.equal(r2.notices.length, 0);
  assert.equal(r2.watches['a']?.until, NOW + 300_000);
  // a régi lejáratnál eltűnő hűlés így korai eltűnés lenne — néma
  const r3 = stepBurstNotices(r2.watches, [open('a')], NOW + 101_000);
  assert.equal(r3.notices.length, 0);
});

test('újabb betelés a letelt szünet után újra bejelentkezik', () => {
  const r1 = stepBurstNotices({}, [cooling('a', NOW + 100_000)], NOW);
  const r2 = stepBurstNotices(r1.watches, [open('a')], NOW + 101_000);
  assert.equal(r2.notices[0]?.kind, 'reopened');
  const r3 = stepBurstNotices(r2.watches, [cooling('a', NOW + 900_000)], NOW + 300_000);
  assert.equal(r3.notices.length, 1);
  assert.equal(r3.notices[0].kind, 'tripped');
});

test('a lejárt, de még hűtésnek jelölt bejegyzés nem vétetik fel', () => {
  const r = stepBurstNotices({}, [cooling('a', NOW - 1000)], NOW);
  assert.equal(r.notices.length, 0);
  assert.deepEqual(r.watches, {});
});

test('a lejárat-egyeztetés türelme: a sávhatáron belül már leteltnek számít', () => {
  // A 2 mp-es kör csúszása miatt a vége előtt pár másodperccel eltűnő hűlés
  // is letelt szünet — különben a rendes lejárat fele némán menne el.
  const until = NOW + 600_000;
  const r1 = stepBurstNotices({}, [cooling('a', until)], NOW);
  const r2 = stepBurstNotices(r1.watches, [open('a')], until - REOPEN_SLACK_MS);
  assert.equal(r2.notices.length, 1);
  assert.equal(r2.notices[0].kind, 'reopened');
});
