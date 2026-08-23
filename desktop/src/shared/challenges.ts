// Unlock challenge engine ("próbatételek").
//
// Design goals (see docs/challenge-spec.md):
//  - turning a block off must cost real effort, never a single click
//  - it must NOT get easier with practice: content is random every time,
//    the challenge combination varies, and difficulty scales up when the
//    user unlocked often in the last 7 days
//  - permanent removal is the hardest path and only takes effect after 24h
//
// This file is intentionally dependency-free and mirrored 1:1 by
// android/.../core/ChallengeEngine.kt and ios/App/Shared/ChallengeEngine.swift.

import * as crypto from 'crypto';
import type { ChallengeType, StepDisplay } from './protocol';

export interface RNG {
  /** uniform integer in [min, max] inclusive */
  int(min: number, max: number): number;
  pick<T>(arr: T[]): T;
}

export function cryptoRng(): RNG {
  return {
    int: (min, max) => crypto.randomInt(min, max + 1),
    pick: (arr) => arr[crypto.randomInt(0, arr.length)],
  };
}

// ---------------------------------------------------------------- step types

export interface TranscribeStep { id: string; type: 'TRANSCRIBE'; text: string }
export interface MathChainStep {
  id: string; type: 'MATH_CHAIN';
  problems: { q: string; a: number }[];
  pos: number;
}
export interface MemoryStep {
  id: string; type: 'MEMORY'; code: string; showMs: number; waitMs: number;
  /** set by the referee when the step becomes current; timing is enforced
   *  server-side from this stamp, so reopening the UI cannot re-show the code */
  armedAt: number | null;
}
export interface ReverseStep { id: string; type: 'REVERSE'; text: string }
export interface DelayStep {
  id: string; type: 'DELAY'; minutes: number;
  /** set by the referee when the step becomes current */
  claimableAt: number | null;
  claimWindowMs: number;
}
export type Step = TranscribeStep | MathChainStep | MemoryStep | ReverseStep | DelayStep;

// ------------------------------------------------------------------- tiers

/** Unlocks (pauses + delete requests) in the last 7 days -> difficulty tier. */
export function computeTier(unlockLog: number[], now: number): 0 | 1 | 2 | 3 {
  const weekAgo = now - 7 * 24 * 3600_000;
  const n = unlockLog.filter((t) => t >= weekAgo && t <= now).length;
  if (n <= 1) return 0;
  if (n <= 3) return 1;
  if (n <= 6) return 2;
  return 3;
}

export const TIER_PARAMS = {
  transcribeChars: [300, 420, 560, 720],
  mathLen: [3, 5, 7, 9],
  mathFactorMax: [29, 39, 59, 79],
  memoryLen: [8, 10, 12, 14],
  memoryShowMs: [20_000, 18_000, 15_000, 12_000],
  memoryWaitMs: [20_000, 30_000, 40_000, 60_000],
  reverseWords: [4, 6, 8, 10],
  /** [min,max] minutes of forced waiting, pause sessions */
  pauseDelayMin: [[10, 20], [20, 40], [30, 60], [45, 90]],
  /** [min,max] minutes of forced waiting, delete sessions */
  deleteDelayMin: [[15, 30], [30, 50], [45, 80], [60, 120]],
} as const;

export const CLAIM_WINDOW_MS = 10 * 60_000;
export const DELETE_PENDING_MS = 24 * 3600_000;
export const SESSION_MAX_AGE_MS = 6 * 3600_000;

// ------------------------------------------------------------ content pools

const WORDS = (
  'alma bogrács cinege délután erdő füzet gomba határ időjárás jégvirág kanál lámpa ' +
  'macska nyár ösvény patak róka sündisznó tenger utazás vándor zászló asztal bicikli ' +
  'csillag dallam egér felhő gyertya hajnal iskola játék kavics levél mező napraforgó ' +
  'óra pillangó rigó sétány tavasz udvar vonat zongora ablak barlang cipő dombtető ' +
  'este fenyő galamb hegység irány kapu liget malom nádas orgona páfrány rönk sátor ' +
  'tücsök uszoda vihar zápor bálna cseresznye dinnye eper fahéj gesztenye hínár ibolya ' +
  'kagyló lekvár mandula naspolya olajbogyó paprika ribizli szilva tökmag uborka ' +
  'vadkörte zeller bagoly csuka delfin egérke fóka gepárd hiúz jaguár kenguru lajhár ' +
  'medve nyest orrszarvú pele rozmár sakál teve ürge vidra zebra híd torony kastély ' +
  'kikötő könyvtár műhely óváros piactér raktár színház tetőtér várfal zsilip csónak ' +
  'ekevas fűrész gereblye horgony iránytű kalapács létra metsző olló reszelő szögmérő ' +
  'talicska vödör aranyos borongós csendes derűs egyszerű fényes gyors hűvös illatos ' +
  'kerek lassú meleg nyugodt okos pontos ritka sima tiszta vidám zöldes hosszú keskeny ' +
  'magas mély széles apró hatalmas kicsi óriási törékeny erős fürge'
).split(/\s+/);

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no O/0, I/1/L

export function makeSentence(rng: RNG, wordCount: number): string {
  const parts: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    let w = rng.pick(WORDS);
    if (i === 0) w = w.charAt(0).toUpperCase() + w.slice(1);
    else if (rng.int(1, 100) <= 12) w = w.toUpperCase();
    if (i > 0 && i < wordCount - 1 && rng.int(1, 100) <= 18) w += ',';
    parts.push(w);
  }
  if (rng.int(1, 100) <= 25) parts.push(String(rng.int(10, 9999)));
  return parts.join(' ') + rng.pick(['.', '.', '.', '!', '?']);
}

export function makeTranscription(rng: RNG, targetChars: number): string {
  let out = '';
  while (out.length < targetChars) {
    out += (out ? ' ' : '') + makeSentence(rng, rng.int(5, 9));
  }
  return out;
}

export function makeCode(rng: RNG, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[rng.int(0, CODE_ALPHABET.length - 1)];
  return s;
}

export function makeMathProblem(rng: RNG, factorMax: number): { q: string; a: number } {
  const kind = rng.int(0, 2);
  if (kind === 0) {
    const a = rng.int(12, factorMax), b = rng.int(12, factorMax), c = rng.int(100, 999);
    return { q: `${a} × ${b} + ${c}`, a: a * b + c };
  }
  if (kind === 1) {
    const a = rng.int(12, factorMax), b = rng.int(12, factorMax), c = rng.int(100, 999);
    return { q: `${a} × ${b} − ${c}`, a: a * b - c };
  }
  const a = rng.int(23, factorMax + 40), b = rng.int(23, factorMax + 40), c = rng.int(3, 9);
  return { q: `(${a} + ${b}) × ${c}`, a: (a + b) * c };
}

// -------------------------------------------------------------- plan making

const ACTIVE_POOL: ChallengeType[] = ['TRANSCRIBE', 'MATH_CHAIN', 'MEMORY', 'REVERSE'];

let stepSeq = 0;
function stepId(): string {
  stepSeq = (stepSeq + 1) % 1_000_000;
  return `st_${Date.now().toString(36)}_${stepSeq}_${crypto.randomBytes(3).toString('hex')}`;
}

export function makeStep(type: ChallengeType, tier: number, kind: 'pause' | 'delete', rng: RNG): Step {
  const t = Math.max(0, Math.min(3, tier));
  switch (type) {
    case 'TRANSCRIBE':
      return { id: stepId(), type, text: makeTranscription(rng, TIER_PARAMS.transcribeChars[t]) };
    case 'MATH_CHAIN': {
      const n = TIER_PARAMS.mathLen[t];
      const problems = Array.from({ length: n }, () => makeMathProblem(rng, TIER_PARAMS.mathFactorMax[t]));
      return { id: stepId(), type, problems, pos: 0 };
    }
    case 'MEMORY':
      return {
        id: stepId(), type,
        code: makeCode(rng, TIER_PARAMS.memoryLen[t]),
        showMs: TIER_PARAMS.memoryShowMs[t],
        waitMs: TIER_PARAMS.memoryWaitMs[t],
        armedAt: null,
      };
    case 'REVERSE':
      return { id: stepId(), type, text: makeSentence(rng, TIER_PARAMS.reverseWords[t]) };
    case 'DELAY': {
      const [lo, hi] = (kind === 'delete' ? TIER_PARAMS.deleteDelayMin : TIER_PARAMS.pauseDelayMin)[t];
      return { id: stepId(), type, minutes: rng.int(lo, hi), claimableAt: null, claimWindowMs: CLAIM_WINDOW_MS };
    }
  }
}

/**
 * Builds the step list for one unlock/delete attempt:
 *  - two distinct random active challenges (never the same pair twice in a row)
 *  - plus a forced waiting period at tier >= 2, and always for deletions
 */
export function generatePlan(
  kind: 'pause' | 'delete',
  tier: number,
  lastCombo: string | null,
  rng: RNG,
  forceCombo?: string | null,
): { steps: Step[]; comboKey: string } {
  let types: ChallengeType[] | null = parseCombo(forceCombo);
  while (types === null) {
    const pool = [...ACTIVE_POOL];
    // Fisher–Yates with the injected RNG
    for (let i = pool.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const draw = pool.slice(0, 2);
    if (lastCombo === null || comboKeyOf(draw) !== lastCombo) types = draw;
  }
  const comboKey = comboKeyOf(types);
  const steps = types.map((tp) => makeStep(tp, tier, kind, rng));
  if (tier >= 2 || kind === 'delete') steps.push(makeStep('DELAY', tier, kind, rng));
  return { steps, comboKey };
}

export function comboKeyOf(types: ChallengeType[]): string {
  return [...types].sort().join('+');
}

/**
 * A combo key back into its two challenge types, or null if it is not one this
 * build can serve (unknown name, wrong arity — e.g. state written by a newer
 * version). Null means "draw a fresh plan", never "serve something broken".
 */
export function parseCombo(key: string | null | undefined): ChallengeType[] | null {
  if (!key) return null;
  const parts = key.split('+');
  if (parts.length !== 2) return null;
  if (!parts.every((p) => (ACTIVE_POOL as string[]).includes(p))) return null;
  if (parts[0] === parts[1]) return null;
  return parts as ChallengeType[];
}

/**
 * How long an abandoned attempt keeps its challenge types.
 *
 * Without this, cancelling was a free reroll: every new attempt drew a fresh
 * pair, so you could keep restarting until you got the pair you found easiest
 * (say, no MEMORY step with its forced wait). Friction that can be re-rolled is
 * not friction. Within this window the same PAIR comes back — with fresh
 * content, so nothing is banked either: giving up can never make the next try
 * cheaper than finishing this one.
 */
export const REROLL_COOLDOWN_MS = 60 * 60_000;

// -------------------------------------------------------------- validation

export interface AnswerOutcome {
  ok: boolean;
  done: boolean;
  /** possibly regenerated step (fail on MEMORY/REVERSE, progress/reset on MATH_CHAIN) */
  step: Step;
  message?: string;
}

export function reverseString(s: string): string {
  return [...s].reverse().join('');
}

/** Validates one submitted answer against the current (non-DELAY) step. */
export function applyAnswer(
  step: Step, answer: string, tier: number, kind: 'pause' | 'delete', rng: RNG, now: number,
): AnswerOutcome {
  switch (step.type) {
    case 'TRANSCRIBE': {
      if (answer === step.text) return { ok: true, done: true, step };
      return { ok: false, done: false, step, message: 'Nem egyezik karakterre pontosan. Ellenőrizd az írásjeleket és a kis-/nagybetűket.' };
    }
    case 'MATH_CHAIN': {
      const expected = step.problems[step.pos].a;
      const given = Number.parseInt(answer.trim().replace(/\s+/g, ''), 10);
      if (Number.isFinite(given) && given === expected) {
        const next = { ...step, pos: step.pos + 1 };
        if (next.pos >= step.problems.length) return { ok: true, done: true, step: next };
        return { ok: true, done: false, step: next };
      }
      const regenerated = makeStep('MATH_CHAIN', tier, kind, rng);
      return { ok: false, done: false, step: regenerated, message: 'Hibás eredmény — a lánc elölről indul, új feladatokkal.' };
    }
    case 'MEMORY': {
      // Timing is server-authoritative: no answer is accepted until the
      // memorize + forced-wait window has fully elapsed.
      if (step.armedAt === null || now < step.armedAt + step.showMs + step.waitMs) {
        return { ok: false, done: false, step, message: 'Még tart a memorizálás vagy a várakozás — a kivárást nem lehet megúszni.' };
      }
      if (answer.trim().toUpperCase() === step.code) return { ok: true, done: true, step };
      const regenerated = makeStep('MEMORY', tier, kind, rng);
      return { ok: false, done: false, step: regenerated, message: 'Nem ez volt a kód. Új kódot kapsz.' };
    }
    case 'REVERSE': {
      if (answer === reverseString(step.text)) return { ok: true, done: true, step };
      const regenerated = makeStep('REVERSE', tier, kind, rng);
      return { ok: false, done: false, step: regenerated, message: 'Nem pontos a visszafelé gépelés. Új mondatot kapsz.' };
    }
    case 'DELAY':
      return { ok: false, done: false, step, message: 'Ez egy várakozási lépés — itt nincs beírható válasz.' };
  }
}

/** UI projection of a step: strips every expected answer. The MEMORY code is
 *  only included while the server-side show window is open, so reopening the
 *  UI later cannot re-display it. */
export function toDisplay(step: Step, now: number): StepDisplay {
  switch (step.type) {
    case 'TRANSCRIBE':
      return { id: step.id, type: step.type, text: step.text };
    case 'MATH_CHAIN':
      return {
        id: step.id, type: step.type,
        math: { question: step.problems[step.pos].q + ' = ?', index: step.pos, total: step.problems.length },
      };
    case 'MEMORY': {
      const showOpen = step.armedAt !== null && now < step.armedAt + step.showMs;
      return {
        id: step.id, type: step.type,
        memory: {
          code: showOpen ? step.code : null,
          showMs: step.showMs, waitMs: step.waitMs, armedAt: step.armedAt,
        },
      };
    }
    case 'REVERSE':
      return { id: step.id, type: step.type, text: step.text };
    case 'DELAY':
      return {
        id: step.id, type: step.type,
        delay: { minutes: step.minutes, claimableAt: step.claimableAt, claimWindowMs: step.claimWindowMs },
      };
  }
}
