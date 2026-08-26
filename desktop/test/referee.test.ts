// End-to-end referee + hosts engine tests, run against temp files via the
// BREAKER_STATE / BREAKER_HOSTS env overrides.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-test-'));
process.env.BREAKER_STATE = path.join(tmp, 'state.json');
process.env.BREAKER_HOSTS = path.join(tmp, 'hosts');
fs.writeFileSync(process.env.BREAKER_HOSTS, '127.0.0.1 localhost\n');

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { defaultState, loadState, newId } from '../src/helper/state';
import type { HelperState } from '../src/helper/state';
import * as referee from '../src/helper/referee';
import { applyBlocklist, activeHostnames } from '../src/helper/hosts';
import { recordSample, siteKey } from '../src/shared/usage';
import type { Step, DelayStep, MathChainStep, MemoryStep, ReverseStep, TranscribeStep } from '../src/shared/challenges';
import { reverseString, REROLL_COOLDOWN_MS } from '../src/shared/challenges';

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
      // simulate having sat through the show + wait window
      const m = step as MemoryStep;
      m.armedAt = now - m.showMs - m.waitMs - 1000;
      return m.code;
    }
    case 'REVERSE': return reverseString((step as ReverseStep).text);
    case 'DELAY': throw new Error('delay steps are claimed, not answered');
  }
}

test('full pause session: solve every step -> site pauses, then tick re-locks', () => {
  const { state, siteId } = stateWithSite();
  const now = Date.now();
  const info = referee.startSession(state, 'pause', siteId, 15, now);
  assert.equal(info.stepCount, 2); // tier 0 -> no DELAY

  let guard = 0;
  while (state.session && guard++ < 200) {
    const step = state.session.steps[state.session.stepIndex];
    referee.submitAnswer(state, state.session.id, solveStep(step, now), now);
  }
  assert.equal(state.session, null);
  const site = state.sites[0];
  assert.ok(site.pauseUntil !== null && site.pauseUntil > now);
  assert.equal(state.unlockLog.length, 1);

  // while paused, the hostnames are not blocked
  assert.deepEqual(activeHostnames(state, now), []);
  // after expiry, tick re-locks automatically
  const later = site.pauseUntil! + 1;
  assert.equal(referee.tick(state, later), true);
  assert.equal(site.pauseUntil, null);
  assert.deepEqual(activeHostnames(state, later), ['www.youtube.com', 'youtube.com']);
});

test('wrong answers do not advance the session', () => {
  const { state, siteId } = stateWithSite();
  const now = Date.now();
  referee.startSession(state, 'pause', siteId, 30, now);
  const r = referee.submitAnswer(state, state.session!.id, 'biztosan nem jó válasz', now);
  assert.equal(r.accepted, false);
  assert.equal(state.session!.stepIndex, 0);
  assert.equal(state.sites[0].pauseUntil, null);
});

test('delete session always ends with DELAY; claim window is enforced', () => {
  const { state, siteId } = stateWithSite();
  const now = Date.now();
  referee.startSession(state, 'delete', siteId, undefined, now);
  const steps = state.session!.steps;
  assert.equal(steps[steps.length - 1].type, 'DELAY');

  // solve the active steps
  while (state.session!.steps[state.session!.stepIndex].type !== 'DELAY') {
    const step = state.session!.steps[state.session!.stepIndex];
    referee.submitAnswer(state, state.session!.id, solveStep(step, now), now);
  }
  const delay = state.session!.steps[state.session!.stepIndex] as DelayStep;
  assert.ok(delay.claimableAt !== null && delay.claimableAt > now);

  // too early -> rejected
  const early = referee.claimDelay(state, state.session!.id, now);
  assert.equal(early.accepted, false);

  // inside the window -> delete becomes pending (not immediate!)
  const inWindow = delay.claimableAt! + 1000;
  const done = referee.claimDelay(state, state.session!.id, inWindow);
  assert.equal(done.sessionDone, true);
  const site = state.sites[0];
  assert.ok(site.pendingDeleteAt !== null && site.pendingDeleteAt > inWindow + 23 * 3600_000);

  // still blocked until the 24h grace passes
  assert.deepEqual(activeHostnames(state, inWindow), ['www.youtube.com', 'youtube.com']);
  // ...and the site disappears only after the grace period
  referee.tick(state, site.pendingDeleteAt! + 1);
  assert.equal(state.sites.length, 0);
});

test('missing the claim window voids the whole attempt', () => {
  const { state, siteId } = stateWithSite();
  const now = Date.now();
  referee.startSession(state, 'delete', siteId, undefined, now);
  while (state.session!.steps[state.session!.stepIndex].type !== 'DELAY') {
    const step = state.session!.steps[state.session!.stepIndex];
    referee.submitAnswer(state, state.session!.id, solveStep(step, now), now);
  }
  const delay = state.session!.steps[state.session!.stepIndex] as DelayStep;
  const tooLate = delay.claimableAt! + delay.claimWindowMs + 1;
  assert.throws(() => referee.claimDelay(state, state.session!.id, tooLate), /elölről/);
  assert.equal(state.session, null);
  assert.equal(state.sites[0].pendingDeleteAt, null);
});

test('schedule change: tightening applies immediately, loosening needs challenges', () => {
  const { state, siteId } = stateWithSite();
  const now = Date.now();
  const workBlock = {
    mode: 'scheduled_block' as const,
    bands: [{ days: [1, 2, 3, 4, 5] as (0|1|2|3|4|5|6)[], startMin: 9 * 60, endMin: 17 * 60 }],
  };
  // always -> scheduled_block frees nights/weekends => loosening => gated
  const loosen = referee.startScheduleChange(state, siteId, workBlock, now);
  assert.equal(loosen.applied, false);
  assert.ok(loosen.session);
  assert.equal(state.sites[0].schedule, undefined); // not applied yet
  // solve the challenges -> schedule now applied, no pause set
  let guard = 0;
  while (state.session && guard++ < 200) {
    const step = state.session.steps[state.session.stepIndex];
    referee.submitAnswer(state, state.session.id, solveStep(step, now), now);
  }
  assert.deepEqual(state.sites[0].schedule, workBlock);
  assert.equal(state.sites[0].pauseUntil, null);

  // scheduled_block -> always is tightening => applies immediately, no session
  const tighten = referee.startScheduleChange(state, siteId, { mode: 'always', bands: [] }, now);
  assert.equal(tighten.applied, true);
  assert.equal(tighten.session, null);
  assert.deepEqual(state.sites[0].schedule, { mode: 'always', bands: [] });
});

test('hosts file: apply, tamper-detect content, pause exclusion', () => {
  const { state } = stateWithSite();
  const now = Date.now();
  assert.equal(applyBlocklist(state, now), true);
  let hosts = fs.readFileSync(process.env.BREAKER_HOSTS!, 'utf8');
  assert.ok(hosts.includes('0.0.0.0 youtube.com'));
  assert.ok(hosts.includes('127.0.0.1 localhost'));

  // no-op when unchanged
  assert.equal(applyBlocklist(state, now), false);

  // manual tamper -> re-apply restores
  fs.writeFileSync(process.env.BREAKER_HOSTS!, '127.0.0.1 localhost\n');
  assert.equal(applyBlocklist(state, now), true);
  hosts = fs.readFileSync(process.env.BREAKER_HOSTS!, 'utf8');
  assert.ok(hosts.includes('0.0.0.0 youtube.com'));

  // paused site drops out of the hosts file
  state.sites[0].pauseUntil = now + 60_000;
  assert.equal(applyBlocklist(state, now), true);
  hosts = fs.readFileSync(process.env.BREAKER_HOSTS!, 'utf8');
  assert.ok(!hosts.includes('youtube.com'));
});

test('a wrong MEMORY answer leaves a step that can still be solved', () => {
  // Regression: the regenerated step came back with armedAt = null and nothing
  // re-armed it. Its code was therefore never shown, and every further answer
  // was refused as "still memorizing" — one typo made the unlock impossible
  // for good, on every platform.
  const { state, siteId } = stateWithSite();
  const now = Date.now();

  // plans are randomised; start attempts until the current step is a MEMORY one
  let first: MemoryStep | null = null;
  let startedAt = now;
  for (let i = 0; i < 300 && !first; i++) {
    // This test is about the MEMORY step, not the re-roll rule: clear the
    // abandon debt so each attempt really is a fresh draw. (The rule itself has
    // its own tests below — with it in place the loop would keep getting the
    // very first pair back, for ever.)
    state.session = null;   // no attempt to drop...
    state.abandons = [];    // ...and no debt from one, so the draw is free
    startedAt = now + i * (REROLL_COOLDOWN_MS + 60_000);
    referee.startSession(state, 'pause', siteId, 15, startedAt);
    const s = state.session!.steps[state.session!.stepIndex];
    if (s.type === 'MEMORY') first = s;
  }
  assert.ok(first, 'a MEMORY step shows up in a randomised plan');
  assert.equal(first!.armedAt, startedAt, 'the opening step is armed when the session starts');

  const after = startedAt + first!.showMs + first!.waitMs + 1_000; // sat through the window
  const res = referee.submitAnswer(state, state.session!.id, 'ROSSZKOD', after);
  assert.equal(res.accepted, false);

  const next = state.session!.steps[state.session!.stepIndex] as MemoryStep;
  assert.equal(next.type, 'MEMORY');
  assert.notEqual(next.code, first!.code, 'a fresh code is issued after a miss');
  assert.equal(next.armedAt, after, 'and it is armed, so its show window actually opens');

  // the UI is handed the new code while the window is open
  const display = referee.currentSession(state)!.current;
  assert.equal(display.type, 'MEMORY');

  // and the retry succeeds once the new window has elapsed
  const retryAt = after + next.showMs + next.waitMs + 1_000;
  const ok = referee.submitAnswer(state, state.session!.id, next.code, retryAt);
  assert.equal(ok.accepted, true, 'the challenge stays solvable after a wrong answer');
});

test('a short recurring free window is still a loosening', () => {
  // Regression: loosening detection sampled every 15 minutes, so a daily
  // 13-minute allow window slipped between two samples and installed with no
  // friction at all — a complete bypass of the unlock challenges.
  const { state, siteId } = stateWithSite();
  // Pinned to local noon so the old 15-minute grid lands on :00/:15/:30/:45 and
  // provably steps over the 23:47–24:00 gap: this test fails on the old code
  // every time, not just most of the time.
  const now = new Date(2026, 4, 20, 12, 0, 0).getTime();
  const sneaky = {
    mode: 'scheduled_block' as const,
    bands: [{ days: [0, 1, 2, 3, 4, 5, 6] as (0|1|2|3|4|5|6)[], startMin: 0, endMin: 1440 - 13 }],
  };
  const res = referee.startScheduleChange(state, siteId, sneaky, now);
  assert.equal(res.applied, false, 'even 13 free minutes a day must be earned');
  assert.ok(res.session);
});

test('cancelling an attempt is not a way to re-roll an easier one', () => {
  // The friction is the point. If giving up drew a fresh pair of challenges,
  // you could restart until you got the pair you find easiest (say, the one
  // without MEMORY's forced wait) — friction you can re-roll is not friction.
  const { state, siteId } = stateWithSite();
  const now = Date.now();

  referee.startSession(state, 'pause', siteId, 15, now);
  const firstTypes = [...state.session!.steps.map((s) => s.type)].sort().join('+');
  const firstIds = state.session!.steps.map((s) => s.id);

  referee.abandonSession(state, state.session!.id);
  assert.equal(state.session, null);

  referee.startSession(state, 'pause', siteId, 15, now + 60_000);
  assert.equal([...state.session!.steps.map((s) => s.type)].sort().join('+'), firstTypes,
    'the same challenge types come back');
  // …but nothing is banked either: fresh content, so cancelling is never cheaper
  // than finishing.
  const secondIds = state.session!.steps.map((s) => s.id);
  assert.notDeepEqual(secondIds, firstIds, 'the content itself is regenerated');
  assert.equal(state.session!.stepIndex, 0, 'progress is not carried over');
});

test('a solved attempt earns a freshly drawn one next time', () => {
  const { state, siteId } = stateWithSite();
  const now = Date.now();
  referee.startSession(state, 'pause', siteId, 15, now);
  let guard = 0;
  while (state.session && guard++ < 200) {
    const step = state.session.steps[state.session.stepIndex];
    referee.submitAnswer(state, state.session.id, solveStep(step, now), now);
  }
  assert.deepEqual(state.abandons ?? [], [], 'the abandon debt is cleared by solving');
});

test('the forced combo expires with its cooldown', () => {
  const { state, siteId } = stateWithSite();
  const now = Date.now();
  referee.startSession(state, 'pause', siteId, 15, now);
  referee.abandonSession(state, state.session!.id);
  const abandonedCombo = state.abandons![0].comboKey;

  // Well past the cooldown the draw is free again — and the variety rule then
  // guarantees it differs from the one just played.
  referee.startSession(state, 'pause', siteId, 15, now + REROLL_COOLDOWN_MS + 60_000);
  const types = state.session!.steps.filter((s) => s.type !== 'DELAY').map((s) => s.type);
  assert.notEqual([...types].sort().join('+'), abandonedCombo);
});

test('missing the DELAY claim window does not re-roll the challenge either', () => {
  const { state, siteId } = stateWithSite();
  const now = Date.now();
  // tier 3 forces a DELAY step into the plan
  state.unlockLog = Array.from({ length: 8 }, (_, i) => now - (i + 1) * 3600_000);
  referee.startSession(state, 'delete', siteId, undefined, now);
  const types = state.session!.steps.filter((s) => s.type !== 'DELAY').map((s) => s.type);
  assert.ok(state.session!.steps.some((s) => s.type === 'DELAY'), 'the plan has a waiting step');

  // walk the clock past every claim window without claiming
  referee.tick(state, now + 6 * 3600_000 + 1);
  assert.equal(state.session, null, 'the stale attempt is gone');

  referee.startSession(state, 'delete', siteId, undefined, now + 6 * 3600_000 + 2);
  const again = state.session!.steps.filter((s) => s.type !== 'DELAY').map((s) => s.type);
  assert.equal([...again].sort().join('+'), [...types].sort().join('+'),
    'sitting out the wait is not a re-roll');
});

test('a state file whose session points past its steps is not loaded', () => {
  // Every referee operation reads steps[stepIndex]. An out-of-range index —
  // from a half-written file after a crash — would throw on every attempt to
  // finish OR cancel it, leaving the site wedged until the session aged out.
  const file = process.env.BREAKER_STATE!;
  const backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  try {
    fs.writeFileSync(file, JSON.stringify({
      version: 1, sites: [], unlockLog: [], lastCombo: null, dohApplied: false,
      usage: { days: [], labels: {}, enabled: true },
      session: {
        id: 'ses_x', kind: 'pause', siteId: 'site_x', steps: [
          { id: 'st1', type: 'TRANSCRIBE', text: 'abc' },
        ], stepIndex: 5, createdAt: Date.now(),
      },
    }));
    const loaded = loadState();
    assert.equal(loaded.session, null, 'the unusable session is dropped');
  } finally {
    if (backup !== null) fs.writeFileSync(file, backup);
  }
});

test('a corrupted focus log does not take the statistics down with it', () => {
  // A napló kívülről jön (állapotfájl). Ha nem tömb, a statisztika `filter`-e
  // KIVÉTELT dobna — és a felhasználó egy üres statisztika-képernyőt látna,
  // aminek semmi köze nem lenne a méréshez.
  const file = process.env.BREAKER_STATE!;
  const backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  try {
    fs.writeFileSync(file, JSON.stringify({
      version: 1, sites: [], unlockLog: [], lastCombo: null, dohApplied: false,
      usage: { days: [], labels: {}, enabled: true }, session: null,
      focusLog: 'ez nem tömb',
    }));
    assert.deepEqual(loadState().focusLog, [], 'a szemét kiesik, nem dob');

    // És egyetlen rossz SOR sem viszi el a többit.
    fs.writeFileSync(file, JSON.stringify({
      version: 1, sites: [], unlockLog: [], lastCombo: null, dohApplied: false,
      usage: { days: [], labels: {}, enabled: true }, session: null,
      focusLog: [
        null,
        { packId: 'p1' },
        {
          packId: 'p1', packName: 'Jó', startedAt: 1, endedAt: 2,
          plannedEndsAt: 2, stopped: false,
        },
      ],
    }));
    assert.equal(loadState().focusLog?.length, 1);
  } finally {
    if (backup !== null) fs.writeFileSync(file, backup);
  }
});

test('a state file with a valid session keeps it', () => {
  const file = process.env.BREAKER_STATE!;
  const backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  try {
    fs.writeFileSync(file, JSON.stringify({
      version: 1, sites: [], unlockLog: [], lastCombo: null, dohApplied: false,
      usage: { days: [], labels: {}, enabled: true },
      session: {
        id: 'ses_x', kind: 'pause', siteId: 'site_x', steps: [
          { id: 'st1', type: 'TRANSCRIBE', text: 'abc' },
        ], stepIndex: 0, createdAt: Date.now(),
      },
    }));
    assert.equal(loadState().session?.id, 'ses_x');
  } finally {
    if (backup !== null) fs.writeFileSync(file, backup);
  }
});

test('a cancelled attempt on another site does not clear the first site\'s debt', () => {
  // The one-slot version of this was still re-rollable: give up on site A, then
  // start and cancel anything on site B, and site A drew a fresh pair again.
  const { state, siteId } = stateWithSite();
  const otherId = newId('site');
  state.sites.push({
    id: otherId, domain: 'reddit.com', hostnames: ['reddit.com'],
    addedAt: Date.now(), pauseUntil: null, pendingDeleteAt: null,
  });
  const now = Date.now();

  referee.startSession(state, 'pause', siteId, 15, now);
  const owed = [...state.session!.steps.map((s) => s.type)].sort().join('+');
  referee.abandonSession(state, state.session!.id);

  // a detour through the other site
  referee.startSession(state, 'pause', otherId, 15, now + 1000);
  referee.abandonSession(state, state.session!.id);

  referee.startSession(state, 'pause', siteId, 15, now + 2000);
  assert.equal([...state.session!.steps.map((s) => s.type)].sort().join('+'), owed,
    'the first site still owes its own pair');
});

test('cancelling the delete flow does not re-roll the pause flow', () => {
  // Same hole, one step removed: pause and delete draw from the same pool, so
  // a cancelled delete must not hand back a fresh pair for the pause attempt.
  const { state, siteId } = stateWithSite();
  const now = Date.now();

  referee.startSession(state, 'pause', siteId, 15, now);
  const owed = [...state.session!.steps.map((s) => s.type)].sort().join('+');
  referee.abandonSession(state, state.session!.id);

  referee.startSession(state, 'delete', siteId, undefined, now + 1000);
  const deleteTypes = state.session!.steps.filter((s) => s.type !== 'DELAY')
    .map((s) => s.type).sort().join('+');
  assert.equal(deleteTypes, owed, 'the delete attempt inherits the same pair');
  referee.abandonSession(state, state.session!.id);

  referee.startSession(state, 'pause', siteId, 15, now + 2000);
  assert.equal([...state.session!.steps.map((s) => s.type)].sort().join('+'), owed);
});

test('moving the system clock forward does not skip a waiting step', () => {
  // Waiting IS the challenge here. If a DELAY could be claimed by setting the
  // clock forward, the hardest step in the whole system would cost two clicks.
  const { state, siteId } = stateWithSite();
  const now = Date.now();
  state.unlockLog = Array.from({ length: 8 }, (_, i) => now - (i + 1) * 3600_000); // tier 3
  referee.startSession(state, 'delete', siteId, undefined, now);
  while (state.session!.steps[state.session!.stepIndex].type !== 'DELAY') {
    const step = state.session!.steps[state.session!.stepIndex];
    referee.submitAnswer(state, state.session!.id, solveStep(step, now), now);
  }
  const delay = state.session!.steps[state.session!.stepIndex] as DelayStep;
  const target = delay.claimableAt!;
  referee.tick(state, now); // establishes the tick baseline

  // "next year", in one step
  const jumped = now + 365 * 24 * 3600_000;
  referee.tick(state, jumped);
  const after = state.session!.steps[state.session!.stepIndex] as DelayStep;
  assert.ok(after.claimableAt! > jumped,
    'the waiting target moved with the clock, so the wait still lies ahead');
  const claim = referee.claimDelay(state, state.session!.id, jumped);
  assert.equal(claim.accepted, false, 'claiming is still refused');
  assert.match(claim.message ?? '', /várni kell/);
  assert.ok(after.claimableAt! - target > 0);
});

test('a pending deletion cannot be rushed by the clock either', () => {
  const { state, siteId } = stateWithSite();
  const now = Date.now();
  state.sites[0].pendingDeleteAt = now + 24 * 3600_000;
  referee.tick(state, now);
  referee.tick(state, now + 48 * 3600_000);
  assert.equal(state.sites.length, 1, 'the site is still there');
  assert.ok(state.sites[0].pendingDeleteAt! > now + 48 * 3600_000);
});

test('az órát előreállítva sem lehet leállítani a futó munkamenetet', () => {
  // A KIBÚVÓ, amit ez zár: a menet leállítása próbatétel. Ha az óra
  // előreállítása „lejáratná” a menetet, a próbatétel megkerülhető lenne — és
  // nem is csak ezen a gépen: a lejárás lépteti a szinkron-számlálót, a
  // nagyobb `rev` pedig lazítani is tud, tehát a telefonon is leállna.
  //
  // A szabály egy mondat: amennyi hátra volt, annyi van hátra.
  const { state } = stateWithSite();
  const now = Date.now();
  state.focusPacks = [{
    id: 'p1', name: 'Nyelvtanulás', allowSites: ['quizlet.com'], allowApps: [], defaultMinutes: 50,
  }];
  state.focusRun = { packId: 'p1', startedAt: now, endsAt: now + 50 * 60_000 };
  referee.tick(state, now); // ez állítja be az alapot

  const jumped = now + 8 * 3600_000; // „nyolc órával később”, egy lépésben
  referee.tick(state, jumped);

  assert.ok(state.focusRun, 'a menet nem állt le');
  const left = state.focusRun!.endsAt - jumped;
  // Két perc a rendes ütem tűrése; ennyivel kevesebb marad, semmi több.
  assert.ok(
    left > 47 * 60_000 && left <= 50 * 60_000,
    `nagyjából ötven percnek kell hátra lennie, de ${Math.round(left / 60_000)} perc van`,
  );
  assert.equal(
    state.focusRun!.endsAt - state.focusRun!.startedAt, 50 * 60_000,
    'a menet HOSSZA nem változott — a kezdés is tolódott, különben a napló hazudna',
  );
  assert.equal((state.focusLog ?? []).length, 0, 'és nem is került a naplóba lezártként');
});

test('a rendes ütem nem tolja el a futó munkamenetet', () => {
  // A védekezés nem szólhat bele a hétköznapi működésbe: egy ötvenperces menet
  // ötven perc múlva jár le, nem ötvenkettő múlva.
  const { state } = stateWithSite();
  const now = Date.now();
  state.focusPacks = [{
    id: 'p1', name: 'Nyelvtanulás', allowSites: ['quizlet.com'], allowApps: [], defaultMinutes: 50,
  }];
  state.focusRun = { packId: 'p1', startedAt: now, endsAt: now + 50 * 60_000 };
  referee.tick(state, now);
  referee.tick(state, now + 15_000);
  assert.equal(state.focusRun!.endsAt, now + 50 * 60_000, 'érintetlen');

  // És a saját idejében LE IS JÁR — a védekezés nem teszi örökössé.
  //
  // Rendes ütemben lépkedünk, mert a segéd is így ketyeg. Egyetlen ötvenperces
  // ugrás maga is „óraugrás” lenne, és akkor nem azt mérnénk, amit akarunk.
  for (let t = 15_000; t <= 50 * 60_000 + 60_000; t += 60_000) referee.tick(state, now + t);
  assert.equal(state.focusRun, null, 'lejárt');
  assert.equal((state.focusLog ?? []).length, 1, 'és bekerült a naplóba');
  assert.equal(state.focusLog![0].stopped, false, 'magától járt le, nem állították le');
});

test('normal tick cadence is not treated as a clock jump', () => {
  const { state, siteId } = stateWithSite();
  const now = Date.now();
  state.sites[0].pendingDeleteAt = now + 60_000;
  referee.tick(state, now);
  referee.tick(state, now + 15_000);   // ordinary tick
  assert.equal(state.sites[0].pendingDeleteAt, now + 60_000, 'untouched');
  referee.tick(state, now + 61_000);   // the deletion is genuinely due
  assert.equal(state.sites.length, 0, 'and it runs on time');
});

test('daily budget: tightening applies at once, loosening needs the challenges', () => {
  const { state, siteId } = stateWithSite();
  const now = Date.now();

  // introducing a budget is a tightening
  const add = referee.startLimitChange(state, siteId, 20 * 60, now);
  assert.equal(add.applied, true);
  assert.equal(state.sites[0].dailyLimitSeconds, 20 * 60);

  // lowering it too
  const lower = referee.startLimitChange(state, siteId, 10 * 60, now);
  assert.equal(lower.applied, true);
  assert.equal(state.sites[0].dailyLimitSeconds, 10 * 60);

  // raising it buys time on the site -> gated
  const raise = referee.startLimitChange(state, siteId, 60 * 60, now);
  assert.equal(raise.applied, false);
  assert.ok(raise.session);
  assert.equal(state.sites[0].dailyLimitSeconds, 10 * 60, 'not applied yet');

  let guard = 0;
  while (state.session && guard++ < 200) {
    const step = state.session.steps[state.session.stepIndex];
    referee.submitAnswer(state, state.session.id, solveStep(step, now), now);
  }
  assert.equal(state.sites[0].dailyLimitSeconds, 60 * 60, 'applied on completion');
  assert.equal(state.sites[0].pauseUntil, null, 'and it is not a pause');
});

test('removing the budget is also gated, and removal really removes it', () => {
  const { state, siteId } = stateWithSite();
  const now = Date.now();
  referee.startLimitChange(state, siteId, 15 * 60, now);

  const remove = referee.startLimitChange(state, siteId, null, now);
  assert.equal(remove.applied, false, 'a free day must be earned');

  let guard = 0;
  while (state.session && guard++ < 200) {
    const step = state.session.steps[state.session.stepIndex];
    referee.submitAnswer(state, state.session.id, solveStep(step, now), now);
  }
  assert.equal(state.sites[0].dailyLimitSeconds, undefined);
});

test('a spent budget blocks the site in the hosts file', () => {
  const { state, siteId } = stateWithSite();
  const now = Date.now();
  // free right now by schedule (a band that does not cover the moment)
  state.sites[0].schedule = {
    mode: 'scheduled_block',
    bands: [{ days: [new Date(now).getDay() === 3 ? 4 : 3] as (0|1|2|3|4|5|6)[], startMin: 0, endMin: 1 }],
  };
  referee.startLimitChange(state, siteId, 600, now);
  assert.deepEqual(activeHostnames(state, now), [], 'schedule allows it and the budget has room');

  // …until today's measured time reaches the budget
  recordSample(state.usage, siteKey('youtube.com'), 600, now, 'youtube.com');
  assert.deepEqual(activeHostnames(state, now), ['www.youtube.com', 'youtube.com'],
    'the spent budget blocks by itself');
});
