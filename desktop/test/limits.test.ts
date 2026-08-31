import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  blockReasonNow, isBlockedNowWithLimit, isLimitExhausted, isLimitLoosening, nextDayStartMs,
  normalizeLimit, usedTodaySeconds,
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

// ---------------------------------------------------------------------------
// A tiltás OKA — a döntés ezen a függvényen át megy, tehát a kettő nem tud
// mást mondani: nincs ok nélküli tiltás, és nincs nem-tiltó ok.
// ---------------------------------------------------------------------------

// Menetrend, ami MOST enged: scheduled_block, aminek a sávja nem fedi a NOW-t.
const OPEN_SCHEDULE = {
  mode: 'scheduled_block' as const,
  bands: [{ days: [0] as (0|1|2|3|4|5|6)[], startMin: 0, endMin: 60 }],
};

test('minden zárásnak neve van, és a sorrend a döntés sorrendje', () => {
  const noUse = emptyUsage();

  // Sima blokklistás oldal (nincs menetrend): mindig, lejárat nélkül.
  assert.deepEqual(blockReasonNow(site(), noUse, NOW), { reason: 'always', until: 0 });

  // Menetrend zár: a neve „schedule” — a mikor nyílikot az app mutatja meg.
  const closedSched = {
    mode: 'scheduled_allow' as const,
    bands: [{ days: [0] as (0|1|2|3|4|5|6)[], startMin: 0, endMin: 60 }],
  };
  assert.deepEqual(blockReasonNow(site({ schedule: closedSched }), noUse, NOW),
    { reason: 'schedule', until: 0 });

  // A törlésre váró oldal menetrendtől FÜGGETLENÜL zár — a címkéje sima tiltás.
  assert.deepEqual(
    blockReasonNow(site({ schedule: OPEN_SCHEDULE, pendingDeleteAt: NOW + 3600_000 }), noUse, NOW),
    { reason: 'always', until: 0 });

  // Hűtés: a lejárat TÉNY — pontosan a hűtés vége.
  const burst = { usedSeconds: 0, lastAt: NOW - 1000, cooldownUntil: NOW + 300_000 };
  assert.deepEqual(blockReasonNow(site({ schedule: OPEN_SCHEDULE }), noUse, NOW, null, burst),
    { reason: 'cooldown', until: NOW + 300_000 });

  // Betelt keret: a lejárat a KÖVETKEZŐ helyi éjfél.
  const spent = blockReasonNow(
    site({ schedule: OPEN_SCHEDULE, dailyLimitSeconds: 600 }),
    usageWith('youtube.com', 600), NOW);
  assert.equal(spent?.reason, 'limit');
  assert.equal(spent?.until, nextDayStartMs(NOW));
  assert.ok((spent?.until ?? 0) > NOW, 'az éjfél előttünk van');
  assert.equal(dayKey((spent?.until ?? 0) - 1), dayKey(NOW), 'az éjfél előtti pillanat még ma van');
  assert.notEqual(dayKey(spent?.until ?? 0), dayKey(NOW), 'az éjfél már holnap');

  // Nyitva: nincs ok. A megváltott feloldás pedig MINDENT legyőz — okostul.
  assert.equal(blockReasonNow(site({ schedule: OPEN_SCHEDULE }), noUse, NOW), null);
  assert.equal(
    blockReasonNow(site({ dailyLimitSeconds: 600, pauseUntil: NOW + 60_000 }),
      usageWith('youtube.com', 9999), NOW, null, burst),
    null, 'a szünet a hűtésen és a kereten is átüt');

  // A hűtés ERŐSEBB ok, mint a keret: ha mindkettő áll, a hűtés a neve —
  // annak van közelebbi, valódi lejárata.
  const both = blockReasonNow(
    site({ schedule: OPEN_SCHEDULE, dailyLimitSeconds: 600 }),
    usageWith('youtube.com', 600), NOW, null, burst);
  assert.equal(both?.reason, 'cooldown');
});
