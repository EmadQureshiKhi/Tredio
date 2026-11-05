/**
 * The ingestion loop: from the cursor (or the start block) on, with a small window of requests
 * in flight, processed in height order. At the head the window reaches a few heights past the
 * final block: neardata holds such a request open until the block exists, so the next blocks
 * arrive as soon as they are final without polling. Blocks without Tredio events only move the
 * cursor, written at most once a second for them; a block with events is committed with its
 * cursor in one transaction. A database error retries the same block after a pause.
 */
import type { Sql } from "./db";
import type { Tracker } from "./deployments";
import { blockTime, extractEvents } from "./extract";
import type { Log } from "./log";
import { type BlockResult, type Neardata, sleep, StoppedError } from "./neardata";
import { commitBlock, type Cursor, readCursor, writeCursor } from "./store";

export interface IngestOptions {
  sql: Sql;
  neardata: Neardata;
  tracker: Tracker;
  network: string;
  startBlock: number;
  concurrency: number;
  pollMs: number;
  log: Log;
  signal: AbortSignal;
}

export interface IngestStatus {
  height: number;
  head: number;
  blockTime: Date | null;
  eventsProcessed: number;
  startedAt: Date;
  /** Last time the loop made progress or retried (ms). */
  beat: number;
}

const HEAD_REFRESH_MS = 60_000;
const CURSOR_FLUSH_MS = 1_000;
const PROGRESS_LOG_MS = 15_000;
const ISOLATE_AFTER = 3;
const GAP_WARN_MS = 60_000;

export class Ingestor {
  readonly status: IngestStatus = { height: 0, head: 0, blockTime: null, eventsProcessed: 0, startedAt: new Date(), beat: Date.now() };
  private headAt = 0;
  private flushedHeight = 0;
  private flushedAt = 0;

  constructor(private readonly o: IngestOptions) {}

  beat() {
    this.status.beat = Date.now();
  }

  async run(): Promise<void> {
    const { o, status } = this;
    const saved = await readCursor(o.sql, o.network);
    status.height = saved?.height ?? o.startBlock - 1;
    status.blockTime = saved?.blockTime ?? null;
    this.flushedHeight = status.height;
    const inflight = new Map<number, Promise<BlockResult>>();
    let lastLog = Date.now();
    let lastLogHeight = status.height;
    let lastGapWarn = 0;
    try {
      await this.refreshHead();
      o.log.info("ingest start", { from: status.height + 1, head: status.head, resumed: Boolean(saved) });
      while (!o.signal.aborted) {
        this.beat();
        if (Date.now() - this.headAt > HEAD_REFRESH_MS) await this.refreshHead();
        const next = status.height + 1;
        for (let h = next; h < next + o.concurrency; h++) {
          if (!inflight.has(h)) {
            const p = o.neardata.block(h);
            p.catch(() => {}); // Awaited below in order; this only keeps an early rejection from being unhandled.
            inflight.set(h, p);
          }
        }
        const r = await inflight.get(next)!;
        inflight.delete(next);
        if (r.kind === "future") {
          // Normal right past the head; below it neardata is missing a block it should have.
          if (next <= status.head && Date.now() - lastGapWarn > GAP_WARN_MS) {
            o.log.warn("neardata has no block at a height below the final head", { height: next, head: status.head });
            lastGapWarn = Date.now();
          }
          await sleep(o.pollMs, o.signal);
          continue;
        }
        await this.process(r);
        if (Date.now() - lastLog > PROGRESS_LOG_MS) {
          const rate = ((status.height - lastLogHeight) * 1000) / (Date.now() - lastLog);
          o.log.info("ingest progress", {
            height: status.height,
            head: status.head,
            lagBlocks: Math.max(0, status.head - status.height),
            blocksPerSec: Math.round(rate * 100) / 100,
            events: status.eventsProcessed,
            requests: o.neardata.requests,
          });
          lastLog = Date.now();
          lastLogHeight = status.height;
        }
      }
    } catch (e) {
      if (!(e instanceof StoppedError)) throw e;
    } finally {
      await this.flush().catch((e) => o.log.warn("cursor flush failed", { error: String(e) }));
    }
  }

  private async refreshHead() {
    this.status.head = Math.max(this.status.head, await this.o.neardata.finalHeight());
    this.headAt = Date.now();
  }

  private async process(r: Exclude<BlockResult, { kind: "future" }>) {
    const { o, status } = this;
    const cursor: Cursor = { height: r.height, blockTime: r.kind === "block" ? blockTime(r.block) : status.blockTime };
    const events = r.kind === "block" ? extractEvents(r.block, o.tracker) : [];
    if (events.length) {
      let delay = 1_000;
      for (let attempt = 1; ; attempt++) {
        try {
          // After repeated failures each event runs on its own, so one that cannot be applied
          // is skipped (and logged) instead of holding the block back forever.
          const isolate = attempt > ISOLATE_AFTER;
          status.eventsProcessed += await commitBlock(o.sql, o.network, cursor, events, o.tracker, o.log, isolate);
          this.flushedHeight = cursor.height;
          this.flushedAt = Date.now();
          break;
        } catch (e) {
          o.log.error("commit failed, retrying", { height: r.height, attempt, error: String(e) });
          this.beat();
          await sleep(delay, o.signal);
          delay = Math.min(delay * 2, 30_000);
        }
      }
      o.log.debug("block committed", { height: r.height, events: events.length });
    }
    status.height = cursor.height;
    status.blockTime = cursor.blockTime;
    if (status.head < status.height) status.head = status.height;
    if (Date.now() - this.flushedAt > CURSOR_FLUSH_MS) {
      await this.flush().catch((e) => o.log.warn("cursor write failed", { error: String(e) }));
    }
  }

  private async flush() {
    if (this.status.height === this.flushedHeight) return;
    await writeCursor(this.o.sql, this.o.network, { height: this.status.height, blockTime: this.status.blockTime });
    this.flushedHeight = this.status.height;
    this.flushedAt = Date.now();
  }
}
