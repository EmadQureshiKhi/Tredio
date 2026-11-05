import type { Sender } from "@tredio/chain";
import type { Action, ActionKind } from "./plan";

/**
 * Sends actions, each key at most once at a time. A failed action waits before it is tried again
 * (doubling up to ten minutes), so a call that keeps reverting (a market already listed, a
 * settlement not observed yet) does not burn gas every scan.
 */
export class Executor {
  private readonly inflight = new Set<string>();
  private readonly backoff = new Map<string, { until: number; delayMs: number }>();
  readonly sent: Partial<Record<ActionKind, number>> = {};
  failed = 0;
  lastError: string | null = null;
  lastErrorAt: number | null = null;

  constructor(
    private readonly sender: Sender,
    private readonly log: (fields: Record<string, unknown>, msg: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  get pending(): number {
    return this.inflight.size;
  }

  /** Starts every action that is not in flight or backing off, at most `max`; resolves when they finish. */
  async run(actions: readonly Action[], max: number): Promise<number> {
    const t = this.now();
    const due = actions.filter((a) => !this.inflight.has(a.key) && (this.backoff.get(a.key)?.until ?? 0) <= t).slice(0, max);
    await Promise.all(due.map((a) => this.send(a)));
    return due.length;
  }

  private async send(a: Action): Promise<void> {
    this.inflight.add(a.key);
    try {
      const r = await this.sender.send(a.call);
      this.sent[a.kind] = (this.sent[a.kind] ?? 0) + 1;
      this.backoff.delete(a.key);
      this.log({ action: a.kind, key: a.key, reason: a.reason, tx: r.hash }, "action sent");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const prev = this.backoff.get(a.key)?.delayMs ?? 15_000;
      const delayMs = Math.min(prev * 2, 600_000);
      this.backoff.set(a.key, { until: this.now() + delayMs, delayMs });
      this.failed++;
      this.lastError = `${a.kind}: ${message.slice(0, 200)}`;
      this.lastErrorAt = this.now();
      this.log({ action: a.kind, key: a.key, err: message.slice(0, 300), retryInMs: delayMs }, "action failed");
    } finally {
      this.inflight.delete(a.key);
    }
  }
}
