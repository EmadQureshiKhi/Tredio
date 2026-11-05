/**
 * Spaces one provider's calls out over time: one call at a time, a random gap after each call, and a
 * minimum (jittered) gap before the same key is used again. Callers that cannot wait ask first
 * (`waitMs`) and skip this round; callers that can wait queue for their turn.
 */

export interface PacerOptions {
  /** Shortest gap after a call ends before the next may start. */
  minGapMs: number;
  /** Longest such gap; each gap is drawn at random between the two. */
  maxGapMs: number;
  /** Gap before the same key may be used again. */
  keyGapMs: number;
  /** How far each key gap may stray from keyGapMs, as a fraction (0.3 is plus or minus 30%). */
  keyJitter: number;
}

/** The next call is not due yet; `waitMs` says when it is. */
export class PacedError extends Error {
  constructor(
    readonly source: string,
    readonly waitMs: number,
  ) {
    super(`${source}: next call not due for ${Math.ceil(waitMs / 1000)}s`);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class CallPacer {
  private chain: Promise<unknown> = Promise.resolve();
  /** Calls running or waiting for their turn. */
  private queued = 0;
  private nextAt = 0;
  private readonly keyNextAt = new Map<string, number>();

  constructor(
    readonly source: string,
    private readonly opts: PacerOptions,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {
    if (opts.minGapMs < 0 || opts.maxGapMs < opts.minGapMs) throw new Error(`${source}: the call gap must run from a minimum up to a maximum`);
    if (opts.keyJitter < 0 || opts.keyJitter >= 1) throw new Error(`${source}: key gap jitter must be at least 0 and below 1`);
  }

  /** Milliseconds until a new call could start: 0 when none is running or queued and the gap has passed. */
  waitMs(): number {
    const gap = Math.max(0, this.nextAt - this.now());
    return this.queued > 0 ? Math.max(1, gap) : gap;
  }

  /** Whether `keyId` has rested long enough since its last use. */
  keyReady(keyId: string): boolean {
    return (this.keyNextAt.get(keyId) ?? 0) <= this.now();
  }

  /** Milliseconds until `keyId` may be used again (0 when it may now). */
  keyWaitMs(keyId: string): number {
    return Math.max(0, (this.keyNextAt.get(keyId) ?? 0) - this.now());
  }

  /** Marks `keyId` used now: it rests for its jittered gap. */
  used(keyId: string): void {
    const j = this.opts.keyJitter;
    this.keyNextAt.set(keyId, this.now() + this.opts.keyGapMs * (1 - j + 2 * j * this.random()));
  }

  /**
   * Runs `fn` in its turn. With `wait` false it throws PacedError instead of queueing when the next
   * call is not due; with `wait` true it waits for the running call and the gap after it.
   */
  run<T>(fn: () => Promise<T>, wait: boolean): Promise<T> {
    const due = this.waitMs();
    if (!wait && due > 0) return Promise.reject(new PacedError(this.source, due));
    this.queued++;
    const turn = this.chain.then(async () => {
      const delay = this.nextAt - this.now();
      if (delay > 0) await this.wait(delay);
      try {
        return await fn();
      } finally {
        this.nextAt = this.now() + this.gap();
        this.queued--;
      }
    });
    this.chain = turn.catch(() => undefined);
    return turn;
  }

  /** A random gap between the configured bounds. */
  gap(): number {
    return this.opts.minGapMs + this.random() * (this.opts.maxGapMs - this.opts.minGapMs);
  }
}
