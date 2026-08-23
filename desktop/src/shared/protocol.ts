// Wire protocol between the GUI app and the privileged helper.
// Newline-delimited JSON over a unix domain socket (macOS) / named pipe (Windows).

export type ChallengeType = 'TRANSCRIBE' | 'MATH_CHAIN' | 'MEMORY' | 'REVERSE' | 'DELAY';

/** What the UI is allowed to see about the current step. Never contains expected answers. */
export interface StepDisplay {
  id: string;
  type: ChallengeType;
  /** TRANSCRIBE / REVERSE: the text to work from. */
  text?: string;
  /** MATH_CHAIN: current problem and position. */
  math?: { question: string; index: number; total: number };
  /** MEMORY: server-armed timing. `code` is only present while the show window
   *  is open (armedAt + showMs); afterwards the server stops shipping it. */
  memory?: { code: string | null; showMs: number; waitMs: number; armedAt: number | null };
  /** DELAY: when the claim window opens/closes (epoch ms). */
  delay?: { minutes: number; claimableAt: number | null; claimWindowMs: number };
}

export interface SessionInfo {
  id: string;
  kind: 'pause' | 'delete';
  siteId: string;
  /** pause length that was requested (minutes), pause sessions only */
  minutes?: number;
  stepIndex: number;
  stepCount: number;
  current: StepDisplay;
}

export interface SiteInfo {
  id: string;
  domain: string;
  hostnames: string[];
  addedAt: number;
  /** epoch ms until which blocking is paused, or null when actively blocked */
  pauseUntil: number | null;
  /** epoch ms when the site will actually be deleted, or null */
  pendingDeleteAt: number | null;
  /** weekly schedule (absent = always blocked) */
  schedule?: import('./schedule').Schedule;
  /** whether the site is blocked at status time (pause + delete + schedule) */
  blockedNow: boolean;
}

export interface StatusData {
  helperVersion: string;
  platform: string;
  sites: SiteInfo[];
  /** difficulty tier 0..3 derived from recent unlocks */
  tier: number;
  unlocks7d: number;
  session: SessionInfo | null;
  dohPolicyApplied: boolean;
  /** whether active-time measurement is switched on */
  usageEnabled: boolean;
  now: number;
}

export type HelperRequest =
  | { id: number; op: 'status' }
  | { id: number; op: 'add_site'; input: string; usePreset: boolean }
  | { id: number; op: 'start_unlock'; siteId: string; minutes: number }
  | { id: number; op: 'start_delete'; siteId: string }
  | { id: number; op: 'submit'; sessionId: string; answer: string }
  | { id: number; op: 'claim'; sessionId: string }
  | { id: number; op: 'abandon'; sessionId: string }
  | { id: number; op: 'cancel_delete'; siteId: string }
  | { id: number; op: 'relock'; siteId: string }
  | { id: number; op: 'set_schedule'; siteId: string; schedule: import('./schedule').Schedule }
  | { id: number; op: 'usage_batch'; samples: UsageSampleMsg[] }
  | { id: number; op: 'usage_stats'; focusKey?: string }
  | { id: number; op: 'usage_enable'; enabled: boolean }
  | { id: number; op: 'usage_clear' };

/** One recorded slice of active time, as measured by the user-session tracker. */
export interface UsageSampleMsg {
  key: string;
  label: string;
  seconds: number;
  /** epoch ms the slice ended at (decides which day it lands in) */
  at: number;
}

export interface UsageStatsData {
  summary: import('./usage').UsageSummary;
  /** 30-day daily series for the focused target (or the busiest one) */
  focusKey: string | null;
  focusLabel: string;
  focusSeries: { day: string; seconds: number }[];
}

/** Result of a set_schedule request. */
export interface SetScheduleResult {
  /** true when applied immediately (tightening); false when a challenge is required */
  applied: boolean;
  /** present when loosening requires completing challenges first */
  session: SessionInfo | null;
}

export interface SubmitResult {
  accepted: boolean;
  /** true when the whole session finished and the effect was applied */
  sessionDone: boolean;
  message?: string;
  session: SessionInfo | null;
}

export type HelperResponse =
  | { id: number; ok: true; data: unknown }
  | { id: number; ok: false; error: string; code?: string };

export const HELPER_VERSION = '0.1.0';
export const PAUSE_CHOICES_MIN = [15, 30, 60];
