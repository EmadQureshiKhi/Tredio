/**
 * From a block (neardata) or a transaction (tx API) to the rows of `indexer.events`: the events
 * of successful receipts whose executor is Tredio's. Both feeds produce identical rows for the
 * same receipt.
 */
import type { Tracker } from "./deployments";
import { parseEvents } from "./events";
import type { Block } from "./neardata";
import { nsToDate, type TxOutcome, type TxRecord } from "./txapi";

/** One NEP-297 event as `indexer.events` stores it. */
export interface StoredEvent {
  block_height: number;
  block_time: Date;
  /**
   * Order of the event in its block: the receipt's index times 100, plus the log index (a
   * receipt logs at most 100 lines). The index is the one FastNEAR's transactions API gives the
   * receipt (outcomes in neardata's shard order, each after the data receipts it consumed), so
   * both feeds store the same value.
   */
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

interface ReceiptMeta {
  height: number;
  time: Date;
  /** The receipt's index in its block (see `StoredEvent.idx`). */
  position: number;
  receiptId: string;
  txHash: string | null;
  executor: string;
  logs: readonly string[];
  status: unknown;
}

/** The kept events of one receipt. */
function receiptEvents(r: ReceiptMeta, tracker: Tracker): StoredEvent[] {
  if (!r.logs.length || !succeeded(r.status)) return [];
  const role = tracker.roleOf(r.executor);
  if (!role) return [];
  return parseEvents(r.logs)
    .filter((e) => tracker.keeps(role, e.standard, e.data) && storable(e))
    .map((e) => ({
      block_height: r.height,
      block_time: r.time,
      idx: r.position * 100 + e.logIndex,
      receipt_id: r.receiptId,
      tx_hash: r.txHash,
      executor: r.executor,
      standard: e.standard,
      version: e.version,
      event: e.event,
      data: e.data,
      log_index: e.logIndex,
    }));
}

/** The events of Tredio executors in a block's successful receipts, in block order. */
export function extractEvents(b: Block, tracker: Tracker): StoredEvent[] {
  const height = b.block.header.height;
  const time = blockTime(b);
  const out: StoredEvent[] = [];
  let index = 0;
  for (const shard of b.shards) {
    for (const r of shard.receipt_execution_outcomes) {
      const o = r.execution_outcome.outcome;
      // The data receipts an action receipt waited for take the indexes before it.
      index += r.receipt?.receipt?.Action?.input_data_ids?.length ?? 0;
      out.push(
        ...receiptEvents(
          {
            height,
            time,
            position: index++,
            receiptId: r.receipt?.receipt_id ?? r.execution_outcome.id,
            txHash: r.tx_hash ?? null,
            executor: o.executor_id,
            logs: o.logs,
            status: o.status,
          },
          tracker,
        ),
      );
    }
  }
  return out;
}

const outcomeEvents = (tx: TxRecord, eo: TxOutcome, tracker: Tracker) =>
  receiptEvents(
    {
      height: eo.block_height,
      time: nsToDate(eo.block_timestamp),
      position: eo.index,
      receiptId: eo.id,
      txHash: tx.transaction.hash,
      executor: eo.outcome.executor_id,
      logs: eo.outcome.logs,
      status: eo.outcome.status,
    },
    tracker,
  );

/** The events of Tredio executors in a transaction's successful receipts (executed so far). */
export function txEvents(tx: TxRecord, tracker: Tracker): StoredEvent[] {
  return tx.receipts.flatMap((r) => outcomeEvents(tx, r.execution_outcome, tracker));
}

/** True once every receipt the transaction and its receipts produced has executed. */
export function txComplete(tx: TxRecord): boolean {
  const done = new Set(tx.receipts.map((r) => r.execution_outcome.id));
  const wanted = [tx.execution_outcome, ...tx.receipts.map((r) => r.execution_outcome)].flatMap((o) => o.outcome.receipt_ids ?? []);
  return wanted.every((id) => done.has(id));
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
