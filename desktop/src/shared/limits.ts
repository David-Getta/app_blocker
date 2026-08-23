// Daily active-time budget per site.
//
// The blocking decision so far was binary (blocked / not blocked) plus a weekly
// schedule. The tracker already knows how much active time went into a site
// today, so the two can be combined: "not banned outright, but at most 20
// minutes a day". Once today's budget is spent, the site blocks itself for the
// rest of the day and starts over at midnight.
//
// See docs/feature-daily-limit.md. Pure and dependency-free, like the rest of
// the shared core, so Kotlin/Swift can mirror it exactly.

import { isBlockedNow, type Blockable } from './schedule';
import { dayKey, siteKey, type UsageState } from './usage';

export interface Limitable extends Blockable {
  /** the registrable domain, i.e. how the tracker keys this site */
  domain: string;
  /** daily active-time budget in seconds; absent = no budget */
  dailyLimitSeconds?: number;
}

/** Active seconds recorded for this site today (0 when nothing is tracked). */
export function usedTodaySeconds(usage: UsageState, domain: string, now: number): number {
  const today = dayKey(now);
  const bucket = usage.days.find((d) => d.day === today);
  if (!bucket) return 0;
  const seconds = bucket.seconds[siteKey(domain)];
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

/** Whether today's budget is used up. No budget = never exhausted. */
export function isLimitExhausted(site: Limitable, usage: UsageState, now: number): boolean {
  const limit = site.dailyLimitSeconds;
  if (!Number.isFinite(limit) || (limit as number) <= 0) return false;
  return usedTodaySeconds(usage, site.domain, now) >= (limit as number);
}

/**
 * The whole blocking decision: pause, pending delete, weekly schedule AND the
 * daily budget.
 *
 * Order matters. An active pause still wins over everything — it was paid for
 * with a challenge, and having it silently overridden by a budget would make
 * the unlock the user just earned worthless. Everything else blocks.
 */
export function isBlockedNowWithLimit(site: Limitable, usage: UsageState, now: number): boolean {
  if (site.pauseUntil !== null && site.pauseUntil > now) return false;
  if (isBlockedNow(site, now)) return true;
  return isLimitExhausted(site, usage, now);
}

/**
 * Is changing the budget a loosening (i.e. does it need the unlock challenges)?
 *
 * Raising it or taking it away buys more time on the site, so it goes through
 * the same friction as a pause. Lowering it or introducing one is a tightening
 * and applies immediately — the direction that helps is always free.
 */
export function isLimitLoosening(
  current: number | undefined | null, next: number | undefined | null,
): boolean {
  const cur = normalizeLimit(current);
  const nxt = normalizeLimit(next);
  if (cur === null) return false;        // there was no budget; any budget is stricter
  if (nxt === null) return true;         // removing the budget frees the whole day
  return nxt > cur;
}

/** A usable budget, or null for "no budget". Nonsense values mean no budget. */
export function normalizeLimit(value: number | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  // A day is the ceiling: a bigger "budget" is the same as having none.
  return Math.min(Math.round(value), 24 * 3600);
}
