// Active-time usage tracking: aggregation and statistics.
//
// "Active time" means time the user was actually IN a target (focused window,
// active browser tab, not idle) — not how long it was open. The measurement
// itself is done by platform trackers; this module only aggregates samples into
// daily buckets and answers statistical questions about them.
//
// Pure and dependency-free, so the same logic is mirrored by Kotlin/Swift.
// See docs/feature-usage-stats.md.

// Explicit .js: the renderer runs this through the browser's native ESM
// loader, which does not add extensions (TypeScript leaves the specifier as-is).
import { normalizeDomain } from './blocklist.js';

export type TargetKind = 'app' | 'site';

/** Daily bucket of active seconds, keyed by target ("app:…" / "site:…"). */
export interface UsageDay {
  /** local calendar day, YYYY-MM-DD */
  day: string;
  seconds: Record<string, number>;
}

export interface UsageState {
  days: UsageDay[];
  /** target key -> human readable label */
  labels: Record<string, string>;
  /** user can switch measurement off entirely */
  enabled: boolean;
}

export const RETENTION_DAYS = 90;
export const SAMPLE_INTERVAL_MS = 5_000;
export const IDLE_THRESHOLD_MS = 60_000;
/**
 * Defensive cap per recorded amount. This is NOT the per-tick limit (that lives
 * in decideSample, clamped to two sample intervals) — trackers batch many ticks
 * into one record, and a batch that waited out a long helper outage legitimately
 * carries a lot of time. What is never legitimate is more than a day landing in
 * a single day's bucket for one target.
 */
export const MAX_RECORD_SECONDS = 24 * 3600;
/**
 * Distinct targets kept per day. Without a cap, anything that can invent target
 * names — a page fetching random subdomains, a local process feeding the helper
 * — grows the stored state without bound. Beyond this the smallest entries are
 * folded into a catch-all so the numbers stay honest instead of disappearing.
 */
export const MAX_TARGETS_PER_DAY = 200;
export const OTHER_SITE_KEY = 'site:(egyéb)';
export const OTHER_APP_KEY = 'app:(egyéb)';
/** Length limits for anything that ends up as a stored key or label. */
export const MAX_KEY_LENGTH = 128;
export const MAX_LABEL_LENGTH = 96;
/**
 * Samples the helper accepts in one usage_batch request, and — deliberately the
 * same number — (target, day) buckets a tracker may hold while the helper is
 * unreachable. Equal on purpose: a completely full buffer must still fit into a
 * single request, otherwise the surplus would be truncated away unnoticed.
 */
export const MAX_BATCH_SAMPLES = 512;
/**
 * How far back a buffered slice may reach before the tracker drops it. Kept
 * inside the helper's ±7-day acceptance window: shipping something older only
 * looks like delivery, the helper discards it as a nonsense timestamp. Reaching
 * this needs a week-long helper outage with the GUI running throughout.
 */
export const MAX_BUFFER_AGE_MS = 6 * 24 * 3600_000;

export function emptyUsage(): UsageState {
  return { days: [], labels: {}, enabled: true };
}

// ------------------------------------------------------------------- keys

export function siteKey(domain: string): string {
  return `site:${domain}`;
}

export function appKey(id: string): string {
  return `app:${id}`;
}

export function kindOf(key: string): TargetKind {
  return key.startsWith('site:') ? 'site' : 'app';
}

export function idOf(key: string): string {
  return key.slice(key.indexOf(':') + 1);
}

// ------------------------------------------------------------------- days

/** Local calendar day of an instant, as YYYY-MM-DD. */
export function dayKey(now: number): string {
  const d = new Date(now);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * The last `count` local day keys ending with today, oldest first.
 * Steps at noon so DST transitions cannot skip or duplicate a day.
 */
export function dayKeysBack(now: number, count: number): string[] {
  const base = new Date(now);
  base.setHours(12, 0, 0, 0);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(base.getDate() - i);
    out.push(dayKey(d.getTime()));
  }
  return out;
}

// -------------------------------------------------------------- recording

/**
 * Adds `seconds` of active time to `key` in today's bucket. Returns the same
 * state object (mutated) so trackers can call it on a hot path cheaply.
 * Invalid or absurd sample lengths are clamped rather than trusted.
 */
export function recordSample(
  state: UsageState, key: string, seconds: number, now: number, label?: string,
): UsageState {
  if (!state.enabled) return state;
  if (!Number.isFinite(seconds) || seconds <= 0) return state;
  const amount = Math.min(seconds, MAX_RECORD_SECONDS);

  const today = dayKey(now);
  let bucket = state.days.find((d) => d.day === today);
  if (!bucket) {
    bucket = { day: today, seconds: {} };
    state.days.push(bucket);
    state.days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  }
  bucket.seconds[key] = (bucket.seconds[key] ?? 0) + amount;
  if (label) state.labels[key] = label.slice(0, MAX_LABEL_LENGTH);
  coalesceDay(bucket);
  pruneOld(state, now);
  return state;
}

/**
 * Folds the smallest targets of an over-full day into a per-kind catch-all.
 * The day's total is preserved exactly — only the breakdown loses its tail.
 */
export function coalesceDay(bucket: UsageDay): void {
  const keys = Object.keys(bucket.seconds);
  if (keys.length <= MAX_TARGETS_PER_DAY) return;
  const catchAll = new Set([OTHER_SITE_KEY, OTHER_APP_KEY]);
  const ranked = keys
    .filter((k) => !catchAll.has(k))
    .sort((a, b) => bucket.seconds[b] - bucket.seconds[a]);
  // leave room for the two catch-all entries
  const keep = new Set(ranked.slice(0, Math.max(0, MAX_TARGETS_PER_DAY - catchAll.size)));
  for (const k of ranked) {
    if (keep.has(k)) continue;
    const target = kindOf(k) === 'site' ? OTHER_SITE_KEY : OTHER_APP_KEY;
    bucket.seconds[target] = (bucket.seconds[target] ?? 0) + bucket.seconds[k];
    delete bucket.seconds[k];
  }
}

/**
 * Keeps the newest RETENTION_DAYS buckets and drops labels nothing references.
 *
 * Retention is bounded by COUNT, not by comparing against the current clock:
 * a wrong system time (NTP correction, a user setting the date forward, a DST
 * or timezone change) must never be able to wipe real history, in either
 * direction. Counting also bounds storage exactly.
 */
export function pruneOld(state: UsageState, _now?: number): UsageState {
  // day keys are YYYY-MM-DD, so lexicographic order is chronological
  state.days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  if (state.days.length > RETENTION_DAYS) {
    state.days = state.days.slice(-RETENTION_DAYS);
  }
  const used = new Set<string>();
  for (const d of state.days) for (const k of Object.keys(d.seconds)) used.add(k);
  for (const k of Object.keys(state.labels)) if (!used.has(k)) delete state.labels[k];
  return state;
}

// ------------------------------------------------------------ aggregation

/** Sums seconds per target over the given day keys. */
export function totalsForDays(state: UsageState, days: string[]): Record<string, number> {
  const wanted = new Set(days);
  const out: Record<string, number> = {};
  for (const d of state.days) {
    if (!wanted.has(d.day)) continue;
    for (const [k, s] of Object.entries(d.seconds)) out[k] = (out[k] ?? 0) + s;
  }
  return out;
}

export interface TargetTotal {
  key: string;
  label: string;
  kind: TargetKind;
  seconds: number;
}

export function labelOf(state: UsageState, key: string): string {
  return state.labels[key] ?? idOf(key);
}

/** Targets sorted by time spent, optionally filtered to apps or sites. */
export function rank(
  state: UsageState, totals: Record<string, number>,
  opts: { kind?: TargetKind; limit?: number } = {},
): TargetTotal[] {
  const rows = Object.entries(totals)
    .filter(([k]) => (opts.kind ? kindOf(k) === opts.kind : true))
    .map(([k, s]) => ({ key: k, label: labelOf(state, k), kind: kindOf(k), seconds: s }))
    .sort((a, b) => b.seconds - a.seconds);
  return opts.limit ? rows.slice(0, opts.limit) : rows;
}

export function sumOf(totals: Record<string, number>): number {
  return Object.values(totals).reduce((a, b) => a + b, 0);
}

/** Per-day series for one target over the last `count` days, oldest first. */
export function series(
  state: UsageState, key: string, now: number, count: number,
): { day: string; seconds: number }[] {
  const days = dayKeysBack(now, count);
  const byDay = new Map(state.days.map((d) => [d.day, d.seconds]));
  return days.map((day) => ({ day, seconds: byDay.get(day)?.[key] ?? 0 }));
}

/**
 * Napi ÖSSZESEN — minden célpont együtt — az utolsó `count` napra, a
 * legrégebbitől. Ugyanaz a szám, amit a csempe egyben mond („utolsó 7 nap”),
 * csak napokra bontva: a hét alakja innen látszik.
 */
export function totalSeries(
  state: UsageState, now: number, count: number,
): { day: string; seconds: number }[] {
  const days = dayKeysBack(now, count);
  const byDay = new Map(state.days.map((d) => [d.day, d.seconds]));
  return days.map((day) => ({ day, seconds: sumOf(byDay.get(day) ?? {}) }));
}

export interface WeekDelta {
  key: string;
  label: string;
  kind: TargetKind;
  thisWeek: number;
  lastWeek: number;
  /** percentage change; null when there is no previous-week baseline */
  deltaPct: number | null;
}

/** This-week vs previous-week comparison for the busiest targets. */
export function weekOverWeek(state: UsageState, now: number, limit = 5): WeekDelta[] {
  const last14 = dayKeysBack(now, 14);
  const prev = last14.slice(0, 7);
  const cur = last14.slice(7);
  const curTotals = totalsForDays(state, cur);
  const prevTotals = totalsForDays(state, prev);
  const keys = new Set([...Object.keys(curTotals), ...Object.keys(prevTotals)]);
  return [...keys]
    .map((key) => {
      const thisWeek = curTotals[key] ?? 0;
      const lastWeek = prevTotals[key] ?? 0;
      return {
        key,
        label: labelOf(state, key),
        kind: kindOf(key),
        thisWeek,
        lastWeek,
        deltaPct: lastWeek > 0 ? ((thisWeek - lastWeek) / lastWeek) * 100 : null,
      };
    })
    .sort((a, b) => b.thisWeek - a.thisWeek)
    .slice(0, limit);
}

export interface UsageSummary {
  enabled: boolean;
  todaySeconds: number;
  yesterdaySeconds: number;
  last7Seconds: number;
  last30Seconds: number;
  topToday: TargetTotal[];
  topWeekSites: TargetTotal[];
  topWeekApps: TargetTotal[];
  weekOverWeek: WeekDelta[];
  /** how many days of history exist at all */
  daysTracked: number;
}

export function summarize(state: UsageState, now: number, topLimit = 8): UsageSummary {
  const today = dayKey(now);
  const yesterday = dayKeysBack(now, 2)[0];
  const todayTotals = totalsForDays(state, [today]);
  const weekTotals = totalsForDays(state, dayKeysBack(now, 7));
  return {
    enabled: state.enabled,
    todaySeconds: sumOf(todayTotals),
    yesterdaySeconds: sumOf(totalsForDays(state, [yesterday])),
    last7Seconds: sumOf(weekTotals),
    last30Seconds: sumOf(totalsForDays(state, dayKeysBack(now, 30))),
    topToday: rank(state, todayTotals, { limit: topLimit }),
    topWeekSites: rank(state, weekTotals, { kind: 'site', limit: topLimit }),
    topWeekApps: rank(state, weekTotals, { kind: 'app', limit: topLimit }),
    weekOverWeek: weekOverWeek(state, now),
    daysTracked: state.days.length,
  };
}

// ----------------------------------------------------------- sampling rule

/** What the platform probe reports about the focused window right now. */
export interface Foreground {
  /** stable app identifier (bundle id on macOS, process name on Windows) */
  appId: string;
  /** human readable app name */
  appName: string;
  /** active tab domain, when the focused app is a browser and it could be read */
  domain?: string;
}

export interface SampleDecision {
  key: string;
  label: string;
  seconds: number;
}

/**
 * Decides what a single tick should record. Pure, so the tricky parts (idle,
 * sleep/wake, missing foreground) are unit-testable without spawning processes.
 *
 * Attribution rule: a sample counts towards exactly ONE target — the most
 * specific one. In a browser with a readable tab that is the site; otherwise the
 * app. This keeps totals exact (no double counting of browser time).
 */
export function decideSample(opts: {
  lastAt: number;
  now: number;
  /** seconds since the last user input, as reported by the OS */
  idleSeconds: number;
  fg: Foreground | null;
  intervalMs?: number;
  idleThresholdMs?: number;
}): SampleDecision | null {
  const intervalMs = opts.intervalMs ?? SAMPLE_INTERVAL_MS;
  const idleThresholdMs = opts.idleThresholdMs ?? IDLE_THRESHOLD_MS;

  // Idle (or asleep/locked) time is never active time.
  if (!Number.isFinite(opts.idleSeconds) || opts.idleSeconds * 1000 >= idleThresholdMs) return null;
  if (!opts.fg) return null;

  // Clamp the elapsed span: after sleep/wake or a stalled tick the wall-clock
  // gap can be hours, but the user was not actually present for it.
  const rawElapsed = opts.now - opts.lastAt;
  if (!Number.isFinite(rawElapsed) || rawElapsed <= 0) return null;
  const seconds = Math.min(rawElapsed, intervalMs * 2) / 1000;

  if (opts.fg.domain) {
    return { key: siteKey(opts.fg.domain), label: opts.fg.domain, seconds };
  }
  return { key: appKey(opts.fg.appId), label: opts.fg.appName, seconds };
}

/**
 * The domain a browser probe may turn into a tracked site.
 *
 * Only an absolute http(s) URL qualifies. Probes read the address bar through
 * accessibility APIs, and the same APIs expose every text field on the page —
 * a compose box, a search field, a login form. Requiring a real URL means a
 * failed read costs a site breakdown, never a record of what the user typed.
 */
export function domainFromBrowserUrl(url: string): string | null {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  return normalizeDomain(url);
}

// -------------------------------------------------------------- formatting

/** Hungarian human-readable duration: "2 ó 15 p", "45 p", "30 mp". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} mp`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} p`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  return rem === 0 ? `${h} ó` : `${h} ó ${rem} p`;
}

// ------------------------------------------------------- több eszköz együtt

/**
 * Több eszköz mérését EGYETLEN mérés-állapottá fésüli össze.
 *
 * Miért kell: a kérdés, ami tényleg számít, nem az eszközönkénti bontás.
 * Nem az, hogy mennyi ment el YouTube-ra a gépen, és külön mennyi a telefonon,
 * hanem hogy MENNYI MENT EL ÖSSZESEN. Két eszközön külön-külön napi húsz perc
 * együtt negyven — és pont a negyven az a szám, amivel a felhasználó küzd.
 *
 * A visszaadott állapot ugyanolyan `UsageState`, ezért a `summarize`, a `rank`
 * és a `series` VÁLTOZATLANUL használható rajta. Ez szándékos: egy második
 * összegző implementáció előbb-utóbb elcsúszna az elsőtől, és a két nézet más
 * számot mutatna ugyanarra a kérdésre.
 *
 * Két dolog, amit érdemes kimondani:
 *
 * - A napkulcs annak az eszköznek a HELYI naptári napja, amelyik felvette. Két
 *   időzóna között ez néhány órányi átfedést jelent a nap határán. Nincs jobb
 *   megoldás: a nyers mintákat nem tartjuk meg, csak a napi vödröket — és a
 *   „ma” úgyis azt jelenti, amit az ember a saját napjának érez.
 * - A címke onnan az eszközről jön, amelyik a LEGTÖBB időt mérte az adott
 *   célponton. Így nem a hívás sorrendjén múlik, és a legjellemzőbb helyről
 *   származik. (A `site:` kulcsok minden platformon azonosak, tehát a
 *   weboldalak tényleg összeadódnak; két külön app viszont két külön kulcs,
 *   és az helyes — a telefonos és a gépes böngésző nem ugyanaz.)
 */
export function combineUsage(states: UsageState[]): UsageState {
  const byDay = new Map<string, Record<string, number>>();
  // kulcs -> [legtöbb másodperc egy eszközön, az ahhoz tartozó címke]
  const bestLabel = new Map<string, { seconds: number; label: string }>();

  for (const st of states) {
    if (!st || !Array.isArray(st.days)) continue;
    const mine: Record<string, number> = {};
    for (const d of st.days) {
      if (!d || typeof d.day !== 'string' || !d.seconds) continue;
      let bucket = byDay.get(d.day);
      if (!bucket) { bucket = {}; byDay.set(d.day, bucket); }
      for (const [k, s] of Object.entries(d.seconds)) {
        if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0) continue;
        bucket[k] = (bucket[k] ?? 0) + s;
        mine[k] = (mine[k] ?? 0) + s;
      }
    }
    for (const [k, s] of Object.entries(mine)) {
      const label = st.labels?.[k];
      if (typeof label !== 'string' || label === '') continue;
      const cur = bestLabel.get(k);
      if (!cur || s > cur.seconds) bestLabel.set(k, { seconds: s, label });
    }
  }

  const labels: Record<string, string> = {};
  for (const [k, v] of bestLabel) labels[k] = v.label;

  return {
    // A napok rendezve, mert a `series` és a diagramok sorrendet feltételeznek.
    days: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, seconds]) => ({ day, seconds })),
    labels,
    // Ha BÁRMELYIK eszköz mér, az összesített szám valódi. A helyi kapcsoló
    // kikapcsolt állapota nem teszi hamissá azt, amit a telefon mért.
    enabled: states.some((s) => s?.enabled === true),
  };
}
