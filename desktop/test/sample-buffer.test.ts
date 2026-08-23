import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { SampleBuffer } from '../src/shared/sample-buffer';
import { dayKey, MAX_BATCH_SAMPLES, MAX_BUFFER_AGE_MS } from '../src/shared/usage';

const NOW = new Date(2026, 4, 20, 15, 30).getTime();
function yesterdayNoon(now: number): number {
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - 1);
  return d.getTime();
}

test('slices for the same target and day are merged', () => {
  const buf = new SampleBuffer();
  buf.add('site:youtube.com', 'youtube.com', 5, NOW);
  buf.add('site:youtube.com', 'youtube.com', 5, NOW);
  assert.equal(buf.size, 1);
  const batch = buf.take();
  assert.equal(batch[0].sample.seconds, 10);
});

test('slices from different local days stay separate', () => {
  const buf = new SampleBuffer();
  const yesterday = yesterdayNoon(NOW);
  buf.add('site:a.com', 'a.com', 30, yesterday);
  buf.add('site:a.com', 'a.com', 20, NOW);
  assert.equal(buf.size, 2, 'a buffer spanning midnight must not merge across the boundary');
  const byDay = Object.fromEntries(buf.take().map((b) => [dayKey(b.sample.at), b.sample.seconds]));
  assert.equal(byDay[dayKey(yesterday)], 30);
  assert.equal(byDay[dayKey(NOW)], 20);
});

test('invalid slice lengths are ignored', () => {
  const buf = new SampleBuffer();
  buf.add('app:x', 'X', 0, NOW);
  buf.add('app:x', 'X', -5, NOW);
  buf.add('app:x', 'X', Number.NaN, NOW);
  assert.equal(buf.size, 0);
});

test('take empties the buffer and hands ownership over', () => {
  const buf = new SampleBuffer();
  buf.add('app:x', 'X', 5, NOW);
  const batch = buf.take();
  assert.equal(batch.length, 1);
  assert.equal(buf.size, 0);
  assert.equal(buf.take().length, 0, 'a second take yields nothing');
});

test('slices recorded during an in-flight send are not lost', () => {
  const buf = new SampleBuffer();
  buf.add('app:x', 'X', 5, NOW);
  const inFlight = buf.take();          // send starts
  buf.add('app:x', 'X', 7, NOW);        // a tick lands while it is in the air
  assert.equal(buf.size, 1, 'the new slice is in a fresh buffer, not cleared with the old one');

  // the send succeeded, so nothing is restored; the new slice survives
  const next = buf.take();
  assert.equal(next[0].sample.seconds, 7);
  assert.equal(inFlight[0].sample.seconds, 5);
});

test('a failed batch is restored and merged with what arrived meanwhile', () => {
  const buf = new SampleBuffer();
  buf.add('app:x', 'X', 5, NOW);
  const inFlight = buf.take();
  buf.add('app:x', 'X', 7, NOW);   // recorded while the send was failing
  buf.restore(inFlight, NOW);      // send failed -> put it back

  assert.equal(buf.size, 1, 'same target and day merge back into one entry');
  assert.equal(buf.take()[0].sample.seconds, 12, 'nothing measured is dropped');
});

test('restoring a batch for a different day does not collide', () => {
  const buf = new SampleBuffer();
  const yesterday = yesterdayNoon(NOW);
  buf.add('app:x', 'X', 5, yesterday);
  const inFlight = buf.take();
  buf.add('app:x', 'X', 7, NOW);
  buf.restore(inFlight, NOW);
  assert.equal(buf.size, 2, 'yesterday and today remain distinct buckets');
});

test('slices too old for the helper to accept are dropped, not retried forever', () => {
  // The helper refuses samples further than a week from now, so retrying an
  // older one is not delivery — it only looks like it. Drop it here, where it
  // can be counted and logged.
  const buf = new SampleBuffer();
  const ancient = NOW - MAX_BUFFER_AGE_MS - 3600_000;
  buf.add('app:x', 'X', 5, ancient);
  const inFlight = buf.take();
  buf.restore(inFlight, NOW);

  assert.equal(buf.size, 0, 'the aged-out slice is not put back');
  assert.equal(buf.takeDropped(), 1, 'and the drop is reported');
  assert.equal(buf.takeDropped(), 0, 'the counter resets when read');
});

test('a slice still inside the acceptance window is retried', () => {
  const buf = new SampleBuffer();
  const old = NOW - MAX_BUFFER_AGE_MS + 3600_000; // just inside
  buf.add('app:x', 'X', 5, old);
  buf.restore(buf.take(), NOW);
  assert.equal(buf.size, 1);
  assert.equal(buf.takeDropped(), 0);
});

test('the buffer stays within one batch even during a long outage', () => {
  // Without a cap the pending map grows for as long as the helper is down, and
  // take() would hand back more than one request can carry — the surplus would
  // be truncated away on the other side without anyone noticing.
  const buf = new SampleBuffer();
  for (let i = 0; i < MAX_BATCH_SAMPLES + 250; i++) {
    buf.add(`site:host${i}.example`, `host${i}`, 5, NOW - i * 1000);
  }
  assert.equal(buf.size, MAX_BATCH_SAMPLES, 'the buffer is bounded');
  assert.equal(buf.takeDropped(), 250, 'the overflow is counted');
});

test('when the buffer overflows the oldest slices go first', () => {
  const buf = new SampleBuffer();
  buf.add('app:oldest', 'oldest', 5, NOW - 48 * 3600_000);
  for (let i = 0; i < MAX_BATCH_SAMPLES; i++) {
    buf.add(`site:host${i}.example`, `host${i}`, 5, NOW);
  }
  const keys = buf.take().map((b) => b.sample.key);
  assert.ok(!keys.includes('app:oldest'), 'the oldest bucket is the one evicted');
  assert.equal(keys.length, MAX_BATCH_SAMPLES);
});
