// Session referee. Challenge generation and answer validation happen HERE,
// inside the privileged helper — the GUI only renders what it is told and
// forwards answers, so there is no "just flip the flag" shortcut in the UI.

import {
  applyAnswer, computeTier, cryptoRng, generatePlan, toDisplay,
  CLAIM_WINDOW_MS, DELETE_PENDING_MS, SESSION_MAX_AGE_MS,
} from '../shared/challenges';
import type { SessionInfo, SubmitResult, SetScheduleResult } from '../shared/protocol';
import { PAUSE_CHOICES_MIN } from '../shared/protocol';
import { isLoosening, normalizeSchedule, ALWAYS, type Schedule } from '../shared/schedule';
import type { HelperState, SessionRec } from './state';
import { newId } from './state';

const rng = cryptoRng();

export class RefereeError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

function sessionInfo(s: SessionRec, now: number): SessionInfo {
  return {
    id: s.id,
    kind: s.kind,
    siteId: s.siteId,
    minutes: s.minutes,
    stepIndex: s.stepIndex,
    stepCount: s.steps.length,
    current: toDisplay(s.steps[s.stepIndex], now),
  };
}

/** Stamps timing state when a step becomes current (DELAY target, MEMORY show window). */
function armCurrent(s: SessionRec, now: number): void {
  const step = s.steps[s.stepIndex];
  if (!step) return;
  if (step.type === 'DELAY' && step.claimableAt === null) {
    step.claimableAt = now + step.minutes * 60_000;
  }
  if (step.type === 'MEMORY' && step.armedAt === null) {
    step.armedAt = now;
  }
}

export function currentSession(state: HelperState): SessionInfo | null {
  return state.session ? sessionInfo(state.session, Date.now()) : null;
}

export function effectiveTier(state: HelperState, kind: 'pause' | 'delete', now: number): number {
  const base = computeTier(state.unlockLog, now);
  return kind === 'delete' ? Math.min(3, base + 1) : base;
}

export function startSession(
  state: HelperState, kind: 'pause' | 'delete', siteId: string,
  minutes: number | undefined, now: number,
): SessionInfo {
  const site = state.sites.find((s) => s.id === siteId);
  if (!site) throw new RefereeError('Ismeretlen oldal.', 'NO_SITE');
  if (kind === 'pause') {
    if (!minutes || !PAUSE_CHOICES_MIN.includes(minutes)) {
      throw new RefereeError('Érvénytelen szünet-hossz.', 'BAD_MINUTES');
    }
    if (site.pauseUntil !== null && site.pauseUntil > now) {
      throw new RefereeError('Ez az oldal most éppen fel van oldva.', 'ALREADY_PAUSED');
    }
  }
  if (kind === 'delete' && site.pendingDeleteAt !== null) {
    throw new RefereeError('Ennek az oldalnak már folyamatban van a törlése.', 'ALREADY_DELETING');
  }
  // Starting a new attempt abandons any previous one — progress is never banked.
  const tier = effectiveTier(state, kind, now);
  const plan = generatePlan(kind, tier, state.lastCombo, rng);
  state.session = {
    id: newId('ses'),
    kind, siteId, minutes,
    steps: plan.steps,
    stepIndex: 0,
    createdAt: now,
  };
  state.lastCombo = plan.comboKey;
  armCurrent(state.session, now);
  return sessionInfo(state.session, now);
}

function finishSession(state: HelperState, now: number): void {
  const s = state.session!;
  const site = state.sites.find((x) => x.id === s.siteId);
  if (site) {
    if (s.pendingSchedule) site.schedule = s.pendingSchedule;   // gated loosening
    else if (s.kind === 'pause') site.pauseUntil = now + (s.minutes ?? 15) * 60_000;
    else site.pendingDeleteAt = now + DELETE_PENDING_MS;
  }
  state.unlockLog = [...state.unlockLog.filter((t) => t > now - 30 * 24 * 3600_000), now];
  state.session = null;
}

/**
 * Change a site's weekly schedule. Tightening (more blocked time) applies
 * immediately; loosening (less blocked time) requires completing the same
 * challenges as a pause, so a schedule edit can never be a friction bypass.
 */
export function startScheduleChange(
  state: HelperState, siteId: string, schedule: Schedule, now: number,
): SetScheduleResult {
  const site = state.sites.find((s) => s.id === siteId);
  if (!site) throw new RefereeError('Ismeretlen oldal.', 'NO_SITE');
  if (state.session) throw new RefereeError('Előbb fejezd be a folyamatban lévő kísérletet.', 'BUSY');
  const next = normalizeSchedule(schedule);
  const current = normalizeSchedule(site.schedule ?? ALWAYS);
  if (!isLoosening(current, next, now)) {
    site.schedule = next; // tightening / neutral -> free
    return { applied: true, session: null };
  }
  // loosening -> gate behind challenges (pause-tier), applied on completion
  const tier = effectiveTier(state, 'pause', now);
  const plan = generatePlan('pause', tier, state.lastCombo, rng);
  state.session = {
    id: newId('ses'), kind: 'pause', siteId,
    steps: plan.steps, stepIndex: 0, createdAt: now,
    pendingSchedule: next,
  };
  state.lastCombo = plan.comboKey;
  armCurrent(state.session, now);
  return { applied: false, session: sessionInfo(state.session, now) };
}

export function submitAnswer(state: HelperState, sessionId: string, answer: string, now: number): SubmitResult {
  const s = requireSession(state, sessionId, now);
  const step = s.steps[s.stepIndex];
  if (step.type === 'DELAY') {
    throw new RefereeError('Ez a lépés várakozás — a „Feloldás átvétele” gombbal zárható.', 'DELAY_STEP');
  }
  const tier = effectiveTier(state, s.kind, s.createdAt);
  const outcome = applyAnswer(step, answer, tier, s.kind, rng, now);
  s.steps[s.stepIndex] = outcome.step;
  if (outcome.ok && outcome.done) {
    s.stepIndex += 1;
    if (s.stepIndex >= s.steps.length) {
      finishSession(state, now);
      return { accepted: true, sessionDone: true, session: null };
    }
    armCurrent(s, now);
    return { accepted: true, sessionDone: false, session: sessionInfo(s, now) };
  }
  // A failed answer can hand back a REGENERATED step (a new memory code, a new
  // sentence). It has to be armed too, or a MEMORY step would sit there with no
  // armedAt: the code is never shown and every answer is refused as premature —
  // the challenge becomes unsolvable.
  armCurrent(s, now);
  return { accepted: outcome.ok, sessionDone: false, message: outcome.message, session: sessionInfo(s, now) };
}

export function claimDelay(state: HelperState, sessionId: string, now: number): SubmitResult {
  const s = requireSession(state, sessionId, now);
  const step = s.steps[s.stepIndex];
  if (step.type !== 'DELAY' || step.claimableAt === null) {
    throw new RefereeError('Most nem várakozási lépés van.', 'NOT_DELAY');
  }
  if (now < step.claimableAt) {
    const remainMin = Math.ceil((step.claimableAt - now) / 60_000);
    return {
      accepted: false, sessionDone: false,
      message: `Még ${remainMin} percet várni kell.`, session: sessionInfo(s, now),
    };
  }
  if (now > step.claimableAt + CLAIM_WINDOW_MS) {
    state.session = null;
    throw new RefereeError(
      'Lecsúsztál az átvételi ablakról — a feloldási kísérlet érvénytelen, elölről kell kezdeni.',
      'CLAIM_EXPIRED',
    );
  }
  s.stepIndex += 1;
  if (s.stepIndex >= s.steps.length) {
    finishSession(state, now);
    return { accepted: true, sessionDone: true, session: null };
  }
  armCurrent(s, now);
  return { accepted: true, sessionDone: false, session: sessionInfo(s, now) };
}

export function abandonSession(state: HelperState, sessionId: string): void {
  if (state.session && state.session.id === sessionId) state.session = null;
}

function requireSession(state: HelperState, sessionId: string, now: number): SessionRec {
  const s = state.session;
  if (!s || s.id !== sessionId) throw new RefereeError('Nincs ilyen aktív feloldási kísérlet.', 'NO_SESSION');
  if (now - s.createdAt > SESSION_MAX_AGE_MS) {
    state.session = null;
    throw new RefereeError('A feloldási kísérlet lejárt, kezdd elölről.', 'SESSION_EXPIRED');
  }
  return s;
}

/**
 * Periodic housekeeping: expire stale sessions, expire missed DELAY claims,
 * re-lock ended pauses and execute due deletions.
 * Returns true when the blocklist needs re-applying.
 */
export function tick(state: HelperState, now: number): boolean {
  let dirty = false;
  const s = state.session;
  if (s) {
    const step = s.steps[s.stepIndex];
    const missedClaim = step?.type === 'DELAY' && step.claimableAt !== null
      && now > step.claimableAt + step.claimWindowMs;
    if (missedClaim || now - s.createdAt > SESSION_MAX_AGE_MS) state.session = null;
  }
  for (const site of state.sites) {
    if (site.pauseUntil !== null && site.pauseUntil <= now) {
      site.pauseUntil = null;
      dirty = true;
    }
  }
  const before = state.sites.length;
  state.sites = state.sites.filter((site) => site.pendingDeleteAt === null || site.pendingDeleteAt > now);
  if (state.sites.length !== before) dirty = true;
  return dirty;
}
