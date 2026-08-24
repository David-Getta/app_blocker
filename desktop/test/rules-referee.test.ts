// Részleges szabályok: a súrlódás.
//
// Ez a funkció akkor ér valamit, ha a szabály LEVÉTELE nem egy gomb. Ha az
// lenne, a részleges tiltás annyit érne, mint egy kikapcsoló — és pont az
// ellen szól az egész app.
//
// A másik irány ugyanennyire fontos: a felvétel legyen INGYEN. Ha a szigorítás
// is súrlódna, senki nem venne fel szabályt, és a funkció nem létezne.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-rules-'));
process.env.BREAKER_STATE = path.join(tmp, 'state.json');
process.env.BREAKER_HOSTS = path.join(tmp, 'hosts');
fs.writeFileSync(process.env.BREAKER_HOSTS, '127.0.0.1 localhost\n');

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { defaultState, newId, type HelperState } from '../src/helper/state';
import * as referee from '../src/helper/referee';
import { MAX_RULES_PER_SITE, normalizeRule, ruleLabel } from '../src/shared/urlrules';
import type { Step, MathChainStep, MemoryStep, ReverseStep, TranscribeStep } from '../src/shared/challenges';
import { reverseString } from '../src/shared/challenges';

function stateWithSite(): { state: HelperState; siteId: string } {
  const state = defaultState();
  const siteId = newId('site');
  state.sites.push({
    id: siteId, domain: 'youtube.com',
    hostnames: ['youtube.com', 'www.youtube.com'],
    addedAt: Date.now(), pauseUntil: null, pendingDeleteAt: null,
  });
  return { state, siteId };
}

function solveStep(step: Step, now: number): string {
  switch (step.type) {
    case 'TRANSCRIBE': return (step as TranscribeStep).text;
    case 'MATH_CHAIN': {
      const m = step as MathChainStep;
      return String(m.problems[m.pos].a);
    }
    case 'MEMORY': {
      const m = step as MemoryStep;
      m.armedAt = now - m.showMs - m.waitMs - 1000;
      return m.code;
    }
    case 'REVERSE': return reverseString((step as ReverseStep).text);
    case 'DELAY': throw new Error('a várakozást átvenni kell, nem megválaszolni');
  }
}

function solveWholeSession(state: HelperState, now: number): void {
  let guard = 0;
  while (state.session && guard++ < 200) {
    const step = state.session.steps[state.session.stepIndex];
    referee.submitAnswer(state, state.session.id, solveStep(step, now), now);
  }
}

const RULE = normalizeRule('youtube.com/@valaki')!;

test('adding a rule is free and immediate', () => {
  // A szigorítás soha nem kér semmit. Enélkül senki nem venne fel szabályt.
  const { state, siteId } = stateWithSite();
  const r = referee.startRuleChange(state, siteId, RULE, false, Date.now());
  assert.equal(r.applied, true);
  assert.equal(r.session, null);
  assert.deepEqual(state.sites[0].rules, [RULE]);
  assert.equal(state.session, null, 'nem indul próbatétel');
});

test('the same rule twice stays one rule', () => {
  const { state, siteId } = stateWithSite();
  const now = Date.now();
  referee.startRuleChange(state, siteId, RULE, false, now);
  referee.startRuleChange(state, siteId, normalizeRule('https://m.youtube.com/@Valaki/')!, false, now);
  assert.equal(state.sites[0].rules?.length, 1);
});

test('removing a rule is NOT a button: it takes a challenge', () => {
  // Ez a funkció lényege. Amíg a próbatétel nincs meg, a szabály MARAD.
  const { state, siteId } = stateWithSite();
  const now = Date.now();
  referee.startRuleChange(state, siteId, RULE, false, now);

  const r = referee.startRuleChange(state, siteId, RULE, true, now);
  assert.equal(r.applied, false, 'nem tűnhet el azonnal');
  assert.ok(r.session, 'próbatétel indul');
  assert.deepEqual(state.sites[0].rules, [RULE], 'a próbatétel alatt még tilt');

  solveWholeSession(state, now);
  assert.equal(state.session, null);
  assert.deepEqual(state.sites[0].rules, [], 'teljesítés után esik le');
});

test('an abandoned removal leaves the rule in place', () => {
  // Elkezdeni és félbehagyni nem lehet kiskapu: a szabály marad, és a
  // következő kísérlet sem lesz könnyebb (ezt a referee tartja számon).
  const { state, siteId } = stateWithSite();
  const now = Date.now();
  referee.startRuleChange(state, siteId, RULE, false, now);
  const r = referee.startRuleChange(state, siteId, RULE, true, now);
  referee.abandonSession(state, r.session!.id);
  assert.deepEqual(state.sites[0].rules, [RULE]);
  assert.equal(state.session, null);
});

test('only the rule under challenge is removed, the others stay', () => {
  // Egy próbatétel EGY szabályt vesz le. Ha az összeset vinné, a súrlódás
  // értelmét vesztené: egy kör árán mindent le lehetne szedni.
  const { state, siteId } = stateWithSite();
  const now = Date.now();
  const other = normalizeRule('youtube.com/@masik')!;
  referee.startRuleChange(state, siteId, RULE, false, now);
  referee.startRuleChange(state, siteId, other, false, now);

  referee.startRuleChange(state, siteId, RULE, true, now);
  solveWholeSession(state, now);
  assert.deepEqual(state.sites[0].rules?.map(ruleLabel), [ruleLabel(other)]);
});

test('a removal cannot start while another attempt is running', () => {
  // Két párhuzamos kísérlet egymás próbatételeit vinné el — a szabályból
  // pedig kiderülne, hogy elég egyet megcsinálni.
  const { state, siteId } = stateWithSite();
  const now = Date.now();
  referee.startRuleChange(state, siteId, RULE, false, now);
  referee.startSession(state, 'pause', siteId, 15, now);
  assert.throws(() => referee.startRuleChange(state, siteId, RULE, true, now), /folyamatban/);
});

test('a rule that is not there cannot be removed', () => {
  const { state, siteId } = stateWithSite();
  assert.throws(() => referee.startRuleChange(state, siteId, RULE, true, Date.now()), /Nincs ilyen/);
  assert.throws(
    () => referee.startRuleChange(state, 'nincs_ilyen_oldal', RULE, false, Date.now()),
    /Ismeretlen oldal/,
  );
});

test('the rule list is bounded', () => {
  // A szabályok a segéd állapotfájljába kerülnek, és onnan a szinkronra is.
  // Korlát nélkül egy elgépelt ciklus a lemezt enné.
  const { state, siteId } = stateWithSite();
  const now = Date.now();
  for (let i = 0; i < MAX_RULES_PER_SITE; i++) {
    referee.startRuleChange(state, siteId, normalizeRule(`youtube.com/@a${i}`)!, false, now);
  }
  assert.equal(state.sites[0].rules?.length, MAX_RULES_PER_SITE);
  assert.throws(
    () => referee.startRuleChange(state, siteId, normalizeRule('youtube.com/@meg')!, false, now),
    /legfeljebb/,
  );
});

test('adding a rule never touches the block itself', () => {
  // A részleges szabály NEM lazítás és nem is szigorítás a DNS-blokkon: az
  // oldal ugyanúgy blokkolva marad. Ha ez elcsúszna, egy szabály felvétele
  // csendben feloldana valamit.
  const { state, siteId } = stateWithSite();
  const now = Date.now();
  referee.startRuleChange(state, siteId, RULE, false, now);
  assert.equal(state.sites[0].pauseUntil, null);
  assert.equal(state.sites[0].pendingDeleteAt, null);
  assert.equal(state.sites[0].schedule, undefined);
  assert.equal(state.sites[0].dailyLimitSeconds, undefined);
});
