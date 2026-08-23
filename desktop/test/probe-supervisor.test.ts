import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ProbeSupervisor, PROBE_HEALTHY_MS } from '../src/shared/probe-supervisor';

const T0 = 1_700_000_000_000;

test('a probe that fails to start does not block every later attempt', () => {
  // The bug this exists for: the tracker remembered a child that never came up
  // and its "already running" guard then refused every restart, so Windows
  // usage tracking stopped for the whole session without a single error.
  const sup = new ProbeSupervisor();
  assert.equal(sup.canStart(T0), true);
  sup.started(T0);
  assert.equal(sup.canStart(T0), false, 'no second probe while one is running');

  sup.ended(T0 + 50); // spawn error, arrives almost immediately
  assert.equal(sup.isRunning, false);
  const { retryInMs } = new ProbeSupervisor().ended(T0); // a stray event is harmless
  assert.equal(retryInMs, 0);
  assert.equal(sup.canStart(T0 + 60_000), true, 'a retry is possible again');
});

test('repeated instant failures back off instead of respawning every tick', () => {
  const sup = new ProbeSupervisor();
  let now = T0;
  const delays: number[] = [];
  for (let i = 0; i < 6; i++) {
    assert.equal(sup.canStart(now), true, `attempt ${i + 1} is allowed`);
    sup.started(now);
    const { retryInMs } = sup.ended(now + 10);
    delays.push(retryInMs);
    assert.equal(sup.canStart(now + 10), retryInMs === 0, 'the backoff is respected');
    now += 10 + retryInMs;
  }
  assert.deepEqual(delays, [5_000, 15_000, 60_000, 300_000, 300_000, 300_000],
    'growing, then capped — never a tight respawn loop');
});

test('a probe that ran fine and then exited restarts immediately', () => {
  const sup = new ProbeSupervisor();
  sup.started(T0);
  const { retryInMs, failures } = sup.ended(T0 + PROBE_HEALTHY_MS + 1);
  assert.equal(failures, 0, 'a long-lived probe exiting is not a failure');
  assert.equal(retryInMs, 0);
  assert.equal(sup.canStart(T0 + PROBE_HEALTHY_MS + 1), true);
});

test('a healthy run clears the failure history', () => {
  const sup = new ProbeSupervisor();
  let now = T0;
  for (let i = 0; i < 3; i++) { sup.started(now); now += 10 + sup.ended(now + 10).retryInMs; }
  assert.equal(sup.failureCount, 3);
  sup.started(now);
  sup.ended(now + PROBE_HEALTHY_MS);
  assert.equal(sup.failureCount, 0, 'the backoff does not carry over past a working run');
});

test('a deliberate stop forgets the backoff', () => {
  const sup = new ProbeSupervisor();
  sup.started(T0);
  sup.ended(T0 + 10);
  assert.equal(sup.canStart(T0 + 10), false);
  sup.reset(); // tracker stopped, e.g. tracking switched off and back on
  assert.equal(sup.canStart(T0 + 10), true, 'restarting tracking must not wait out a backoff');
});
