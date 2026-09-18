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
/**
 * PÁRBAN ZÁROLÁS: a terv UTOLSÓ lépése, ha van megbízott — a jelmondatát ő
 * írja be. Nem a sorsolt aktív próbák közül való (a kombináció-kulcsba sem
 * számít), és nem itt ellenőrizzük: a lenyomat a bírónál van, a szabály a
 * `partner.ts`-ben. A `name` a felületnek kell: „Kérd meg Annát”.
 */
export interface PartnerStep { id: string; type: 'PARTNER'; name: string }
export type Step = TranscribeStep | MathChainStep | MemoryStep | ReverseStep | DelayStep | PartnerStep;

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
  /**
   * Hány AKTÍV próba egy kísérletben (a várakozás ezen felül jön).
   *
   * Kettő volt, és az kevésnek bizonyult: két feladat után az ember már
   * „majdnem kész”, és a majdnem-kész pont az az érzés, ami átlendít a
   * feloldáson. A típusok a négyes készletből jönnek; ha több lépés kell,
   * mint ahány típus van, a típus ISMÉTLŐDIK — friss tartalommal.
   */
  activeSteps: [3, 4, 5, 6],
  transcribeChars: [900, 1300, 1800, 2400],
  mathLen: [8, 12, 16, 20],
  mathFactorMax: [59, 79, 99, 129],
  memoryLen: [12, 14, 16, 20],
  memoryShowMs: [12_000, 10_000, 8_000, 6_000],
  memoryWaitMs: [90_000, 150_000, 240_000, 360_000],
  reverseWords: [10, 14, 18, 24],
  /** [min,max] minutes of forced waiting, pause sessions */
  pauseDelayMin: [[30, 45], [60, 90], [90, 150], [150, 240]],
  /** [min,max] minutes of forced waiting, delete sessions */
  deleteDelayMin: [[45, 70], [90, 130], [150, 210], [240, 360]],
} as const;

export const CLAIM_WINDOW_MS = 10 * 60_000;
export const DELETE_PENDING_MS = 24 * 3600_000;
/**
 * Ennyi idő után évül el egy kísérlet.
 *
 * A leghosszabb várakozás hat óra (törlés, maximális fok), és a munka is idő:
 * ha az elévülés ennél szorosabb lenne, a legnehezebb szinten a kísérletet
 * BEFEJEZNI sem lehetne — az nem szigor, hanem elrontott szabály.
 */
export const SESSION_MAX_AGE_MS = 14 * 3600_000;

/**
 * A hátralévő lépések számát SOHA nem mondjuk meg.
 *
 * Nem díszítés: a „még kettő” tudása ugyanaz a lendület, mint a majdnem-kész
 * érzés — pont az viszi át az embert a feloldáson. Amit a felület mondhat: van
 * még legalább ennyi. Ez mindig IGAZ, és nem árulja el, hol a vége.
 */
export const REMAINING_FLOOR = 3;

export type RemainingHint = 'many' | 'few';

/** „Legalább három van még” vagy „van még” — pontos szám sehol. */
export function remainingHint(stepIndex: number, stepCount: number): RemainingHint {
  return stepCount - stepIndex >= REMAINING_FLOOR ? 'many' : 'few';
}

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

/**
 * A megbízott jelmondata: négy szó a próbatételek szólistájából, kisbetűvel,
 * szóközzel. Csak a felvételkor születik, egyszer látszik; a lenyomata marad.
 */
export function makePartnerPhrase(rng: RNG, words = 4): string {
  return Array.from({ length: words }, () => rng.pick(WORDS).toLowerCase()).join(' ');
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
    case 'PARTNER':
      // Nem sorsolt próba: a bíró teszi a terv végére, ha van megbízott.
      throw new Error('A megbízott lépését nem a sorsolás adja.');
  }
}

/** Hány aktív próba jár ehhez a fokhoz (a várakozás ezen felül van). */
export function activeStepCount(tier: number): number {
  return TIER_PARAMS.activeSteps[Math.max(0, Math.min(3, tier))];
}

/** Ennyiszer próbálunk más kombinációt húzni, mint az előző kísérleté. */
const COMBO_REDRAW_TRIES = 8;

/** `n` típus sorsolása: előbb mind a négy, utána ismétlés — friss tartalommal. */
function drawTypes(n: number, rng: RNG): ChallengeType[] {
  const out: ChallengeType[] = [];
  while (out.length < n) {
    const pool = [...ACTIVE_POOL];
    // Fisher–Yates with the injected RNG
    for (let i = pool.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    for (const t of pool) {
      if (out.length < n) out.push(t);
    }
  }
  return out;
}

/**
 * Builds the step list for one unlock/delete attempt:
 *  - `activeSteps[tier]` random active challenges (never the same set twice in
 *    a row), types repeating when more steps are needed than types exist
 *  - plus a forced waiting period — MINDIG, nem csak magas fokon vagy törlésnél
 *
 * A feladott kísérlet típusait a hűtés alatt visszakapjuk (`forceCombo`). Ha
 * az a lista RÖVIDEBB, mint amennyi most jár, FELTÖLTJÜK: egy régi állapot
 * nem lehet a kevesebb munka útja.
 */
export function generatePlan(
  kind: 'pause' | 'delete',
  tier: number,
  lastCombo: string | null,
  rng: RNG,
  forceCombo?: string | null,
): { steps: Step[]; comboKey: string } {
  const want = activeStepCount(tier);
  let types: ChallengeType[] | null = parseCombo(forceCombo);
  if (types !== null && types.length < want) {
    types = [...types, ...drawTypes(want - types.length, rng)];
  }
  if (types === null) {
    // Az ismétlődés elkerülése PRÓBÁLKOZÁS, nem követelmény — és ez nem
    // kényelmi kérdés: ha annyi lépés jár, ahány típus van, akkor MINDEN terv
    // ugyanaz a halmaz, tehát nincs mit másikra cserélni. A korlát nélküli
    // újrasorsolás ilyenkor örökre pörögne. A tartalom úgyis friss.
    let draw = drawTypes(want, rng);
    for (let i = 0; i < COMBO_REDRAW_TRIES && lastCombo !== null && comboKeyOf(draw) === lastCombo; i++) {
      draw = drawTypes(want, rng);
    }
    types = draw;
  }
  const comboKey = comboKeyOf(types);
  const steps = types.map((tp) => makeStep(tp, tier, kind, rng));
  steps.push(makeStep('DELAY', tier, kind, rng));
  return { steps, comboKey };
}

export function comboKeyOf(types: ChallengeType[]): string {
  return [...types].sort().join('+');
}

/**
 * A combo key back into its challenge types, or null if it is not one this
 * build can serve (unknown name, nonsense arity — e.g. state written by a
 * newer version). Null means "draw a fresh plan", never "serve something
 * broken".
 *
 * ISMÉTLŐDÉS MEGENGEDETT: több lépés jár, mint ahány típus van, tehát egy
 * kulcsban ugyanaz a típus többször is szerepelhet. A hossz alsó határa
 * kettő, a felső a legnagyobb foké — ennél hosszabb kulcs nem a miénk.
 */
export function parseCombo(key: string | null | undefined): ChallengeType[] | null {
  if (!key) return null;
  const parts = key.split('+');
  if (parts.length < 2 || parts.length > TIER_PARAMS.activeSteps[3]) return null;
  if (!parts.every((p) => (ACTIVE_POOL as string[]).includes(p))) return null;
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
    case 'PARTNER':
      // A jelmondatot a BÍRÓ veti össze a lenyomattal (a segéd `crypto`-jával);
      // ide nem juthat el — ha mégis, az nem elfogadás.
      return { ok: false, done: false, step, message: 'A jelmondatot a megbízott lépése ellenőrzi.' };
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
        // A LÁNC HOSSZA NEM MEGY KI: a „3/9” ugyanaz a lendület, mint a
        // hátralévő lépések száma. Az index a felületnek kell (abból tudja,
        // hogy új feladat jött), a teljes hossz nem.
        math: { question: step.problems[step.pos].q + ' = ?', index: step.pos },
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
    case 'PARTNER':
      // A név megy ki, semmi más: a lenyomat a segédé.
      return { id: step.id, type: step.type, text: step.name };
  }
}
