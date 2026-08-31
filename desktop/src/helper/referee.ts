// Session referee. Challenge generation and answer validation happen HERE,
// inside the privileged helper — the GUI only renders what it is told and
// forwards answers, so there is no "just flip the flag" shortcut in the UI.

import {
  applyAnswer, computeTier, comboKeyOf, cryptoRng, generatePlan, toDisplay,
  CLAIM_WINDOW_MS, DELETE_PENDING_MS, SESSION_MAX_AGE_MS, REROLL_COOLDOWN_MS,
} from '../shared/challenges';
import type {
  SessionInfo, SubmitResult, SetScheduleResult, SetLimitResult, SetRuleResult,
} from '../shared/protocol';
import { PAUSE_CHOICES_MIN } from '../shared/protocol';
import { isLoosening, normalizeSchedule, ALWAYS, type Schedule } from '../shared/schedule';
import { isBurstLoosening, normalizeBurst } from '../shared/burst';
import { isLimitLoosening, normalizeLimit } from '../shared/limits';
import {
  isFilterLoosening, sanitizeFilter, MAX_CHANNEL_FILTERS, type ChannelFilter,
} from '../shared/channels';
import { MAX_RULES_PER_SITE, sameRule, type UrlRule } from '../shared/urlrules';
import {
  closeIfEnded, closeRun, isRunning, isSessionLoosening, MAX_FOCUS_LOG, normalizeMinutes,
  type FocusPack, type FocusRun,
} from '../shared/focus';
import type { AbandonRec, HelperState, SessionRec } from './state';
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
  // Starting a new attempt abandons any previous one — progress is never
  // banked, and the abandoned attempt's challenge types are remembered so this
  // is not a way to shop for an easier pair.
  dropSession(state, now);
  const tier = effectiveTier(state, kind, now);
  const plan = generatePlan(kind, tier, state.lastCombo, rng, forcedCombo(state, siteId, now));
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

/**
 * Egy lezárult munkamenet a naplóba.
 *
 * A csomag NEVÉT is elmentjük, nem csak az azonosítóját: a csomag azóta
 * átnevezhető vagy törölhető, és egy statisztika, ami „ismeretlen csomag”-ot
 * ír ki a múlt hétre, semmit nem ér.
 */
function logFocusEnd(state: HelperState, endedAt: number, stopped: boolean): void {
  const run = state.focusRun;
  if (!run) return;
  const pack = (state.focusPacks ?? []).find((p) => p.id === run.packId);
  const entry = closeRun(run, pack?.name ?? 'Ismeretlen csomag', endedAt, stopped);
  state.focusLog = [...(state.focusLog ?? []), entry].slice(-MAX_FOCUS_LOG);
}

function finishSession(state: HelperState, now: number): void {
  const s = state.session!;
  // A munkamenet nem egy OLDALHOZ tartozik, hanem az egész géphez: ezért itt
  // áll, a site-keresés előtt. A -1 azt jelenti: állítsd le most.
  if (s.pendingFocusEnd !== undefined) {
    if (s.pendingFocusEnd < 0) {
      // A naplót ITT írjuk, nem a `tick`-ben: csak innen derül ki, hogy a menet
      // PRÓBATÉTELLEL ért véget, nem magától. A kettő nem ugyanaz a mondat.
      logFocusEnd(state, now, true);
      state.focusRun = null;
    } else if (state.focusRun) {
      state.focusRun = { ...state.focusRun, endsAt: s.pendingFocusEnd };
    }
    state.unlockLog = [...state.unlockLog.filter((t) => t > now - 30 * 24 * 3600_000), now];
    state.session = null;
    state.abandons = (state.abandons ?? []).filter((a) => a.siteId !== s.siteId);
    return;
  }
  // A csatorna-szűrő sem egy OLDALHOZ tartozik: a saját listáján él, a
  // site-keresés előtt kell alkalmazni — különben a „nincs ilyen oldal” ágon
  // némán elveszne a kifizetett lazítás.
  if (s.pendingChannelFilter) {
    const p = s.pendingChannelFilter;
    const list = state.channelFilters ?? [];
    state.channelFilters = p.next === null
      ? list.filter((f) => f.id !== p.id)
      : list.map((f) => (f.id === p.id ? p.next! : f));
    state.unlockLog = [...state.unlockLog.filter((t) => t > now - 30 * 24 * 3600_000), now];
    state.session = null;
    state.abandons = (state.abandons ?? []).filter((a) => a.siteId !== s.siteId);
    return;
  }
  const site = state.sites.find((x) => x.id === s.siteId);
  if (site) {
    if (s.pendingSchedule) site.schedule = s.pendingSchedule;                  // gated loosening
    else if (s.pendingRuleRemoval) {
      const drop = s.pendingRuleRemoval;
      site.rules = (site.rules ?? []).filter((r) => !sameRule(r, drop));
    } else if (s.pendingLimit !== undefined) {
      site.dailyLimitSeconds = s.pendingLimit === null ? undefined : s.pendingLimit;
    } else if (s.pendingBurst !== undefined) {
      site.burstSeconds = s.pendingBurst?.burstSeconds ?? undefined;
      site.cooldownSeconds = s.pendingBurst?.cooldownSeconds ?? undefined;
    } else if (s.kind === 'pause') site.pauseUntil = now + (s.minutes ?? 15) * 60_000;
    else site.pendingDeleteAt = now + DELETE_PENDING_MS;
  }
  state.unlockLog = [...state.unlockLog.filter((t) => t > now - 30 * 24 * 3600_000), now];
  state.session = null;
  // Solved: this site's debt is paid, its next attempt draws freely again (and
  // the variety rule keeps it different from this one). Other sites keep theirs.
  state.abandons = (state.abandons ?? []).filter((a) => a.siteId !== s.siteId);
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
  const plan = generatePlan('pause', tier, state.lastCombo, rng, forcedCombo(state, siteId, now));
  state.session = {
    id: newId('ses'), kind: 'pause', siteId,
    steps: plan.steps, stepIndex: 0, createdAt: now,
    pendingSchedule: next,
  };
  state.lastCombo = plan.comboKey;
  armCurrent(state.session, now);
  return { applied: false, session: sessionInfo(state.session, now) };
}

/**
 * Change a site's daily budget. Introducing or lowering it is a tightening and
 * applies immediately; raising or removing it buys time on the site, so it goes
 * through the same challenges as a pause — the same rule the weekly schedule
 * follows, for the same reason.
 */
export function startLimitChange(
  state: HelperState, siteId: string, seconds: number | null, now: number,
): SetLimitResult {
  const site = state.sites.find((s) => s.id === siteId);
  if (!site) throw new RefereeError('Ismeretlen oldal.', 'NO_SITE');
  if (state.session) throw new RefereeError('Előbb fejezd be a folyamatban lévő kísérletet.', 'BUSY');
  const next = normalizeLimit(seconds);
  const current = normalizeLimit(site.dailyLimitSeconds);
  if (!isLimitLoosening(current, next)) {
    site.dailyLimitSeconds = next ?? undefined;
    return { applied: true, session: null };
  }
  const tier = effectiveTier(state, 'pause', now);
  const plan = generatePlan('pause', tier, state.lastCombo, rng, forcedCombo(state, siteId, now));
  state.session = {
    id: newId('ses'), kind: 'pause', siteId,
    steps: plan.steps, stepIndex: 0, createdAt: now,
    pendingLimit: next === null ? null : next,
  };
  state.lastCombo = plan.comboKey;
  armCurrent(state.session, now);
  return { applied: false, session: sessionInfo(state.session, now) };
}

/**
 * Az adag-szabály cseréje: ennyi használat után ennyi szünet.
 *
 * Ugyanaz az irányszabály, mint a napi keretnél: felvenni, kisebb adagra vagy
 * hosszabb szünetre állítani ingyen lehet; nagyobb adag, rövidebb szünet vagy
 * a szabály levétele több oldalt ad vissza, tehát próbatételbe kerül.
 *
 * A futó hűtést a csere NEM engedi el: azt az addigi használat kereste meg,
 * és magától lejár — a szabály cseréje a KÖVETKEZŐ adagra szól.
 */
export function startBurstChange(
  state: HelperState, siteId: string,
  burstSeconds: number | null, cooldownSeconds: number | null, now: number,
): SetLimitResult {
  const site = state.sites.find((s) => s.id === siteId);
  if (!site) throw new RefereeError('Ismeretlen oldal.', 'NO_SITE');
  if (state.session) throw new RefereeError('Előbb fejezd be a folyamatban lévő kísérletet.', 'BUSY');
  const next = normalizeBurst(burstSeconds, cooldownSeconds);
  // FÉL-KITÖLTÖTT kérés: az egyik szám hiányzik vagy értelmetlen, a másik nem.
  // Ezt nem értelmezzük se törlésnek, se szabálynak — a hívó kap hibát, nem
  // egy meglepetést.
  if (next === null && (burstSeconds !== null || cooldownSeconds !== null)) {
    throw new RefereeError('Az adaghoz mindkét szám kell: használat is, szünet is.', 'BAD_BURST');
  }
  const current = normalizeBurst(site.burstSeconds, site.cooldownSeconds);
  if (!isBurstLoosening(current, next)) {
    site.burstSeconds = next?.burstSeconds ?? undefined;
    site.cooldownSeconds = next?.cooldownSeconds ?? undefined;
    return { applied: true, session: null };
  }
  const tier = effectiveTier(state, 'pause', now);
  const plan = generatePlan('pause', tier, state.lastCombo, rng, forcedCombo(state, siteId, now));
  state.session = {
    id: newId('ses'), kind: 'pause', siteId,
    steps: plan.steps, stepIndex: 0, createdAt: now,
    pendingBurst: next,
  };
  state.lastCombo = plan.comboKey;
  armCurrent(state.session, now);
  return { applied: false, session: sessionInfo(state.session, now) };
}

/**
 * Csatorna-szűrő mentése (új vagy meglévő cseréje).
 *
 * A szabály ugyanaz, mint a menetrendnél és a napi keretnél: a SZIGORÍTÁS
 * ingyen van (új szűrő, bekapcsolás, engedélyezett csatorna levétele), a
 * LAZÍTÁS próbatétel (kikapcsolás, új engedélyezett csatorna bekapcsolt
 * szűrőn, gazdagép-csere). A felhasználó kifejezetten ezt kérte: kapcsolható,
 * mint a munkamenet — és a munkamenetet leállítani sem egy gomb.
 */
export function startChannelFilterSave(
  state: HelperState, raw: { id?: string; host: string; allow: string[]; enabled: boolean },
  now: number,
): SetRuleResult {
  if (state.session) throw new RefereeError('Előbb fejezd be a folyamatban lévő kísérletet.', 'BUSY');
  const clean = sanitizeFilter(raw);
  if (!clean) {
    throw new RefereeError(
      'A szűrőhöz oldal (pl. youtube.com) és legalább egy érvényes csatorna kell '
      + '(pl. @csatornanev vagy a csatorna címe).', 'BAD_FILTER',
    );
  }
  const list = state.channelFilters ?? [];
  const current = raw.id ? list.find((f) => f.id === raw.id) : undefined;
  if (raw.id && !current) throw new RefereeError('Nincs ilyen csatorna-szűrő.', 'NO_FILTER');
  // Egy oldalra EGY szűrő: két lista ugyanarra a gazdagépre azt jelentené,
  // hogy az egyik engedélyez, a másik tilt, és a sorrendjük döntene — némán.
  const clash = list.find((f) => f.host === clean.host && f.id !== current?.id);
  if (clash) throw new RefereeError('Erre az oldalra már van csatorna-szűrő.', 'DUP_FILTER');
  if (!current && list.length >= MAX_CHANNEL_FILTERS) {
    throw new RefereeError('Ennyi szűrő elég is — előbb törölj egyet.', 'TOO_MANY');
  }
  const next: ChannelFilter = { id: current?.id ?? newId('chf'), ...clean };
  if (!isFilterLoosening(current, clean)) {
    state.channelFilters = current
      ? list.map((f) => (f.id === current.id ? next : f))
      : [...list, next];
    return { applied: true, session: null };
  }
  const tier = effectiveTier(state, 'pause', now);
  const plan = generatePlan('pause', tier, state.lastCombo, rng, forcedCombo(state, next.id, now));
  state.session = {
    id: newId('ses'), kind: 'pause', siteId: next.id,
    steps: plan.steps, stepIndex: 0, createdAt: now,
    pendingChannelFilter: { id: next.id, next },
  };
  state.lastCombo = plan.comboKey;
  armCurrent(state.session, now);
  return { applied: false, session: sessionInfo(state.session, now) };
}

/**
 * Csatorna-szűrő törlése. Kikapcsolt szűrőé ingyen (nem tilt semmit);
 * bekapcsolté lazítás — a szűrő eltűnésével minden csatorna kinyílna.
 */
export function startChannelFilterDelete(
  state: HelperState, id: string, now: number,
): SetRuleResult {
  if (state.session) throw new RefereeError('Előbb fejezd be a folyamatban lévő kísérletet.', 'BUSY');
  const list = state.channelFilters ?? [];
  const current = list.find((f) => f.id === id);
  if (!current) throw new RefereeError('Nincs ilyen csatorna-szűrő.', 'NO_FILTER');
  if (!current.enabled) {
    state.channelFilters = list.filter((f) => f.id !== id);
    return { applied: true, session: null };
  }
  const tier = effectiveTier(state, 'pause', now);
  const plan = generatePlan('pause', tier, state.lastCombo, rng, forcedCombo(state, id, now));
  state.session = {
    id: newId('ses'), kind: 'pause', siteId: id,
    steps: plan.steps, stepIndex: 0, createdAt: now,
    pendingChannelFilter: { id, next: null },
  };
  state.lastCombo = plan.comboKey;
  armCurrent(state.session, now);
  return { applied: false, session: sessionInfo(state.session, now) };
}

/**
 * Részleges szabály felvétele vagy levétele.
 *
 * Ugyanaz a szabály, mint mindenhol: a SZIGORÍTÁS ingyen van, a LAZÍTÁS
 * próbatétel. Egy szabály felvétele szigorítás (kevesebb érhető el), a levétele
 * lazítás — és ha az egy gomb lenne, a részleges tiltás pont annyit érne, mint
 * egy kikapcsoló.
 *
 * A szabályt a hívó adja már normalizálva; itt csak a döntés van.
 */
export function startRuleChange(
  state: HelperState, siteId: string, rule: UrlRule, remove: boolean, now: number,
): SetRuleResult {
  const site = state.sites.find((s) => s.id === siteId);
  if (!site) throw new RefereeError('Ismeretlen oldal.', 'NO_SITE');
  const rules = site.rules ?? [];

  if (!remove) {
    if (rules.some((r) => sameRule(r, rule))) {
      return { applied: true, session: null }; // már ott van; nincs mit tenni
    }
    if (rules.length >= MAX_RULES_PER_SITE) {
      throw new RefereeError(
        `Egy oldalhoz legfeljebb ${MAX_RULES_PER_SITE} részleges szabály tartozhat.`,
        'TOO_MANY_RULES',
      );
    }
    site.rules = [...rules, rule];
    return { applied: true, session: null };
  }

  if (!rules.some((r) => sameRule(r, rule))) {
    throw new RefereeError('Nincs ilyen részleges szabály ezen az oldalon.', 'NO_RULE');
  }
  if (state.session) throw new RefereeError('Előbb fejezd be a folyamatban lévő kísérletet.', 'BUSY');

  const tier = effectiveTier(state, 'pause', now);
  const plan = generatePlan('pause', tier, state.lastCombo, rng, forcedCombo(state, siteId, now));
  state.session = {
    id: newId('ses'), kind: 'pause', siteId,
    steps: plan.steps, stepIndex: 0, createdAt: now,
    pendingRuleRemoval: rule,
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
    dropSession(state, now);
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
  if (state.session && state.session.id === sessionId) dropSession(state, Date.now());
}

/**
 * Drops the running attempt and remembers WHAT it was, so restarting within the
 * cooldown gets the same challenge types back. Cancelling is always allowed —
 * it just must not be a cheaper route than finishing.
 */
function dropSession(state: HelperState, now: number): void {
  const s = state.session;
  if (!s) return;
  const combo = comboKeyOf(s.steps.filter((st) => st.type !== 'DELAY').map((st) => st.type));
  const live = liveAbandons(state, now);
  // The cooldown runs from the FIRST time this pair was given up on, not from
  // the latest restart. Otherwise every restart would push the deadline out and
  // the pair would stick to the site forever, which is not what is promised.
  const prev = live.find((a) => a.siteId === s.siteId);
  const at = prev && prev.comboKey === combo ? prev.at : now;
  state.abandons = [
    ...live.filter((a) => a.siteId !== s.siteId),
    { siteId: s.siteId, kind: s.kind, comboKey: combo, at },
  ];
  state.session = null;
}

/** Abandon debts that are still inside their cooldown (and bounded in number). */
function liveAbandons(state: HelperState, now: number): AbandonRec[] {
  const all = Array.isArray(state.abandons) ? state.abandons : [];
  return all
    .filter((a) => a && typeof a.siteId === 'string' && typeof a.comboKey === 'string'
      && Number.isFinite(a.at) && now >= a.at && now - a.at <= REROLL_COOLDOWN_MS)
    .slice(-MAX_ABANDONS);
}

/**
 * The combo an abandoned attempt still owes, if the cooldown has not run out.
 *
 * The KIND is deliberately not compared: pause and delete draw from the same
 * pool, so letting a cancelled delete hand back a fresh pair for the pause flow
 * would just be the re-roll with an extra click.
 */
function forcedCombo(state: HelperState, siteId: string, now: number): string | null {
  const a = liveAbandons(state, now).find((x) => x.siteId === siteId);
  return a ? a.comboKey : null;
}

/** How many sites may carry a debt at once — a week of cancels cannot grow state. */
const MAX_ABANDONS = 64;

function requireSession(state: HelperState, sessionId: string, now: number): SessionRec {
  const s = state.session;
  if (!s || s.id !== sessionId) throw new RefereeError('Nincs ilyen aktív feloldási kísérlet.', 'NO_SESSION');
  if (now - s.createdAt > SESSION_MAX_AGE_MS) {
    dropSession(state, now);
    throw new RefereeError('A feloldási kísérlet lejárt, kezdd elölről.', 'SESSION_EXPIRED');
  }
  return s;
}

/**
 * Periodic housekeeping: expire stale sessions, expire missed DELAY claims,
 * re-lock ended pauses and execute due deletions.
 * Returns true when the blocklist needs re-applying.
 */
/**
 * A jump bigger than this between two housekeeping ticks is not elapsed time.
 * The loop runs every few seconds, so anything past a couple of minutes is
 * either the clock being moved or the machine having been asleep.
 */
export const CLOCK_JUMP_THRESHOLD_MS = 2 * 60_000;

/**
 * Waiting is a challenge here, and a challenge that a clock change defeats is
 * not a challenge: setting the system clock forward would make a DELAY step
 * claimable at once and a pending deletion run early. So the deadlines that
 * PROTECT (the waiting target, its claim window, a pending deletion) are pushed
 * by whatever the wall clock jumped, i.e. they measure elapsed time rather than
 * a date. Suspend/hibernate looks the same from here and is treated the same:
 * the wait does not run while the machine is off, which is the strict side.
 *
 * pauseUntil is deliberately NOT adjusted: a jump that ends an unlock early
 * blocks more, and tightening never needs protecting.
 */
function absorbClockJump(state: HelperState, now: number): void {
  const last = state.lastTickAt;
  state.lastTickAt = now;
  if (last === undefined || !Number.isFinite(last)) return;
  const jump = now - last;
  if (jump <= CLOCK_JUMP_THRESHOLD_MS) return; // ordinary tick cadence

  const shift = jump - CLOCK_JUMP_THRESHOLD_MS;
  const s = state.session;
  if (s) {
    const step = s.steps[s.stepIndex];
    if (step?.type === 'DELAY' && step.claimableAt !== null) step.claimableAt += shift;
    s.createdAt += shift; // …and the attempt does not age out from the jump either
  }
  for (const site of state.sites) {
    if (site.pendingDeleteAt !== null) site.pendingDeleteAt += shift;
  }
  // A FUTÓ MUNKAMENET IS ELTOLÓDIK — enélkül az óra előreállítása ingyen
  // leállítaná. Nyolc órát előreugorva a menet „lejárna”, a számláló léptetne,
  // és a szinkron ezt szét is vinné a többi eszközre: két perc munkával
  // megkerülve az a próbatétel, ami a leállításhoz kellene.
  //
  // A SZABÁLY EGY MONDAT: amennyi hátra volt, annyi van hátra.
  //
  // Ugyanez a válasz az alvásra is, és ez nem véletlen: a segéd nem tudja
  // megkülönböztetni az átállított órát a felfüggesztett géptől, de nem is
  // kell. Ha lecsukod a laptopot tíz perccel a menet vége előtt, reggel tíz
  // perc lesz hátra. Azt a tíz percet nem töltötted fókuszban.
  //
  // A kezdés is tolódik, nem csak a vég: enélkül a naplóba egy ötvenperces
  // menet nyolc és fél órásként kerülne be, és a statisztika hazudna.
  if (state.focusRun) {
    state.focusRun = {
      ...state.focusRun,
      startedAt: state.focusRun.startedAt + shift,
      endsAt: state.focusRun.endsAt + shift,
    };
  }
}

export function tick(state: HelperState, now: number): boolean {
  absorbClockJump(state, now);
  let dirty = false;
  const s = state.session;
  if (s) {
    const step = s.steps[s.stepIndex];
    const missedClaim = step?.type === 'DELAY' && step.claimableAt !== null
      && now > step.claimableAt + step.claimWindowMs;
    // Sitting out the claim window is a way to end an attempt too, so it goes
    // through the same bookkeeping: no reroll out of a pair you dislike.
    if (missedClaim || now - s.createdAt > SESSION_MAX_AGE_MS) dropSession(state, now);
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
  // Az adag-számlálók takarítása: a törölt oldalé, és aminek a hűtése rég
  // lejárt és egy napja nem is gyűlt semmi. E nélkül az állapotfájl lassan,
  // némán hízna — és a hízás pont az a hibafajta, ami sosem hasal el.
  for (const [siteId, b] of Object.entries(state.bursts ?? {})) {
    const gone = !state.sites.some((site) => site.id === siteId);
    const stale = b.cooldownUntil <= now && now - b.lastAt > 24 * 3600_000;
    if (gone || stale) {
      delete state.bursts![siteId];
      dirty = true;
    }
  }
  // A lejárt munkamenetet takarítjuk. A `isRunning` amúgy is hamisat adna rá,
  // de a felület és a bővítmény az állapotot olvassa: egy ottfelejtett rekord
  // örökre futó munkamenetnek látszana.
  // Magától járt le: a naplóba a TERVEZETT vég kerül, nem a mostani idő. A
  // takarítás késhet pár másodpercet, és egy „51 perces” ötvenperces menet
  // apró, de fölösleges hazugság lenne.
  //
  // KÖZÖS függvény, mert a telefonnak is pontosan ez kell — ott is lehet menetet
  // indítani, tehát ott is le kell zárulnia. Ha külön írnánk meg, a két
  // statisztika előbb-utóbb más számot mondana ugyanarról a hétről.
  const closed = closeIfEnded(state.focusRun, state.focusPacks ?? [], state.focusLog, now);
  if (closed) {
    state.focusLog = closed.log;
    state.focusRun = closed.run;
    dirty = true;
  }
  return dirty;
}

// ---------------------------------------------------------------------------
// Munkamenetek
// ---------------------------------------------------------------------------

export interface FocusStartResult {
  run: FocusRun;
}

/**
 * Munkamenet indítása. INGYEN van: ez a szigorítás iránya.
 *
 * Amíg fut egy munkamenet, újat nem lehet indítani. Enélkül a leállítás
 * próbatételét meg lehetne kerülni: indítok egy „minden engedve” csomagot, és
 * kész — a munkamenet egy kattintással semmivé válna.
 */
export function startFocus(
  state: HelperState, packId: string, minutes: number, now: number,
): FocusStartResult {
  const pack = (state.focusPacks ?? []).find((p) => p.id === packId);
  if (!pack) throw new RefereeError('Ismeretlen csomag.', 'NO_PACK');
  if (isRunning(state.focusRun, now)) {
    throw new RefereeError('Már fut egy munkamenet.', 'FOCUS_RUNNING');
  }
  const mins = normalizeMinutes(minutes);
  if (mins === null) throw new RefereeError('Érvénytelen hossz.', 'BAD_MINUTES');
  state.focusRun = { packId, startedAt: now, endsAt: now + mins * 60_000 };
  return { run: state.focusRun };
}

export interface FocusChangeResult {
  applied: boolean;
  session: ReturnType<typeof sessionInfo> | null;
  run: FocusRun | null;
}

/**
 * A futó munkamenet vége odébb tolva — vagy a leállítása.
 *
 * HOSSZABBÍTANI ingyen van, RÖVIDÍTENI és LEÁLLÍTANI próbatételbe kerül.
 * Ugyanaz a szabály, mint mindenhol: enélkül a munkamenet egy „mégsem” gomb
 * lenne, és pont az a lényeg, hogy ne az legyen.
 */
export function changeFocus(
  state: HelperState, nextEndsAt: number | null, now: number,
): FocusChangeResult {
  const run = state.focusRun;
  if (!isRunning(run, now)) throw new RefereeError('Nem fut munkamenet.', 'NO_FOCUS');
  const current = (run as FocusRun).endsAt;
  const next = nextEndsAt === null ? now : nextEndsAt;

  if (!isSessionLoosening(current, next)) {
    state.focusRun = { ...(run as FocusRun), endsAt: next };
    return { applied: true, session: null, run: state.focusRun };
  }
  if (state.session) throw new RefereeError('Előbb fejezd be a folyamatban lévő kísérletet.', 'BUSY');

  const tier = effectiveTier(state, 'pause', now);
  const plan = generatePlan('pause', tier, state.lastCombo, rng, null);
  state.session = {
    id: newId('ses'), kind: 'pause', siteId: `focus:${(run as FocusRun).packId}`,
    steps: plan.steps, stepIndex: 0, createdAt: now,
    // A -1 a „állítsd le most”; a nulla érvényes időpont lenne.
    pendingFocusEnd: nextEndsAt === null ? -1 : nextEndsAt,
  };
  state.lastCombo = plan.comboKey;
  armCurrent(state.session, now);
  return { applied: false, session: sessionInfo(state.session, now), run: state.focusRun ?? null };
}

/**
 * Csomag mentése. Szabadon szerkeszthető — DE nem az, amelyik ÉPP FUT.
 *
 * A futó csomag befagy. Enélkül a fehérlistához menet közben hozzá lehetne
 * adni bármit, és a munkamenet önmagát oldaná fel — csendben, próbatétel
 * nélkül.
 */
export function saveFocusPack(state: HelperState, pack: FocusPack, now: number): FocusPack[] {
  if (isRunning(state.focusRun, now) && state.focusRun?.packId === pack.id) {
    throw new RefereeError(
      'Ez a csomag épp fut — amíg tart, nem szerkeszthető.', 'FOCUS_RUNNING',
    );
  }
  const packs = [...(state.focusPacks ?? [])];
  const at = packs.findIndex((p) => p.id === pack.id);
  if (at >= 0) packs[at] = pack;
  else packs.push(pack);
  state.focusPacks = packs;
  return packs;
}

export function deleteFocusPack(state: HelperState, packId: string, now: number): FocusPack[] {
  if (isRunning(state.focusRun, now) && state.focusRun?.packId === packId) {
    throw new RefereeError('Ez a csomag épp fut — előbb állítsd le.', 'FOCUS_RUNNING');
  }
  state.focusPacks = (state.focusPacks ?? []).filter((p) => p.id !== packId);
  return state.focusPacks;
}
