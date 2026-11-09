import { formatUsdc, microUsdc } from "./config";
import type { JobAssignment } from "./market";

/**
 * The agent's own terms: a price per call and a daily cap on the calls it takes.
 *
 * - A hire must hold at least the price in an accepted token. A hire holding nothing is a free
 *   test run, which only the agent's owner or a market admin can start; a few a day are taken.
 * - The cap counts calls accepted (started) per UTC day. Past it a hire is declined as
 *   `rejected`, and the caller is refunded (on an A2A call, never charged).
 * - The market is the record: at start the ledger counts the day's assignments it already
 *   started, so a restart does not reset the cap.
 */

export type Terms = { ok: true; kind: "paid" | "test" } | { ok: false; reason: string };

export interface LedgerOptions {
  /** Price per call, micro USDC. */
  price: bigint;
  acceptTokens: readonly string[];
  dailyCap: number;
  freeTestsPerDay: number;
  now?: () => number;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class DailyLedger {
  private readonly now: () => number;
  private today: string;
  private readonly taken = new Map<string, "paid" | "test">();

  constructor(private readonly o: LedgerOptions) {
    this.now = o.now ?? Date.now;
    this.today = day(this.now());
  }

  /** Moves to a new UTC day when one began. */
  private roll(): void {
    const d = day(this.now());
    if (d !== this.today) {
      this.today = d;
      this.taken.clear();
    }
  }

  /** Whether the hire's escrow meets the price (amounts are decimal strings, for example "0.050000000000"). */
  terms(a: Pick<JobAssignment, "escrowAmount" | "escrowToken">): Terms {
    let held: bigint;
    try {
      held = microUsdc(a.escrowAmount);
    } catch {
      return { ok: false, reason: `the hire's escrow amount (${a.escrowAmount}) is not a number` };
    }
    if (held === 0n) return this.o.freeTestsPerDay > 0 ? { ok: true, kind: "test" } : { ok: false, reason: "this agent takes no unpaid calls" };
    if (!this.o.acceptTokens.includes(a.escrowToken.toUpperCase())) return { ok: false, reason: `this agent is paid in ${this.o.acceptTokens.join(" or ")}, not ${a.escrowToken}` };
    if (held < this.o.price) return { ok: false, reason: `this agent's price is ${formatUsdc(this.o.price)} USDC a call; this hire holds ${a.escrowAmount} ${a.escrowToken}` };
    return { ok: true, kind: "paid" };
  }

  /** Whether one more call of `kind` fits today (without taking it). */
  room(kind: "paid" | "test"): { ok: true } | { ok: false; reason: string } {
    this.roll();
    if (this.taken.size >= this.o.dailyCap) return { ok: false, reason: `this agent's daily capacity (${this.o.dailyCap} calls) is used up; it takes calls again after 00:00 UTC` };
    if (kind === "test" && this.count("test") >= this.o.freeTestsPerDay) return { ok: false, reason: `the day's free test runs (${this.o.freeTestsPerDay}) are used up` };
    return { ok: true };
  }

  /** Takes the call; false when it does not fit. Taking the same assignment again is a no-op that answers true. */
  take(assignmentId: string, kind: "paid" | "test"): boolean {
    this.roll();
    if (this.taken.has(assignmentId)) return true;
    if (!this.room(kind).ok) return false;
    this.taken.set(assignmentId, kind);
    return true;
  }

  has(assignmentId: string): boolean {
    this.roll();
    return this.taken.has(assignmentId);
  }

  /** Counts the assignments started today (from the market's own record), so a restart keeps the cap. */
  seed(rows: ReadonlyArray<Pick<JobAssignment, "assignmentId" | "startedAt" | "escrowAmount">>): number {
    this.roll();
    let n = 0;
    for (const r of rows) {
      if (!r.startedAt || day(Date.parse(r.startedAt)) !== this.today || this.taken.has(r.assignmentId)) continue;
      let kind: "paid" | "test" = "paid";
      try {
        kind = microUsdc(r.escrowAmount) === 0n ? "test" : "paid";
      } catch {
        // Counted as paid: the cap still holds.
      }
      this.taken.set(r.assignmentId, kind);
      n++;
    }
    return n;
  }

  count(kind?: "paid" | "test"): number {
    this.roll();
    return kind ? [...this.taken.values()].filter((k) => k === kind).length : this.taken.size;
  }

  get day(): string {
    this.roll();
    return this.today;
  }

  get cap(): number {
    return this.o.dailyCap;
  }
}
