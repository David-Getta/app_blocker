// Megfelelőségi fixtúra a PRÓBATÉTEL VÁLASZÁRA: ugyanaz a beírt válasz ugyanúgy
// számít a gépen, az Androidon és az iPhone-on.
//
// A próbatétel a lazítás ára, és a hibás válasz ára nagy: a fejszámolásnál az
// egész lánc elölről indul, a memória-kódnál új kód jön. Ha a három mag másképp
// olvassa ugyanazt a beírást — a gép a „157abc”-t 157-nek vette, az Android a
// nem latin számjegyet is számnak, az iPhone a sorvéget nem vágta le a kód
// mellől, és a kanonikusan egyenértékű (NFD) átgépelést is elfogadta —, akkor
// ugyanaz az ember ugyanazért a válaszért az egyik eszközön továbbmegy, a
// másikon elölről kezdi. Egyik sem szigorúság: véletlen.
//
// Négy szekció: a fok (computeTier) a feloldások naplójából; a hátralévő-jelzés
// (remainingHint); a kombináció-kulcs (parseCombo, comboKeyOf); és a válasz
// (applyAnswer) — a lépés a gép alakjában, a beírt válasz, az időpont, és hogy
// jó-e, kész-e, marad-e a lépés vagy újat kap (`kept`), és a lánc pozíciója. Az
// új lépés TARTALMA véletlen, azt nem hasonlítjuk — a szabály az, hogy jön-e új.
// Csupa ASCII, hogy a szóköz-fajták és a számjegy-írások látszódjanak.
//
//   UPDATE_CHALLENGE_FIXTURE=1 npm test     — a fájl újraírása

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  TIER_PARAMS, applyAnswer, cleanCodeAnswer, comboKeyOf, computeTier, makeCode, makeMathProblem, makeSentence,
  parseCombo, parseMathAnswer, remainingHint, reverseString,
} from '../src/shared/challenges';
import type { MathChainStep, MemoryStep, RNG, RemainingHint, Step } from '../src/shared/challenges';
import { rng } from './merge-random';

const FIXTURE = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'challenge-cases.json');

interface TierCase { unlockLog: number[]; now: number; tier: number }
interface RemainingCase { stepIndex: number; stepCount: number; hint: RemainingHint }
interface ComboCase { key: string | null; types: string[] | null; combo: string | null }
interface AnswerCase {
  seed: number; step: Step; answer: string; now: number;
  ok: boolean; done: boolean; kept: boolean; pos: number | null;
}
interface Fixture {
  note: string; version: number;
  tiers: TierCase[]; remaining: RemainingCase[]; combos: ComboCase[]; answers: AnswerCase[];
}

const ch = (code: number): string => String.fromCodePoint(code);
const NOW = Date.UTC(2026, 9, 1, 12, 0);
const DAY = 24 * 3600_000;

/** A próbatételek RNG-je a fésülés-fixtúra véletlenéből. */
function seededRng(seed: number): RNG {
  const r = rng(seed);
  for (let i = 0; i < 4; i++) r();
  return {
    int: (min, max) => min + Math.floor(r() * (max - min + 1)),
    pick: (arr) => arr[Math.floor(r() * arr.length)],
  };
}

// --------------------------------------------------------------------- fok

function tierCases(): TierCase[] {
  const weekAgo = NOW - 7 * DAY;
  const curated: number[][] = [
    [], [NOW - DAY], [NOW - DAY, NOW - 2 * DAY], [NOW - DAY, NOW - 2 * DAY, NOW - 3 * DAY],
    [1, 2, 3, 4].map((i) => NOW - i * DAY), [1, 2, 3, 4, 5, 6].map((i) => NOW - i * DAY),
    [1, 2, 3, 4, 5, 6, 7].map((i) => NOW - i * DAY / 2), Array.from({ length: 20 }, (_, i) => NOW - i * 3600_000),
    [weekAgo], [weekAgo, weekAgo], [weekAgo - 1, weekAgo - 1], [NOW], [NOW + 1, NOW + 1, NOW + 1],
    [NOW - 10 * DAY, NOW - 20 * DAY], [NOW - 8 * DAY, NOW - DAY, NOW - 2 * DAY],
  ];
  const out: TierCase[] = curated.map((unlockLog) => ({ unlockLog, now: NOW, tier: computeTier(unlockLog, NOW) }));
  for (let seed = 1; seed <= 40; seed++) {
    const r = seededRng(seed);
    const n = r.int(0, 10);
    const unlockLog = Array.from({ length: n }, () => NOW - r.int(-2, 10) * DAY + r.int(-3600_000, 3600_000));
    out.push({ unlockLog, now: NOW, tier: computeTier(unlockLog, NOW) });
  }
  return out;
}

// --------------------------------------------------------- hátralévő jelzés

function remainingCases(): RemainingCase[] {
  const out: RemainingCase[] = [];
  for (let stepCount = 1; stepCount <= 7; stepCount++) {
    for (let stepIndex = 0; stepIndex < stepCount; stepIndex++) {
      out.push({ stepIndex, stepCount, hint: remainingHint(stepIndex, stepCount) });
    }
  }
  return out;
}

// --------------------------------------------------------- kombináció-kulcs

const COMBO_KEYS: (string | null)[] = [
  null, '', 'MEMORY', 'MEMORY+TRANSCRIBE', 'TRANSCRIBE+MEMORY', 'MATH_CHAIN+MEMORY+REVERSE+TRANSCRIBE',
  'MEMORY+MEMORY', 'REVERSE+MEMORY+REVERSE', 'MATH_CHAIN+MATH_CHAIN+MEMORY+MEMORY+REVERSE+TRANSCRIBE',
  'MATH_CHAIN+MATH_CHAIN+MEMORY+MEMORY+REVERSE+TRANSCRIBE+TRANSCRIBE',
  'DELAY+MEMORY', 'PARTNER+MEMORY', 'memory+transcribe', 'MEMORY++TRANSCRIBE', ' MEMORY+TRANSCRIBE',
  'MEMORY+TRANSCRIBE+', '+', 'MEMORY,TRANSCRIBE', 'MEMORY+TRANSCRIBE' + ch(0xfeff),
];

function comboCases(): ComboCase[] {
  return COMBO_KEYS.map((key) => {
    const types = parseCombo(key);
    return { key, types, combo: types ? comboKeyOf(types) : null };
  });
}

// ------------------------------------------------------------------ válasz

/** A szóköz-fajták, amiket a felhasználó beüt vagy bemásol — a közös készletből. */
const SPACES = [' ', '\t', '\n', '\r\n', ch(0xa0), ch(0xfeff), ch(0x3000), ch(0x2003)];
/** Ami a szám után marad, ha a mezőbe más is kerül. */
const JUNK = ['abc', '.', '.0', ',5', 'e2', ' Ft', '-', 'x', '='];

/** Az ASCII számjegyek más írásban: arab-indiai, teljes szélességű, dévanágari. */
function toScript(digits: string, base: number): string {
  return [...digits].map((d) => (d >= '0' && d <= '9' ? ch(base + Number(d)) : d)).join('');
}

function withId(step: Step, id: string): Step {
  return { ...step, id } as Step;
}

/** Egy válasz a gép szabálya szerint — az új lépés tartalma nem számít, a jövetele igen. */
function answerCase(seed: number, step: Step, answer: string, now: number): AnswerCase {
  const out = applyAnswer(step, answer, 0, 'pause', seededRng(seed * 7919), now);
  return {
    seed, step, answer, now,
    ok: out.ok, done: out.done, kept: out.step.id === step.id,
    pos: out.step.type === 'MATH_CHAIN' ? out.step.pos : null,
  };
}

function mathStep(r: RNG, id: string): MathChainStep {
  const problems = Array.from({ length: r.int(2, 3) }, () => makeMathProblem(r, 59));
  return { id, type: 'MATH_CHAIN', problems, pos: r.int(0, problems.length - 1) };
}

function memoryStep(r: RNG, id: string, armedAt: number | null): MemoryStep {
  return {
    id, type: 'MEMORY', code: makeCode(r, TIER_PARAMS.memoryLen[0]),
    showMs: TIER_PARAMS.memoryShowMs[0], waitMs: TIER_PARAMS.memoryWaitMs[0], armedAt,
  };
}

function answerCases(): AnswerCase[] {
  const out: AnswerCase[] = [];
  let seed = 1000;

  // Kézzel válogatott élek — ezek mondják ki a szabályt; lentebb a véletlen szórja.
  const r0 = seededRng(1);
  const m0: MathChainStep = { id: 'st_m0', type: 'MATH_CHAIN', problems: [{ q: '13 × 12 + 1', a: 157 }, { q: '12 × 12 − 999', a: -855 }, { q: '(23 + 24) × 3', a: 141 }], pos: 0 };
  for (const answer of [
    '157', ' 157 ', '1 57', '+157', '157abc', '157.0', '157,5', '1e2', '0157', '', ' ', '+', '-', '157\n', ch(0xfeff) + '157' + ch(0xa0),
    toScript('157', 0x660), toScript('157', 0xff10), toScript('157', 0x966), '158', '-157', '00000000000000157', '157' + ch(0x200b),
  ]) out.push(answerCase(seed++, m0, answer, NOW));
  const m1: MathChainStep = { ...m0, pos: 1 };
  for (const answer of ['-855', '- 855', '-0855', '855', '+855', '−855', '-855.', '(855)']) out.push(answerCase(seed++, m1, answer, NOW));
  const m2: MathChainStep = { ...m0, pos: 2 };
  for (const answer of ['141', ' 141\t']) out.push(answerCase(seed++, m2, answer, NOW));

  const mem = memoryStep(r0, 'st_mem0', NOW - 12_000 - 90_000);
  for (const answer of [
    mem.code, mem.code.toLowerCase(), ` ${mem.code} `, `${mem.code}\n`, ch(0xfeff) + mem.code, mem.code + ch(0xa0),
    `${mem.code.slice(0, 4)} ${mem.code.slice(4)}`, mem.code.slice(1), mem.code + 'A', '', 'NOPE',
  ]) out.push(answerCase(seed++, mem, answer, NOW));
  // Az időzítés: a mutatás + várakozás végén pontosan elfogadott, egy ezredmásodperccel előtte nem; élesítés nélkül sosem.
  const armed = memoryStep(r0, 'st_mem1', NOW - 50_000);
  out.push(answerCase(seed++, armed, armed.code, armed.armedAt! + armed.showMs + armed.waitMs));
  out.push(answerCase(seed++, armed, armed.code, armed.armedAt! + armed.showMs + armed.waitMs - 1));
  out.push(answerCase(seed++, armed, armed.code, armed.armedAt! + armed.showMs));
  out.push(answerCase(seed++, armed, 'ROSSZ', armed.armedAt! + armed.showMs));
  out.push(answerCase(seed++, memoryStep(r0, 'st_mem2', null), 'AKARMI', NOW));

  const tr: Step = { id: 'st_tr0', type: 'TRANSCRIBE', text: 'Bogrács délután, erdő és időjárás 42.' };
  for (const answer of [tr.text, tr.text.toLowerCase(), tr.text + ' ', ' ' + tr.text, tr.text.normalize('NFD'), reverseString(tr.text), '']) {
    out.push(answerCase(seed++, tr, answer, NOW));
  }
  const rv: Step = { id: 'st_rv0', type: 'REVERSE', text: 'Füzet gomba, határ őszi patak.' };
  for (const answer of [reverseString(rv.text), rv.text, reverseString(rv.text) + ' ', reverseString(rv.text).normalize('NFD'), '']) {
    out.push(answerCase(seed++, rv, answer, NOW));
  }
  out.push(answerCase(seed++, { id: 'st_d0', type: 'DELAY', minutes: 30, claimableAt: null, claimWindowMs: 600_000 }, '30', NOW));
  out.push(answerCase(seed++, { id: 'st_d1', type: 'DELAY', minutes: 30, claimableAt: NOW - 1, claimWindowMs: 600_000 }, '', NOW));
  out.push(answerCase(seed++, { id: 'st_p0', type: 'PARTNER', name: 'Anna' }, 'alma bogrács cinege délután', NOW));

  // Véletlen fejszámolások: a jó válasz tíz alakban, és a rossz.
  for (let s = 1; s <= 60; s++) {
    const r = seededRng(2000 + s);
    const step = mathStep(r, `st_m${s}`);
    const expected = step.problems[step.pos].a;
    const abs = String(Math.abs(expected));
    const sign = expected < 0 ? '-' : '';
    let answer: string;
    switch (r.int(0, 9)) {
      case 0: answer = String(expected); break;
      case 1: answer = `${r.pick(SPACES)}${expected}${r.pick(SPACES)}`; break;
      case 2: { const cut = r.int(1, Math.max(1, abs.length - 1)); answer = sign + abs.slice(0, cut) + r.pick(SPACES) + abs.slice(cut); break; }
      case 3: answer = (expected >= 0 ? '+' : '') + String(expected); break;
      case 4: answer = String(expected) + r.pick(JUNK); break;
      case 5: answer = toScript(String(expected), r.pick([0x660, 0xff10, 0x966])); break;
      case 6: answer = String(expected + r.pick([-1, 1, 10, 100])); break;
      case 7: answer = sign + '0' + abs; break;
      case 8: answer = r.pick(['', ' ', '+', '-', 'x']); break;
      default: answer = `${sign}${abs.slice(0, -1)}${r.pick(SPACES)}${abs.slice(-1)}`; break;
    }
    out.push(answerCase(seed++, step, answer, NOW));
  }

  // Véletlen memória-kódok: a jó kód díszítve, és a rossz; az időzítés is szór.
  for (let s = 1; s <= 40; s++) {
    const r = seededRng(3000 + s);
    const armedAt = r.int(0, 9) === 0 ? null : NOW - r.pick([102_000, 101_999, 150_000, 12_000, 1_000, 3_600_000]);
    const step = memoryStep(r, `st_mem${s}`, armedAt);
    let answer: string;
    switch (r.int(0, 6)) {
      case 0: answer = step.code; break;
      case 1: answer = step.code.toLowerCase(); break;
      case 2: answer = `${r.pick(SPACES)}${step.code}${r.pick(SPACES)}`; break;
      case 3: { const cut = r.int(1, step.code.length - 1); answer = step.code.slice(0, cut) + r.pick(SPACES) + step.code.slice(cut); break; }
      case 4: answer = makeCode(r, step.code.length); break;
      case 5: answer = step.code.slice(0, -1); break;
      default: answer = step.code.toLowerCase() + '\n'; break;
    }
    out.push(answerCase(seed++, step, answer, NOW));
  }

  // Véletlen átgépelések és visszafelé mondatok: pontosan, és egy jellel másképp.
  for (let s = 1; s <= 12; s++) {
    const r = seededRng(4000 + s);
    const text = makeSentence(r, r.int(4, 7));
    const step: Step = s % 2 === 0 ? { id: `st_tr${s}`, type: 'TRANSCRIBE', text } : { id: `st_rv${s}`, type: 'REVERSE', text };
    const right = step.type === 'REVERSE' ? reverseString(text) : text;
    const answer = r.pick([right, right, right.toLowerCase(), right + ' ', right.normalize('NFD'), right.slice(1)]);
    out.push(answerCase(seed++, step, answer, NOW));
  }
  return out;
}

function buildFixture(): Fixture {
  return {
    note: 'Generálja és őrzi: desktop/test/challenge-fixture.test.ts (UPDATE_CHALLENGE_FIXTURE=1 npm test). '
      + 'A fok a feloldások naplójából (computeTier), a hátralévő-jelzés (remainingHint), a kombináció-kulcs '
      + '(parseCombo, comboKeyOf) és a válasz (applyAnswer): a lépés a gép alakjában, a beírt válasz, az időpont — '
      + 'jó-e, kész-e, marad-e a lépés (kept) vagy újat kap, a lánc pozíciója. Az új lépés tartalma véletlen, azt nem '
      + 'hasonlítjuk. Olvassa: android/jvm-tests ChallengeFixtureTest, ios/SharedTests ChallengeFixtureTests. Csupa ASCII.',
    version: 1,
    tiers: tierCases(), remaining: remainingCases(), combos: comboCases(), answers: answerCases(),
  };
}

/** Minden nem ASCII jel számmal írva: a szóköz-fajták és a számjegy-írások látszanak. */
function ascii(json: string): string {
  let out = '';
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    out += code < 0x7f ? json[i] : '\\u' + code.toString(16).padStart(4, '0');
  }
  return out;
}

function render(f: Fixture): string {
  const rows = (items: unknown[]) => items.map((c) => '  ' + ascii(JSON.stringify(c))).join(',\n');
  return `{\n "note": ${ascii(JSON.stringify(f.note))},\n "version": ${f.version},\n`
    + ` "tiers": [\n${rows(f.tiers)}\n ],\n`
    + ` "remaining": [\n${rows(f.remaining)}\n ],\n`
    + ` "combos": [\n${rows(f.combos)}\n ],\n`
    + ` "answers": [\n${rows(f.answers)}\n ]\n}\n`;
}

test('a fejszámolás válaszának szabálya: szóköz ki, előjel, csak ASCII számjegy', () => {
  assert.equal(parseMathAnswer('157'), 157);
  assert.equal(parseMathAnswer(' 1 57\n'), 157, 'a szóköz bárhol kiesik — a közös készlet szerint');
  assert.equal(parseMathAnswer(ch(0xfeff) + '157' + ch(0xa0)), 157, 'a BOM és a nem törő szóköz is szóköz');
  assert.equal(parseMathAnswer('+157'), 157);
  assert.equal(parseMathAnswer('-0855'), -855);
  assert.equal(parseMathAnswer('157abc'), null, 'a szemét a szám után nem szám — a parseInt elfogadta volna');
  assert.equal(parseMathAnswer('157.0'), null);
  assert.equal(parseMathAnswer(toScript('157', 0x660)), null, 'a nem latin számjegy nem szám — az Android elfogadta volna');
  assert.equal(parseMathAnswer(toScript('157', 0xff10)), null);
  assert.equal(parseMathAnswer(''), null);
  assert.equal(parseMathAnswer('+'), null);
  assert.equal(parseMathAnswer('1234567890123456'), null, 'tizenöt számjegy fölött nem szám');
  assert.equal(cleanCodeAnswer('\n abcd' + ch(0xfeff)), 'ABCD', 'a kód szélei a közös készlet szerint, nagybetűvel');
});

test('a próbatétel fixtúrája friss, és nem elfajult', () => {
  const built = buildFixture();
  assert.ok(new Set(built.tiers.map((t) => t.tier)).size === 4, 'mind a négy fok előjön');
  assert.ok(built.combos.some((c) => c.types) && built.combos.some((c) => !c.types));
  const answers = built.answers;
  assert.ok(answers.filter((a) => a.ok).length > 40 && answers.filter((a) => !a.ok).length > 40, 'jó és rossz válasz is bőven');
  assert.ok(answers.some((a) => !a.ok && !a.kept) && answers.some((a) => !a.ok && a.kept), 'újat kapó és maradó lépés is');
  assert.ok(answers.some((a) => a.ok && a.done) && answers.some((a) => a.ok && !a.done));
  const text = render(built);
  if (process.env.UPDATE_CHALLENGE_FIXTURE) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, text);
  }
  assert.ok(fs.existsSync(FIXTURE), `nincs fixture: ${FIXTURE} — UPDATE_CHALLENGE_FIXTURE=1 npm test`);
  const onDisk = fs.readFileSync(FIXTURE, 'utf8');
  assert.equal(
    onDisk, text,
    'a fixtures/challenge-cases.json elavult a gép szabályához képest — UPDATE_CHALLENGE_FIXTURE=1 npm test, '
      + 'aztán a Kotlin (ChallengeFixtureTest) és a Swift (ChallengeFixtureTests) teszt mutatja meg, hol csúszott el a tükör',
  );
  assert.ok(/^[\x00-\x7f]*$/.test(onDisk), 'a fixtúra nem csupa ASCII');
});
