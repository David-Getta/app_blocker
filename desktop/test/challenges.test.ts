import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  applyAnswer, computeTier, generatePlan, makeStep, reverseString, toDisplay,
  cryptoRng, comboKeyOf,
} from '../src/shared/challenges';
import type { RNG, Step, MathChainStep, MemoryStep, ReverseStep, TranscribeStep } from '../src/shared/challenges';

/** deterministic LCG-based RNG for reproducible assertions */
function seededRng(seed: number): RNG {
  let s = seed >>> 0;
  const next = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  return {
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
  };
}

test('computeTier scales with recent unlocks', () => {
  const now = 1_000_000_000_000;
  const day = 24 * 3600_000;
  assert.equal(computeTier([], now), 0);
  assert.equal(computeTier([now - day], now), 0);
  assert.equal(computeTier([now - day, now - 2 * day], now), 1);
  assert.equal(computeTier([1, 2, 3, 4].map((i) => now - i * day), now), 2);
  assert.equal(computeTier([1, 2, 3, 4, 5, 6, 6.5].map((i) => now - i * day / 2), now), 3);
  // old unlocks decay away
  assert.equal(computeTier([now - 10 * day, now - 20 * day], now), 0);
});

test('generatePlan: two distinct actives, DELAY rules, combo varies', () => {
  const rng = seededRng(42);
  for (let i = 0; i < 50; i++) {
    const { steps } = generatePlan('pause', 0, null, rng);
    assert.equal(steps.length, 2);
    assert.notEqual(steps[0].type, steps[1].type);
    assert.ok(steps.every((s) => s.type !== 'DELAY'));
  }
  const withDelay = generatePlan('pause', 2, null, rng);
  assert.equal(withDelay.steps.length, 3);
  assert.equal(withDelay.steps[2].type, 'DELAY');
  const del = generatePlan('delete', 0, null, rng);
  assert.equal(del.steps[del.steps.length - 1].type, 'DELAY');

  // never the same combo twice in a row
  let last: string | null = null;
  for (let i = 0; i < 100; i++) {
    const plan = generatePlan('pause', 1, last, rng);
    assert.notEqual(plan.comboKey, last);
    last = plan.comboKey;
  }
});

const NOW = 1_700_000_000_000;

test('TRANSCRIBE: only the exact text passes, content is fresh every time', () => {
  const rng = cryptoRng();
  const a = makeStep('TRANSCRIBE', 1, 'pause', rng) as TranscribeStep;
  const b = makeStep('TRANSCRIBE', 1, 'pause', rng) as TranscribeStep;
  assert.notEqual(a.text, b.text);
  assert.ok(a.text.length >= 420);
  assert.equal(applyAnswer(a, a.text, 1, 'pause', rng, NOW).done, true);
  const wrong = applyAnswer(a, a.text.slice(0, -1), 1, 'pause', rng, NOW);
  assert.equal(wrong.ok, false);
  // transcription keeps the same text on failure (retyping is the effort)
  assert.equal((wrong.step as TranscribeStep).text, a.text);
});

test('MATH_CHAIN: progress on correct, full reset with new problems on wrong', () => {
  const rng = cryptoRng();
  let step = makeStep('MATH_CHAIN', 0, 'pause', rng) as MathChainStep;
  const originalQs = step.problems.map((p) => p.q).join('|');
  // correct answer advances
  let out = applyAnswer(step, String(step.problems[0].a), 0, 'pause', rng, NOW);
  assert.equal(out.ok, true);
  assert.equal(out.done, false);
  step = out.step as MathChainStep;
  assert.equal(step.pos, 1);
  // wrong answer resets with brand new problems
  out = applyAnswer(step, '999999999', 0, 'pause', rng, NOW);
  assert.equal(out.ok, false);
  const reset = out.step as MathChainStep;
  assert.equal(reset.pos, 0);
  assert.notEqual(reset.problems.map((p) => p.q).join('|'), originalQs);
  // full chain completes
  let cur = reset;
  let final = out;
  for (let i = 0; i < cur.problems.length; i++) {
    final = applyAnswer(cur, String(cur.problems[cur.pos].a), 0, 'pause', rng, NOW);
    cur = final.step as MathChainStep;
  }
  assert.equal(final.done, true);
});

function armedMemory(rng: ReturnType<typeof cryptoRng>, tier = 0): MemoryStep {
  const mem = makeStep('MEMORY', tier, 'pause', rng) as MemoryStep;
  // arm far enough in the past that show + wait have fully elapsed
  mem.armedAt = NOW - mem.showMs - mem.waitMs - 1000;
  return mem;
}

test('MEMORY and REVERSE regenerate content on failure', () => {
  const rng = cryptoRng();
  const mem = armedMemory(rng);
  assert.equal(applyAnswer(mem, mem.code.toLowerCase(), 0, 'pause', rng, NOW).done, true);
  const memFail = applyAnswer(mem, 'NOPE', 0, 'pause', rng, NOW);
  assert.notEqual((memFail.step as MemoryStep).code, mem.code);

  const rev = makeStep('REVERSE', 0, 'pause', rng) as ReverseStep;
  assert.equal(applyAnswer(rev, reverseString(rev.text), 0, 'pause', rng, NOW).done, true);
  const revFail = applyAnswer(rev, rev.text, 0, 'pause', rng, NOW);
  assert.equal(revFail.ok, false);
  assert.notEqual((revFail.step as ReverseStep).text, rev.text);
});

test('MEMORY: answers are refused until the server-side show+wait has elapsed', () => {
  const rng = cryptoRng();
  const mem = makeStep('MEMORY', 0, 'pause', rng) as MemoryStep;
  mem.armedAt = NOW; // just became current
  // during show phase: even the correct answer is premature and NOT a failure
  const early = applyAnswer(mem, mem.code, 0, 'pause', rng, NOW + 1000);
  assert.equal(early.ok, false);
  assert.equal((early.step as MemoryStep).code, mem.code); // no regeneration
  // during wait phase: still premature
  const midWait = applyAnswer(mem, mem.code, 0, 'pause', rng, NOW + mem.showMs + 1000);
  assert.equal(midWait.ok, false);
  // after the full window: accepted
  const after = applyAnswer(mem, mem.code, 0, 'pause', rng, NOW + mem.showMs + mem.waitMs + 1);
  assert.equal(after.done, true);
});

test('MEMORY: the code is only shipped to the UI while the show window is open', () => {
  const rng = cryptoRng();
  const mem = makeStep('MEMORY', 0, 'pause', rng) as MemoryStep;
  mem.armedAt = NOW;
  const during = toDisplay(mem, NOW + 1000);
  assert.equal(during.memory!.code, mem.code);
  // after the show window (e.g. the user closed and reopened the modal),
  // the server no longer ships the code — no re-peeking
  const after = toDisplay(mem, NOW + mem.showMs + 1);
  assert.equal(after.memory!.code, null);
});

test('toDisplay never leaks expected answers', () => {
  const rng = cryptoRng();
  const math = makeStep('MATH_CHAIN', 2, 'pause', rng) as MathChainStep;
  const display = toDisplay(math, NOW);
  // Szerkezeti állítás: a válasz MEZŐI nem utaznak. A korábbi alak a teljes
  // JSON-ban kereste a válasz számjegyeit, és ritkán hamisan riasztott (CI,
  // 2026-09-02): egy két-három jegyű szám legitim részletként felbukkanhat a
  // kérdés szövegében vagy a lépés-azonosító hexében. A szivárgás nem
  // számjegy-egybeesés, hanem az, ha a válasz mezője vagy értéke kikerül.
  const keys = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        keys.add(k);
        walk(x);
      }
    }
  };
  walk(display);
  assert.ok(!keys.has('problems'), 'a feladat-lista (válaszostul) nem mehet ki');
  assert.ok(!keys.has('a'), 'a válasz mezője nem mehet ki');
  // Az összeragasztás ellen: a kérdés kérdőjelre végződik, nem az eredményre.
  assert.ok(display.math!.question.endsWith('= ?'));
  assert.ok(!display.math!.question.includes(`= ${math.problems[0].a}`));
  const rev = makeStep('REVERSE', 0, 'pause', rng) as ReverseStep;
  const revJson = JSON.stringify(toDisplay(rev, NOW));
  // Itt a részlet-keresés determinisztikus: a megfordított többszavas mondat
  // csak akkor állhatna a JSON-ban, ha a mondat betűre palindrom lenne — a
  // szólista és a mondatképzés (nagybetűs kezdés, 4+ szó) ezt kizárja.
  assert.ok(!revJson.includes(reverseString(rev.text)));
});

test('comboKeyOf is order independent', () => {
  assert.equal(comboKeyOf(['MEMORY', 'TRANSCRIBE']), comboKeyOf(['TRANSCRIBE', 'MEMORY']));
});

test('DELAY minutes fall inside the tier band', () => {
  const rng = cryptoRng();
  for (let tier = 0; tier <= 3; tier++) {
    for (let i = 0; i < 20; i++) {
      const d = makeStep('DELAY', tier, 'delete', rng);
      assert.equal(d.type, 'DELAY');
      if (d.type === 'DELAY') {
        assert.ok(d.minutes >= 15 && d.minutes <= 120);
      }
    }
  }
});
