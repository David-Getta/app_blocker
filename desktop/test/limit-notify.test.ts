import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { LIMIT_SOON_SECONDS, stepLimitNotices } from '../src/shared/limits';

const site = (used: number, limit: number | null = 1800, id = 's1', label = 'youtube.com') =>
  ({ id, label, dailyLimitSeconds: limit, usedSeconds: used });

test('a küszöb átlépésekor egyszer szól — a „ma még” sor mondatával', () => {
  let r = stepLimitNotices({}, [site(600)], '2026-10-07');
  assert.deepEqual(r.notices, []);
  assert.equal(r.watches.s1.armed, true);
  // Átlépte: 1800 - 1260 = 540 mp ≤ 600 → szól.
  r = stepLimitNotices(r.watches, [site(1260)], '2026-10-07');
  assert.deepEqual(r.notices, [{ label: 'youtube.com', text: 'Ma még 9 perc a kereted: youtube.com.' }]);
  // Ugyanaznap többé nem.
  r = stepLimitNotices(r.watches, [site(1500)], '2026-10-07');
  assert.deepEqual(r.notices, []);
});

test('az app indulásakor már fogyó keretre hallgat; a betelt keretre sem szól', () => {
  let r = stepLimitNotices({}, [site(1500)], '2026-10-07');
  assert.deepEqual(r.notices, []);
  assert.equal(r.watches.s1.armed, false);
  r = stepLimitNotices(r.watches, [site(1800)], '2026-10-07');
  assert.deepEqual(r.notices, []);
});

test('új napon tiszta lap: élesít, és újra szólhat', () => {
  let r = stepLimitNotices({}, [site(600)], '2026-10-07');
  r = stepLimitNotices(r.watches, [site(1300)], '2026-10-07');
  assert.equal(r.notices.length, 1);
  r = stepLimitNotices(r.watches, [site(0)], '2026-10-08');
  assert.deepEqual(r.notices, []);
  assert.deepEqual(r.watches.s1, { day: '2026-10-08', armed: true, told: false });
  r = stepLimitNotices(r.watches, [site(1300)], '2026-10-08');
  assert.equal(r.notices.length, 1);
});

test('kis keretnél a fele a küszöb; keret nélkül nincs figyelés', () => {
  // Öt perces keret: a küszöb 150 mp, nem tíz perc.
  let r = stepLimitNotices({}, [site(100, 300)], '2026-10-07');
  assert.deepEqual(r.notices, []);
  assert.ok(LIMIT_SOON_SECONDS > 150);
  r = stepLimitNotices(r.watches, [site(160, 300)], '2026-10-07');
  assert.deepEqual(r.notices, [{ label: 'youtube.com', text: 'Ma még 3 perc a kereted: youtube.com.' }]);
  const none = stepLimitNotices({}, [site(100, null)], '2026-10-07');
  assert.deepEqual(none.watches, {});
});
