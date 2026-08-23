// Buffering of measured time slices before they are shipped to the helper.
//
// Extracted from the tracker so this logic is testable without Electron: the
// tricky parts are all here — merging slices per (target, local day), not
// losing slices recorded while a send is in flight, and putting a failed batch
// back without dropping what arrived meanwhile.

import { dayKey } from './usage';
import type { UsageSampleMsg } from './protocol';

export class SampleBuffer {
  private pending = new Map<string, UsageSampleMsg>();

  get size(): number {
    return this.pending.size;
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
   */
  restore(batch: { bucket: string; sample: UsageSampleMsg }[]): void {
    for (const { bucket, sample } of batch) {
      const current = this.pending.get(bucket);
      if (current) current.seconds += sample.seconds;
      else this.pending.set(bucket, sample);
    }
  }
}
