/**
 * Derived tables: each stored event updates them through the handler for its executor's role,
 * standard and event. Handlers run only for events stored for the first time (or replayed by a
 * resync into empty tables), so increments never apply twice. An event whose data does not match
 * its known shape stays in `events` and is skipped here with a warning.
 */
import type { Tx } from "../db";
import type { Role, Tracker } from "../deployments";
import type { StoredEvent } from "../extract";
import type { Log } from "../log";
import { accountHandlers, factoryHandlers } from "./accounts";
import { bookHandlers } from "./book";
import { coinsHandlers, coinTokenHandlers } from "./coins";
import type { Handler } from "./context";
import { curationHandlers } from "./curation";
import { multiTokenHandlers, outcomesHandlers } from "./outcomes";
import { perpsHandlers } from "./perps";
import { registryHandlers } from "./registry";
import { usdcHandlers } from "./usdc";

type Table = Record<string, Record<string, Handler>>;

/** Handlers by executor role, then standard, then event. */
export const HANDLERS: Record<Role, Table> = {
  registry: { "tredio-registry": registryHandlers },
  outcomes: { "tredio-outcomes": outcomesHandlers, nep245: multiTokenHandlers },
  book: { "tredio-book": bookHandlers },
  perps: { "tredio-perps": perpsHandlers },
  coins: { "tredio-coins": coinsHandlers },
  curation: { "tredio-curation": curationHandlers },
  accounts: { "tredio-accounts": factoryHandlers },
  usdc: { nep141: usdcHandlers },
  coin: { nep141: coinTokenHandlers },
  account: { "tredio-account": accountHandlers },
};

export interface ApplyStats {
  applied: number;
  skipped: number;
}

/**
 * Applies `events` (in block order) to the derived tables inside `tx`. With `isolate`, each
 * event runs in a savepoint and one that fails is logged and skipped, so a single bad event can
 * never stop the rest (the ingest loop retries a failing block this way, and rebuilds always run
 * so).
 */
export async function applyEvents(tx: Tx, events: StoredEvent[], tracker: Tracker, log: Log, isolate = false): Promise<ApplyStats> {
  const stats: ApplyStats = { applied: 0, skipped: 0 };
  const byReceipt = new Map<string, StoredEvent[]>();
  for (const e of events) {
    const list = byReceipt.get(e.receipt_id);
    if (list) list.push(e);
    else byReceipt.set(e.receipt_id, [e]);
  }
  for (const e of events) {
    const role = tracker.roleOf(e.executor);
    const h = role ? HANDLERS[role][e.standard]?.[e.event] : undefined;
    if (!h) continue;
    const parsed = h.schema.safeParse(e.data);
    if (!parsed.success) {
      stats.skipped++;
      log.warn("event data does not match its shape", {
        height: e.block_height,
        receipt: e.receipt_id,
        event: `${e.standard}/${e.event}`,
        issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`),
      });
      continue;
    }
    const receipt = byReceipt.get(e.receipt_id)!;
    if (!isolate) {
      await h.run({ tx, e, receipt, tracker }, parsed.data as never);
      stats.applied++;
      continue;
    }
    try {
      await tx.savepoint((sp) => h.run({ tx: sp, e, receipt, tracker }, parsed.data as never));
      stats.applied++;
    } catch (err) {
      if (!deterministic(err)) throw err;
      stats.skipped++;
      log.error("event skipped: its handler failed", {
        height: e.block_height,
        receipt: e.receipt_id,
        event: `${e.standard}/${e.event}`,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return stats;
}

/**
 * True for failures that would repeat on every retry: JS errors in a handler and Postgres data,
 * integrity and statement errors (SQLSTATE classes 22, 23, 42). Connection losses, timeouts and
 * serialization failures are not, so the block is retried as a whole instead.
 */
function deterministic(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (typeof code !== "string") return err instanceof Error;
  return /^(22|23|42)[0-9A-Z]{3}$/.test(code);
}
