import type { Tracker } from "./deployments";
import { parseEvents } from "./events";
import type { Block, ReceiptOutcome } from "./neardata";

/** One NEP-297 event as `indexer.events` stores it. */
export interface StoredEvent {
  block_height: number;
  block_time: Date;
  /** Position of the event in its block (shard order, then execution order, then log order). */
  idx: number;
  receipt_id: string;
  tx_hash: string | null;
  executor: string;
  standard: string;
  version: string;
  event: string;
  data: unknown;
  /** Index of the log line in the receipt's logs. */
  log_index: number;
}

/** Block time from the header, in milliseconds (the nanosecond string keeps full precision). */
export function blockTime(b: Block): Date {
  const h = b.block.header;
  const ns = h.timestamp_nanosec ? BigInt(h.timestamp_nanosec) : BigInt(Math.round(h.timestamp));
  return new Date(Number(ns / 1_000_000n));
}

/** True for `SuccessValue` and `SuccessReceiptId`; a failed or unknown receipt changed nothing. */
export function succeeded(status: unknown): boolean {
  return typeof status === "object" && status !== null && ("SuccessValue" in status || "SuccessReceiptId" in status);
}

/** The events of Tredio executors in successful receipts, in block order. */
export function extractEvents(b: Block, tracker: Tracker): StoredEvent[] {
  const height = b.block.header.height;
  const time = blockTime(b);
  const out: StoredEvent[] = [];
  for (const shard of b.shards) {
    for (const r of shard.receipt_execution_outcomes) {
      const events = eventsOf(r, tracker);
      for (const e of events) {
        out.push({
          block_height: height,
          block_time: time,
          idx: out.length,
          receipt_id: r.receipt?.receipt_id ?? r.execution_outcome.id,
          tx_hash: r.tx_hash ?? null,
          executor: r.execution_outcome.outcome.executor_id,
          standard: e.standard,
          version: e.version,
          event: e.event,
          data: e.data,
          log_index: e.logIndex,
        });
      }
    }
  }
  return out;
}

function eventsOf(r: ReceiptOutcome, tracker: Tracker) {
  const o = r.execution_outcome.outcome;
  if (!o.logs.length || !succeeded(o.status)) return [];
  const role = tracker.roleOf(o.executor_id);
  if (!role) return [];
  return parseEvents(o.logs).filter((e) => tracker.keeps(role, e.standard) && storable(e));
}

/**
 * False when a string anywhere in the event (keys included) holds a NUL or a lone surrogate,
 * which Postgres text and jsonb reject: such an event (only a foreign contract could log one)
 * is dropped rather than failing its block forever.
 */
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function storable(v: unknown): boolean {
  if (typeof v === "string") return !UNSTORABLE.test(v);
  if (Array.isArray(v)) return v.every(storable);
  if (v && typeof v === "object") return Object.entries(v).every(([k, x]) => storable(k) && storable(x));
  return true;
}
