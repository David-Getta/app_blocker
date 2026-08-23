// End-to-end referee + hosts engine tests, run against temp files via the
// LAKAT_STATE / LAKAT_HOSTS env overrides.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lakat-test-'));
process.env.LAKAT_STATE = path.join(tmp, 'state.json');
process.env.LAKAT_HOSTS = path.join(tmp, 'hosts');
fs.writeFileSync(process.env.LAKAT_HOSTS, '127.0.0.1 localhost\n');

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { defaultState, newId } from '../src/helper/state';
import type { HelperState } from '../src/helper/state';
import * as referee from '../src/helper/referee';
import { applyBlocklist, activeHostnames } from '../src/helper/hosts';
import type { Step, DelayStep, MathChainStep, MemoryStep, ReverseStep, TranscribeStep } from '../src/shared/challenges';
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
  let hosts = fs.readFileSync(process.env.LAKAT_HOSTS!, 'utf8');
  assert.ok(hosts.includes('0.0.0.0 youtube.com'));
  assert.ok(hosts.includes('127.0.0.1 localhost'));

  // no-op when unchanged
  assert.equal(applyBlocklist(state, now), false);

  // manual tamper -> re-apply restores
  fs.writeFileSync(process.env.LAKAT_HOSTS!, '127.0.0.1 localhost\n');
  assert.equal(applyBlocklist(state, now), true);
  hosts = fs.readFileSync(process.env.LAKAT_HOSTS!, 'utf8');
  assert.ok(hosts.includes('0.0.0.0 youtube.com'));

  // paused site drops out of the hosts file
  state.sites[0].pauseUntil = now + 60_000;
  assert.equal(applyBlocklist(state, now), true);
  hosts = fs.readFileSync(process.env.LAKAT_HOSTS!, 'utf8');
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
  for (let i = 0; i < 300 && !first; i++) {
    referee.startSession(state, 'pause', siteId, 15, now);
    const s = state.session!.steps[state.session!.stepIndex];
    if (s.type === 'MEMORY') first = s;
  }
  assert.ok(first, 'a MEMORY step shows up in a randomised plan');
  assert.equal(first!.armedAt, now, 'the opening step is armed when the session starts');

  const after = now + first!.showMs + first!.waitMs + 1_000; // sat through the window
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
