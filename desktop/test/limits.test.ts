import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  isBlockedNowWithLimit, isLimitExhausted, isLimitLoosening, normalizeLimit, usedTodaySeconds,
} from '../src/shared/limits';
import { dayKey, emptyUsage, siteKey, type UsageState } from '../src/shared/usage';

const NOW = new Date(2026, 4, 20, 15, 0).getTime();

function usageWith(domain: string, seconds: number, at = NOW): UsageState {
  const u = emptyUsage();
  u.days.push({ day: dayKey(at), seconds: { [siteKey(domain)]: seconds } });
  return u;
}

const site = (extra: Partial<Parameters<typeof isBlockedNowWithLimit>[0]> = {}) => ({
  domain: 'youtube.com', pauseUntil: null, pendingDeleteAt: null, ...extra,
});

test('a site with no budget is unaffected by it', () => {
  assert.equal(isLimitExhausted(site(), usageWith('youtube.com', 9999), NOW), false);
  assert.equal(usedTodaySeconds(emptyUsage(), 'youtube.com', NOW), 0);
});

test('the budget blocks once today\'s active time reaches it', () => {
  const s = site({ dailyLimitSeconds: 1200 });      // 20 perc
  assert.equal(isLimitExhausted(s, usageWith('youtube.com', 1199), NOW), false);
  assert.equal(isLimitExhausted(s, usageWith('youtube.com', 1200), NOW), true, 'reaching it counts');
  assert.equal(isLimitExhausted(s, usageWith('youtube.com', 5000), NOW), true);
});

test('yesterday\'s time does not count against today', () => {
  const yesterday = NOW - 24 * 3600_000;
  const s = site({ dailyLimitSeconds: 600 });
  assert.equal(isLimitExhausted(s, usageWith('youtube.com', 5000, yesterday), NOW), false,
    'the budget starts over at midnight');
});

test('only this site\'s own time counts', () => {
  const u = usageWith('reddit.com', 5000);
  assert.equal(isLimitExhausted(site({ dailyLimitSeconds: 600 }), u, NOW), false);
});

test('an exhausted budget blocks even when the schedule would allow it', () => {
  const s = site({
    dailyLimitSeconds: 600,
    // scheduled_block with no band covering now => the schedule allows it
    schedule: { mode: 'scheduled_block' as const, bands: [{ days: [0] as (0|1|2|3|4|5|6)[], startMin: 0, endMin: 60 }] },
  });
  assert.equal(isBlockedNowWithLimit(s, usageWith('youtube.com', 100), NOW), false, 'budget left');
  assert.equal(isBlockedNowWithLimit(s, usageWith('youtube.com', 600), NOW), true, 'budget spent');
});

test('an unlock the user earned still wins over the budget', () => {
  // The pause was paid for with challenges; letting a spent budget override it
  // would make that payment worthless.
  const s = site({ dailyLimitSeconds: 600, pauseUntil: NOW + 60_000 });
  assert.equal(isBlockedNowWithLimit(s, usageWith('youtube.com', 99999), NOW), false);
});

test('a pending deletion still blocks regardless of the budget', () => {
  const s = site({ dailyLimitSeconds: 600, pendingDeleteAt: NOW + 3600_000 });
  assert.equal(isBlockedNowWithLimit(s, usageWith('youtube.com', 0), NOW), true);
});

test('tightening the budget is free, loosening is not', () => {
  assert.equal(isLimitLoosening(undefined, 600), false, 'introducing a budget is a tightening');
  assert.equal(isLimitLoosening(1200, 600), false, 'less time is a tightening');
  assert.equal(isLimitLoosening(600, 600), false, 'no change is not a loosening');
  assert.equal(isLimitLoosening(600, 1200), true, 'more time must be earned');
  assert.equal(isLimitLoosening(600, undefined), true, 'removing it frees the whole day');
  assert.equal(isLimitLoosening(600, 0), true, '0 means no budget, so it is a removal');
});

test('nonsense budgets are treated as no budget, and a day is the ceiling', () => {
  assert.equal(normalizeLimit(undefined), null);
  assert.equal(normalizeLimit(0), null);
  assert.equal(normalizeLimit(-5), null);
  assert.equal(normalizeLimit(Number.NaN), null);
  assert.equal(normalizeLimit(1200.4), 1200);
  assert.equal(normalizeLimit(99 * 3600), 24 * 3600);
});
