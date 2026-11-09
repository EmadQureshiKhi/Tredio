import type { DailyLedger } from "./ledger";
import { classify, type MarketApi, MarketError, type MyAssignmentItem, type RowKind, type WorkerCancelReason } from "./market";
import { type AttentionResult, renderMarkdown } from "./result";
import { type Resolution, topicQueries } from "./topic";

/**
 * The worker loop of the market's worker skill: poll `in_progress` assignments (a signed webhook
 * only makes the next poll come sooner), tell fresh work from rework by the row alone, and for
 * each one either deliver an attention check or hand it back so the buyer is refunded.
 *
 * Fresh work, in order: the hire must hold the price (`terms`), today's cap must have room, and
 * the brief must name a topic Tredio tracks; only then is the call taken, started and answered.
 * A failure after the start is retried on the next polls and declined as `failed` once
 * MAX_ATTEMPTS is spent, so the caller pays for answers only.
 */

export interface Checker {
  resolve(queries: readonly string[]): Promise<Resolution | null>;
  check(r: Resolution): Promise<AttentionResult>;
  /** Live trends to suggest when a brief names nothing Tredio tracks. */
  suggestions?(): string[];
}

export type Log = (fields: Record<string, unknown>, msg: string) => void;

export interface WorkerOptions {
  market: MarketApi;
  checker: Checker;
  ledger: DailyLedger;
  maxConcurrent: number;
  maxAttempts: number;
  workTimeoutMs: number;
  log: Log;
  now?: () => number;
}

export type Outcome =
  | { assignmentId: string; action: "delivered"; kind: RowKind; identifier: string }
  | { assignmentId: string; action: "declined"; kind: RowKind; reason: WorkerCancelReason; why: "terms" | "cap" | "topic" | "failed"; detail: string }
  | { assignmentId: string; action: "retry"; kind: RowKind; error: string }
  | { assignmentId: string; action: "skipped"; kind: RowKind | "busy"; why: string };

export interface WorkerStats {
  polls: number;
  lastPollAt: number | null;
  lastPollOkAt: number | null;
  lastPollError: string | null;
  delivered: number;
  reworks: number;
  declined: { terms: number; cap: number; topic: number; failed: number };
  lastDeliveredAt: number | null;
  lastError: string | null;
  /** Assignments started earlier today, counted at start from the market's record. */
  seeded: number;
}

/** Pages of `status=all` read at start to count the day's calls. */
const SEED_PAGES = 10;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} took over ${Math.round(ms / 1000)} s`)), ms)))]).finally(() => clearTimeout(timer));
}

export class Worker {
  readonly stats: WorkerStats = { polls: 0, lastPollAt: null, lastPollOkAt: null, lastPollError: null, delivered: 0, reworks: 0, declined: { terms: 0, cap: 0, topic: 0, failed: 0 }, lastDeliveredAt: null, lastError: null, seeded: 0 };
  private readonly inflight = new Set<string>();
  private readonly attempts = new Map<string, number>();
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<Outcome[]> | null = null;
  private again = false;

  constructor(private readonly o: WorkerOptions) {
    this.now = o.now ?? Date.now;
  }

  /** Counts today's started assignments from the market, so the daily cap survives a restart. */
  async seed(): Promise<number> {
    let counted = 0;
    const today = new Date(this.now()).toISOString().slice(0, 10);
    for (let page = 0; page < SEED_PAGES; page++) {
      const rows = await this.o.market.assignments("all", 100, page * 100);
      counted += this.o.ledger.seed(rows.map((r) => r.assignment));
      // Newest first: a page that reaches into yesterday ends the count.
      if (rows.length < 100 || rows.some((r) => r.assignment.createdAt.slice(0, 10) < today)) break;
    }
    this.stats.seeded = counted;
    return counted;
  }

  start(intervalMs: number): void {
    this.stop();
    this.kick();
    this.timer = setInterval(() => this.kick(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Polls now; a poll already running is followed by one more, so nothing a webhook announced is missed. */
  kick(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.poll().catch(() => {});
  }

  /** One pass over the `in_progress` assignments; resolves with what became of each. */
  async poll(): Promise<Outcome[]> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.pass().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        this.kick();
      }
    });
    return this.running;
  }

  private async pass(): Promise<Outcome[]> {
    this.stats.polls++;
    this.stats.lastPollAt = Math.floor(this.now() / 1000);
    let rows: MyAssignmentItem[];
    try {
      rows = await this.o.market.assignments("in_progress");
      this.stats.lastPollOkAt = this.stats.lastPollAt;
      this.stats.lastPollError = null;
    } catch (e) {
      this.stats.lastPollError = String((e as Error).message ?? e).slice(0, 300);
      this.o.log({ error: this.stats.lastPollError }, "poll failed");
      return [];
    }
    const out: Outcome[] = [];
    const queue = rows.filter((r) => !this.inflight.has(r.assignment.assignmentId));
    for (let i = 0; i < queue.length; i += this.o.maxConcurrent) {
      out.push(...(await Promise.all(queue.slice(i, i + this.o.maxConcurrent).map((r) => this.handle(r)))));
    }
    return out;
  }

  private async decline(row: MyAssignmentItem, kind: RowKind, reason: WorkerCancelReason, why: "terms" | "cap" | "topic" | "failed", detail: string): Promise<Outcome> {
    const id = row.assignment.assignmentId;
    await this.o.market.decline(id, reason, detail);
    this.stats.declined[why]++;
    this.attempts.delete(id);
    this.o.log({ assignment: id, kind, reason, why, detail }, "declined");
    return { assignmentId: id, action: "declined", kind, reason, why, detail };
  }

  /** Works one assignment through to a delivery, a decline, or a retry on the next poll. */
  async handle(row: MyAssignmentItem): Promise<Outcome> {
    const a = row.assignment;
    const id = a.assignmentId;
    const kind = classify(row);
    if (kind === "competition") return { assignmentId: id, action: "skipped", kind, why: "this agent enters no competitions" };
    if (this.inflight.has(id)) return { assignmentId: id, action: "skipped", kind: "busy", why: "already being worked" };
    this.inflight.add(id);
    // Whether work was attempted: before that a decline is the neutral `rejected`, after it `failed`
    // (and the market refuses `rejected` once a version was delivered).
    let attempted = kind !== "fresh" || this.o.ledger.has(id);
    const reason = (): WorkerCancelReason => (attempted ? "failed" : "rejected");
    try {
      const brief = topicQueries(row.job.title, row.job.description);
      if (kind === "fresh" && !attempted) {
        const terms = this.o.ledger.terms(a);
        if (!terms.ok) return await this.decline(row, kind, reason(), "terms", terms.reason);
        const room = this.o.ledger.room(terms.kind);
        if (!room.ok) return await this.decline(row, kind, reason(), "cap", room.reason);
        if (brief.length === 0) return await this.decline(row, kind, reason(), "topic", "The brief names no topic. Send the topic as the message, for example: World Cup, $TSLA or topic:world-cup.");
        const resolution = await this.o.checker.resolve(brief);
        if (!resolution) return await this.decline(row, kind, reason(), "topic", this.unknown(brief[0]!));
        if (!this.o.ledger.take(id, terms.kind)) return await this.decline(row, kind, reason(), "cap", "this agent's daily capacity is used up; it takes calls again after 00:00 UTC");
        attempted = true;
        if (!a.startedAt) await this.o.market.start(id);
        return await this.deliver(row, kind, resolution, null);
      }
      // Rework reads the buyer's note first (it may name the topic they meant); a redo, or a note
      // that names nothing Tredio tracks, reads the brief again.
      const message = kind === "rework" && row.latestMessage?.senderSide === "buyer" ? row.latestMessage.body : "";
      const [first = "", ...rest] = message.split("\n");
      const asked = message ? topicQueries(first, rest.join("\n")) : [];
      let resolution = asked.length ? await this.o.checker.resolve(asked) : null;
      let note: string | null = null;
      if (!resolution) {
        resolution = await this.o.checker.resolve(brief);
        if (resolution && message) note = "Your note named no topic Tredio tracks, so this is a fresh reading of the brief's topic.";
      }
      if (!resolution) return await this.decline(row, kind, "failed", "topic", this.unknown(asked[0] ?? brief[0] ?? row.job.title));
      if (kind === "rework") this.stats.reworks++;
      return await this.deliver(row, kind, resolution, note);
    } catch (e) {
      const error = String((e as Error).message ?? e).slice(0, 300);
      this.stats.lastError = error;
      const tries = (this.attempts.get(id) ?? 0) + 1;
      this.attempts.set(id, tries);
      const permanent = e instanceof MarketError && !e.transient;
      this.o.log({ assignment: id, kind, tries, error }, "work failed");
      if (permanent || tries >= this.o.maxAttempts) {
        try {
          return await this.decline(row, kind, reason(), "failed", `Tredio's attention check could not answer: ${error}`.slice(0, 1000));
        } catch (d) {
          this.o.log({ assignment: id, error: String((d as Error).message ?? d) }, "decline failed");
        }
      }
      return { assignmentId: id, action: "retry", kind, error };
    } finally {
      this.inflight.delete(id);
    }
  }

  private async deliver(row: MyAssignmentItem, kind: RowKind, resolution: Resolution, note: string | null): Promise<Outcome> {
    const id = row.assignment.assignmentId;
    const result = await withTimeout(this.o.checker.check(resolution), this.o.workTimeoutMs, "the attention check");
    if (note) result.notes.unshift(note);
    await this.o.market.submit(id, renderMarkdown(result));
    this.stats.delivered++;
    this.stats.lastDeliveredAt = Math.floor(this.now() / 1000);
    this.attempts.delete(id);
    this.o.log({ assignment: id, kind, identifier: result.topic.identifier, index: result.index?.now ?? null, query: result.query }, "delivered");
    return { assignmentId: id, action: "delivered", kind, identifier: result.topic.identifier };
  }

  private unknown(query: string): string {
    const live = this.o.checker.suggestions?.() ?? [];
    return `Tredio does not track "${query.slice(0, 80)}": it is neither a listed trend nor on the radar, so this call is handed back unpaid.${live.length ? ` Listed now: ${live.slice(0, 8).join(", ")}.` : ""} Ask again with one of them, or with an identifier such as topic:world-cup.`;
  }
}
