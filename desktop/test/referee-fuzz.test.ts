// Randomised interaction test for the referee.
//
// The single promise this app makes is that a site cannot become reachable
// without completing the challenges. The other tests check that one flow at a
// time; this one throws thousands of random interleavings at the referee —
// starting attempts, answering right and wrong, abandoning, claiming, editing
// schedules, jumping the clock — and asserts the invariants after EVERY step.
//
// The sequence is driven by a seeded generator, so a failure is reproducible:
// the seed is printed with the assertion.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-fuzz-'));
process.env.BREAKER_STATE = path.join(tmp, 'state.json');
process.env.BREAKER_HOSTS = path.join(tmp, 'hosts');
fs.writeFileSync(process.env.BREAKER_HOSTS, '127.0.0.1 localhost\n');

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { defaultState, newId, type HelperState } from '../src/helper/state';
import * as referee from '../src/helper/referee';
import { RefereeError } from '../src/helper/referee';
import { reverseString, type MathChainStep, type MemoryStep, type ReverseStep, type Step, type TranscribeStep } from '../src/shared/challenges';

/** Deterministic PRNG (mulberry32) so a failing run can be replayed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function correctAnswer(step: Step, now: number): string {
  switch (step.type) {
    case 'TRANSCRIBE': return (step as TranscribeStep).text;
    case 'MATH_CHAIN': { const m = step as MathChainStep; return String(m.problems[m.pos].a); }
    case 'MEMORY': {
      const m = step as MemoryStep;
      m.armedAt = now - m.showMs - m.waitMs - 1000; // sat through the window
      return m.code;
    }
    case 'REVERSE': return reverseString((step as ReverseStep).text);
    case 'DELAY': return '';
  }
}

interface Snapshot {
  paused: Set<string>;
  deleting: Set<string>;
  schedules: Map<string, string>;
}

function snapshot(state: HelperState, now: number): Snapshot {
  return {
    paused: new Set(state.sites.filter((s) => s.pauseUntil !== null && s.pauseUntil > now).map((s) => s.id)),
    deleting: new Set(state.sites.filter((s) => s.pendingDeleteAt !== null).map((s) => s.id)),
    schedules: new Map(state.sites.map((s) => [s.id, JSON.stringify(s.schedule ?? null)])),
  };
}

function runSequence(seed: number, steps: number): void {
  const r = rng(seed);
  const state = defaultState();
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const id = newId('site');
    ids.push(id);
    state.sites.push({
      id, domain: `site${i}.example`, hostnames: [`site${i}.example`],
      addedAt: 0, pauseUntil: null, pendingDeleteAt: null,
    });
  }
  let now = Date.UTC(2026, 0, 5, 9, 0, 0); // a Monday morning, fixed
  const why = (m: string) => `${m} (seed ${seed})`;

  for (let step = 0; step < steps; step++) {
    const before = snapshot(state, now);
    // Only a completed session may unlock, un-block or reschedule anything, so
    // remember whether THIS action was a completion.
    let completed = false;

    const pick = r();
    const siteId = ids[Math.floor(r() * ids.length)];
    try {
      if (pick < 0.18) {
        referee.startSession(state, r() < 0.8 ? 'pause' : 'delete', siteId,
          [15, 30, 60][Math.floor(r() * 3)], now);
      } else if (pick < 0.62 && state.session) {
        const s = state.session;
        const cur = s.steps[s.stepIndex];
        if (cur.type === 'DELAY') {
          const res = referee.claimDelay(state, s.id, now);
          completed = res.sessionDone;
        } else {
          const answer = r() < 0.75 ? correctAnswer(cur, now) : 'nem jó válasz';
          const res = referee.submitAnswer(state, s.id, answer, now);
          completed = res.sessionDone;
        }
      } else if (pick < 0.70 && state.session) {
        referee.abandonSession(state, state.session.id);
      } else if (pick < 0.80) {
        const bands = [{ days: [1, 2, 3, 4, 5] as (0|1|2|3|4|5|6)[], startMin: 540, endMin: 1020 }];
        const next = r() < 0.5
          ? { mode: 'always' as const, bands: [] }
          : { mode: 'scheduled_block' as const, bands };
        const res = referee.startScheduleChange(state, siteId, next, now);
        completed = res.applied; // a tightening applies straight away
      } else {
        referee.tick(state, now);
      }
    } catch (e) {
      assert.ok(e instanceof RefereeError,
        why(`the referee threw something other than a RefereeError: ${String(e)}`));
    }

    const after = snapshot(state, now);

    // 1. A site can only become reachable through a completed session.
    for (const id of after.paused) {
      if (!before.paused.has(id)) {
        assert.ok(completed, why(`site ${id} became unblocked without completing the challenges`));
      }
    }
    // 2. Deletion likewise (it is the bigger weakening of the two).
    for (const id of after.deleting) {
      if (!before.deleting.has(id)) {
        assert.ok(completed, why(`site ${id} entered deletion without completing the challenges`));
      }
    }
    // 3. Schedules change only on completion — and the referee itself decides
    //    whether a change was a tightening (free) or a loosening (gated).
    for (const [id, sched] of after.schedules) {
      if (before.schedules.get(id) !== sched) {
        assert.ok(completed, why(`site ${id}'s schedule changed without completing the challenges`));
      }
    }
    // 4. Bookkeeping stays bounded no matter how many attempts are abandoned.
    assert.ok((state.abandons?.length ?? 0) <= 64, why('the abandon list grew without bound'));
    // 5. Whatever the clock does, a waiting step is never claimable early.
    const s = state.session;
    if (s) {
      const cur = s.steps[s.stepIndex];
      if (cur.type === 'DELAY' && cur.claimableAt !== null && now < cur.claimableAt) {
        const res = referee.claimDelay(state, s.id, now);
        assert.equal(res.accepted, false, why('a waiting step was claimable before its time'));
      }
    }

    // Time moves on: mostly seconds, sometimes a jump (a user changing the
    // clock, or the machine waking up from a long sleep).
    now += r() < 0.1 ? Math.floor(r() * 40 * 24 * 3600_000) : Math.floor(r() * 30_000);
  }
}

test('no random sequence of actions can unlock a site without solving', () => {
  for (let seed = 1; seed <= 40; seed++) runSequence(seed, 300);
});
