// Restart policy for a long-lived child process probe (the Windows foreground
// prober). Pure, so the failure paths can be tested without spawning anything.
//
// Two failure modes this exists to prevent:
//   1. A dead probe that is still remembered as "running" — the restart guard
//      then blocks every retry and tracking silently stops for the session.
//   2. A probe that cannot start at all (missing powershell.exe, locked-down
//      execution policy) being respawned every few seconds forever.

/** Delay before attempt N+1 after N consecutive failures. Last value repeats. */
export const PROBE_BACKOFF_MS = [0, 5_000, 15_000, 60_000, 300_000];
/** A probe that lived at least this long counts as healthy: its exit resets the backoff. */
export const PROBE_HEALTHY_MS = 60_000;

export class ProbeSupervisor {
  private running = false;
  private failures = 0;
  private startedAt = 0;
  private nextAttemptAt = 0;

  get isRunning(): boolean {
    return this.running;
  }

  /** Consecutive failed (short-lived) starts. */
  get failureCount(): number {
    return this.failures;
  }

  canStart(now: number): boolean {
    return !this.running && now >= this.nextAttemptAt;
  }

  started(now: number): void {
    this.running = true;
    this.startedAt = now;
  }

  /**
   * The probe ended — normal exit, close, or a spawn error, all of which land
   * here. Returns how long the caller must wait before the next attempt.
   */
  ended(now: number): { retryInMs: number; failures: number } {
    if (!this.running) return { retryInMs: Math.max(0, this.nextAttemptAt - now), failures: this.failures };
    this.running = false;
    if (now - this.startedAt >= PROBE_HEALTHY_MS) this.failures = 0; // it worked; this is just an exit
    else this.failures += 1;
    const delay = PROBE_BACKOFF_MS[Math.min(this.failures, PROBE_BACKOFF_MS.length - 1)];
    this.nextAttemptAt = now + delay;
    return { retryInMs: delay, failures: this.failures };
  }

  /** Deliberate stop (tracker shutting down): forget the failure history too. */
  reset(): void {
    this.running = false;
    this.failures = 0;
    this.startedAt = 0;
    this.nextAttemptAt = 0;
  }
}
