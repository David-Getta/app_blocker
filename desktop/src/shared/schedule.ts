// Weekly blocking schedules — pure, dependency-free logic shared by the helper
// and mirrored by Kotlin/Swift. See docs/feature-schedules.md.
//
// Design invariant: tightening (more blocked time) is free; loosening (less
// blocked time) must go through the same unlock challenges as a pause, so a
// schedule edit can never be a friction bypass.

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday
export type ScheduleMode = 'always' | 'scheduled_block' | 'scheduled_allow';

export interface Band {
  days: Weekday[];
  /** local-time minutes from midnight, 0..1439 */
  startMin: number;
  /** local-time minutes from midnight, 1..1440; if <= startMin the band wraps past midnight */
  endMin: number;
}

export interface Schedule {
  mode: ScheduleMode;
  bands: Band[];
}

export const ALWAYS: Schedule = { mode: 'always', bands: [] };

export function isValidBand(b: Band): boolean {
  if (!Array.isArray(b.days) || b.days.length === 0) return false;
  if (b.days.some((d) => d < 0 || d > 6 || !Number.isInteger(d))) return false;
  if (!Number.isInteger(b.startMin) || !Number.isInteger(b.endMin)) return false;
  if (b.startMin < 0 || b.startMin > 1439) return false;
  if (b.endMin < 1 || b.endMin > 1440) return false;
  return true;
}

const VALID_MODES: ScheduleMode[] = ['always', 'scheduled_block', 'scheduled_allow'];

export function normalizeSchedule(s: Schedule | undefined | null): Schedule {
  // Fail closed on anything unrecognised. An unknown mode would fall through
  // isBlockedBySchedule's switch and yield undefined — the site would be
  // silently unblocked while still looking protected in the UI.
  if (!s || !VALID_MODES.includes(s.mode)) return ALWAYS;
  if (s.mode === 'always') return ALWAYS;
  const bands = (s.bands ?? []).filter(isValidBand);
  if (bands.length === 0) return ALWAYS; // an empty schedule is just "always blocked"
  return { mode: s.mode, bands };
}

/** Local weekday + minute-of-day for an epoch-ms instant. */
function localParts(now: number): { day: Weekday; minute: number } {
  const d = new Date(now);
  return { day: d.getDay() as Weekday, minute: d.getHours() * 60 + d.getMinutes() };
}

/** True when `now` falls inside any band (handles midnight wrap and day rollover). */
export function inAnyBand(bands: Band[], now: number): boolean {
  const { day, minute } = localParts(now);
  const prevDay = ((day + 6) % 7) as Weekday;
  for (const b of bands) {
    if (b.endMin > b.startMin) {
      // same-day band
      if (b.days.includes(day) && minute >= b.startMin && minute < b.endMin) return true;
    } else {
      // wraps past midnight: [start,1440) on the start day, [0,end) on the next day
      if (b.days.includes(day) && minute >= b.startMin) return true;
      if (b.days.includes(prevDay) && minute < b.endMin) return true;
    }
  }
  return false;
}

/** The subset of a site the blocking decision needs. */
export interface Blockable {
  pauseUntil: number | null;
  pendingDeleteAt: number | null;
  schedule?: Schedule;
}

/**
 * The authoritative "is this site blocked right now" decision, combining an
 * active pause (always wins), a pending delete (blocks until it runs), and the
 * weekly schedule.
 */
export function isBlockedNow(site: Blockable, now: number): boolean {
  if (site.pauseUntil !== null && site.pauseUntil > now) return false;
  if (site.pendingDeleteAt !== null) return true;
  return isBlockedBySchedule(site.schedule ?? ALWAYS, now);
}

/** Whether the schedule alone (ignoring pause/delete) blocks at `now`. */
export function isBlockedBySchedule(schedule: Schedule, now: number): boolean {
  const s = normalizeSchedule(schedule);
  switch (s.mode) {
    case 'always': return true;
    case 'scheduled_block': return inAnyBand(s.bands, now);
    case 'scheduled_allow': return !inAnyBand(s.bands, now);
  }
}

/**
 * A KÖVETKEZŐ pillanat (epoch ms), amikor a menetrend enged — vagy 0, ha egy
 * héten belül sincs ilyen (a mindig tiltó menetrend sosem nyit magától).
 *
 * Perchatáron lépked, és minden lépésnél MAGÁT A DÖNTÉST kérdezi
 * (isBlockedBySchedule) — nem másolja le a sáv-számtant. Így óraátállásnál
 * is pontosan azt mondja, amit a tiltás tenni fog, mert ugyanazt kérdezi.
 * Az ára legfeljebb nyolc napnyi perc egy sosem nyíló menetrendre; azt a
 * mód-ellenőrzés úgyis levágja.
 */
export function nextOpenAt(schedule: Schedule, now: number): number {
  const s = normalizeSchedule(schedule);
  if (s.mode === 'always') return 0;
  if (!isBlockedBySchedule(s, now)) return now;
  const start = new Date(now);
  start.setSeconds(0, 0);
  let t = start.getTime();
  // Nyolc napnyi perc: óraátállással együtt is bőven egy teljes hét. Ha ez
  // alatt sincs nyitás, a menetrend gyakorlatilag mindig tilt.
  for (let i = 0; i < 8 * 24 * 60; i++) {
    t += 60_000;
    if (!isBlockedBySchedule(s, t)) return t;
  }
  return 0;
}

/**
 * Would switching from `oldS` to `newS` reduce blocked time at any point in the
 * next 7 days? If yes, the change is a "loosening" and must be gated behind
 * unlock challenges.
 *
 * Sampled every minute, not every 15: bands are specified in whole minutes, so
 * a minute step cannot step over any window this data model can express. A
 * coarser step let a short recurring free window (say 13 minutes a day) install
 * with no friction at all, which defeats the whole point of the gate. 10 080
 * cheap evaluations, and only on a schedule change.
 */
export function isLoosening(oldS: Schedule, newS: Schedule, now: number): boolean {
  const a = normalizeSchedule(oldS);
  const b = normalizeSchedule(newS);
  const STEP = 60_000;
  const SAMPLES = 7 * 24 * 60; // one week, minute by minute
  for (let i = 0; i < SAMPLES; i++) {
    const t = now + i * STEP;
    if (isBlockedBySchedule(a, t) && !isBlockedBySchedule(b, t)) return true;
  }
  return false;
}

/** Common presets for the UI. Times are local-clock minutes. */
export const PRESET_BANDS: Record<string, Band> = {
  workHours: { days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 17 * 60 },
  evening: { days: [0, 1, 2, 3, 4, 5, 6], startMin: 22 * 60, endMin: 6 * 60 }, // wraps
  weekend: { days: [0, 6], startMin: 0, endMin: 1440 },
};
