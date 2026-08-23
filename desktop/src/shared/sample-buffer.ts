// Buffering of measured time slices before they are shipped to the helper.
//
// Extracted from the tracker so this logic is testable without Electron: the
// tricky parts are all here — merging slices per (target, local day), not
// losing slices recorded while a send is in flight, putting a failed batch back
// without dropping what arrived meanwhile, and staying bounded when the helper
// stays unreachable for a long time.

import { dayKey, MAX_BATCH_SAMPLES, MAX_BUFFER_AGE_MS } from './usage';
import type { UsageSampleMsg } from './protocol';

export class SampleBuffer {
  private pending = new Map<string, UsageSampleMsg>();
  /** slices thrown away because they aged out or the buffer was full */
  private droppedCount = 0;

  get size(): number {
    return this.pending.size;
  }

  /** How many buckets were discarded since the last `takeDropped()`. */
  takeDropped(): number {
    const n = this.droppedCount;
    this.droppedCount = 0;
    return n;
  }

  /**
   * Adds a measured slice. Slices are merged per target AND per local day, so a
   * buffer that spans midnight never dumps the earlier day's seconds into the
   * later day's bucket.
   */
  add(key: string, label: string, seconds: number, at: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const bucket = `${key}@${dayKey(at)}`;
    const existing = this.pending.get(bucket);
    if (existing) existing.seconds += seconds;
    else this.pending.set(bucket, { key, label, seconds, at });
    this.enforceCap(at);
  }

  /**
   * Removes and returns everything buffered so far. The caller owns the result;
   * slices recorded while it is being sent accumulate into a fresh buffer
   * instead of being cleared away with it.
   */
  take(): { bucket: string; sample: UsageSampleMsg }[] {
    const out = [...this.pending.entries()].map(([bucket, sample]) => ({ bucket, sample }));
    this.pending = new Map();
    return out;
  }

  /**
   * Puts a failed batch back, merging with anything recorded meanwhile.
   * Delivery is therefore at-least-once: a batch the helper stored but could
   * not acknowledge may be counted twice. Losing measured time is the worse
   * failure of the two, so the retry wins.
   *
   * Retrying is not unconditional though. A slice keeps its original timestamp
   * (that is the whole point — it belongs to the day it was measured on), and
   * the helper refuses anything more than a week away from now. Past that age
   * a retry is not delivery, it is a silent discard on the other side, so the
   * drop happens here where it can at least be counted and logged.
   */
  restore(batch: { bucket: string; sample: UsageSampleMsg }[], now: number): void {
    for (const { bucket, sample } of batch) {
      if (this.tooOld(sample.at, now)) { this.droppedCount++; continue; }
      const current = this.pending.get(bucket);
      if (current) current.seconds += sample.seconds;
      else this.pending.set(bucket, sample);
    }
    this.enforceCap(now);
  }

  private tooOld(at: number, now: number): boolean {
    return !Number.isFinite(at) || now - at > MAX_BUFFER_AGE_MS;
  }

  /**
   * Keeps the buffer bounded in both directions: nothing older than the
   * acceptance window survives, and the map never grows past what one request
   * can carry. When it is still too big the OLDEST buckets go first — recent
   * time is the part the user is about to look at in the statistics.
   */
  private enforceCap(now: number): void {
    for (const [bucket, sample] of this.pending) {
      if (this.tooOld(sample.at, now)) { this.pending.delete(bucket); this.droppedCount++; }
    }
    if (this.pending.size <= MAX_BATCH_SAMPLES) return;
    const byAge = [...this.pending.entries()].sort((a, b) => a[1].at - b[1].at);
    const excess = this.pending.size - MAX_BATCH_SAMPLES;
    for (let i = 0; i < excess; i++) {
      this.pending.delete(byAge[i][0]);
      this.droppedCount++;
    }
  }
}
