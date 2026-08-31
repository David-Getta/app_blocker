import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  isBlockedBySchedule, inAnyBand, isLoosening, nextOpenAt, normalizeSchedule, ALWAYS,
  type Schedule, type Band,
} from '../src/shared/schedule';

// Build a local-time instant for a given weekday + HH:MM. We pick a known
// Sunday (2024-01-07 is a Sunday) and add days, using local time so the
// schedule's local-clock logic is exercised as it will run on device.
function at(weekday: number, hh: number, mm: number): number {
  const base = new Date(2024, 0, 7, 0, 0, 0, 0); // Sun Jan 7 2024, local
  const d = new Date(base);
  d.setDate(base.getDate() + weekday);
  d.setHours(hh, mm, 0, 0);
  return d.getTime();
}

const workHours: Schedule = {
  mode: 'scheduled_block',
  bands: [{ days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 17 * 60 }],
};

test('always mode always blocks', () => {
  assert.equal(isBlockedBySchedule(ALWAYS, at(1, 3, 0)), true);
  assert.equal(isBlockedBySchedule(ALWAYS, at(6, 23, 59)), true);
});

test('scheduled_block: inside band blocks, outside is free', () => {
  assert.equal(isBlockedBySchedule(workHours, at(1, 10, 0)), true);  // Monday 10:00
  assert.equal(isBlockedBySchedule(workHours, at(1, 8, 59)), false); // just before
  assert.equal(isBlockedBySchedule(workHours, at(1, 17, 0)), false); // end is exclusive
  assert.equal(isBlockedBySchedule(workHours, at(0, 10, 0)), false); // Sunday not in days
  assert.equal(isBlockedBySchedule(workHours, at(6, 10, 0)), false); // Saturday
});

test('scheduled_allow is the inverse of the band', () => {
  const allow: Schedule = { mode: 'scheduled_allow', bands: workHours.bands };
  assert.equal(isBlockedBySchedule(allow, at(1, 10, 0)), false); // allowed during work hours
  assert.equal(isBlockedBySchedule(allow, at(1, 20, 0)), true);  // blocked outside
  assert.equal(isBlockedBySchedule(allow, at(0, 10, 0)), true);  // blocked on Sunday
});

test('midnight-wrapping band (22:00–06:00)', () => {
  const night: Schedule = {
    mode: 'scheduled_block',
    bands: [{ days: [1], startMin: 22 * 60, endMin: 6 * 60 }], // Monday 22:00 -> Tuesday 06:00
  };
  assert.equal(isBlockedBySchedule(night, at(1, 23, 0)), true);  // Mon 23:00
  assert.equal(isBlockedBySchedule(night, at(2, 5, 0)), true);   // Tue 05:00 (wrap)
  assert.equal(isBlockedBySchedule(night, at(2, 6, 0)), false);  // Tue 06:00 end exclusive
  assert.equal(isBlockedBySchedule(night, at(1, 21, 0)), false); // Mon 21:00 before
  assert.equal(isBlockedBySchedule(night, at(2, 23, 0)), false); // Tue night not in days
});

test('inAnyBand matches isBlockedBySchedule for block mode', () => {
  assert.equal(inAnyBand(workHours.bands, at(3, 12, 0)), true);
  assert.equal(inAnyBand(workHours.bands, at(3, 18, 0)), false);
});

test('normalizeSchedule: empty/invalid collapses to always', () => {
  assert.equal(normalizeSchedule(undefined).mode, 'always');
  assert.equal(normalizeSchedule({ mode: 'scheduled_block', bands: [] }).mode, 'always');
  const badBand = { days: [9 as unknown as 0], startMin: -5, endMin: 99999 } as Band;
  assert.equal(normalizeSchedule({ mode: 'scheduled_block', bands: [badBand] }).mode, 'always');
});

test('isLoosening: tightening is free, loosening is gated', () => {
  const now = at(0, 0, 0); // start of the sampled week (Sunday 00:00)
  // always -> workHours block: frees up nights/weekends => loosening
  assert.equal(isLoosening(ALWAYS, workHours, now), true);
  // workHours -> always: never frees anything => not loosening
  assert.equal(isLoosening(workHours, ALWAYS, now), false);
  // identical schedule => not loosening
  assert.equal(isLoosening(workHours, workHours, now), false);
  // block -> allow (same bands) frees the complement => loosening
  const allow: Schedule = { mode: 'scheduled_allow', bands: workHours.bands };
  assert.equal(isLoosening(workHours, allow, now), true);
  // widening a block band (more blocked time) is tightening => not loosening
  const wider: Schedule = {
    mode: 'scheduled_block',
    bands: [{ days: [1, 2, 3, 4, 5], startMin: 8 * 60, endMin: 18 * 60 }],
  };
  assert.equal(isLoosening(workHours, wider, now), false);
  // narrowing a block band frees time => loosening
  assert.equal(isLoosening(wider, workHours, now), true);
});

test('nextOpenAt: a következő nyitás percre pontos, a sosem nyíló nulla', () => {
  // Hétköznap 9–17 tiltva (workHours). Hétfő 10:00-kor zárva → 17:00-kor nyit.
  assert.equal(nextOpenAt(workHours, at(1, 10, 0)), at(1, 17, 0));
  // Nyitott pillanatra maga a pillanat jön vissza — a hívó csak zártan kérdezi.
  const openNow = at(1, 8, 0);
  assert.equal(nextOpenAt(workHours, openNow), openNow);
  // Éjfélen átforduló sáv: szerda 22:00-tól másnap 02:00-ig tilt.
  const late: Schedule = {
    mode: 'scheduled_block',
    bands: [{ days: [3], startMin: 22 * 60, endMin: 2 * 60 }],
  };
  assert.equal(nextOpenAt(late, at(3, 23, 30)), at(4, 2, 0));
  // Fordított irány: csak vasárnap hajnal szabad — szerdától vasárnapig várat.
  const sundayOnly: Schedule = {
    mode: 'scheduled_allow',
    bands: [{ days: [0], startMin: 0, endMin: 60 }],
  };
  assert.equal(nextOpenAt(sundayOnly, at(3, 15, 0)), at(7, 0, 0));
  // A sosem nyíló menetrendnek nincs következő nyitása — se a sima tiltásnak,
  // se egy hézag nélküli sávozásnak.
  assert.equal(nextOpenAt(ALWAYS, at(1, 10, 0)), 0);
  const solid: Schedule = {
    mode: 'scheduled_block',
    bands: [{ days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1440 }],
  };
  assert.equal(nextOpenAt(solid, at(1, 10, 0)), 0);
});
