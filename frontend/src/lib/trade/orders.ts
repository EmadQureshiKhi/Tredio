import type { Order } from "@tredio/contracts";
import { eventsOf, type Outcome } from "@/lib/chain/outcome";
import { readOrder } from "./reads";

/**
 * The account's limit orders on the book. The book has no per-account order list, so the app keeps
 * the ids of the orders it placed (from each placement's `order_placed` event) on this device and
 * reads each one's state from the book. Orders placed from another device show once they fill or
 * are cancelled in the account's history.
 */

const KEY = "tredio.orders";

function readAll(): Record<string, number[]> {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, number[]>) ?? {};
  } catch {
    return {};
  }
}

function write(all: Record<string, number[]>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Storage blocked: the orders still rest on the book.
  }
}

/** The ids of orders a placement's receipts report for `account`. */
export function placedOrders(o: Outcome | null, account: string): number[] {
  if (!o) return [];
  return eventsOf(o)
    .filter((e) => e.standard === "tredio-book" && e.event === "order_placed")
    .flatMap((e) => (Array.isArray(e.data) ? e.data : [e.data]) as Array<{ id?: number; owner?: string }>)
    .filter((d) => d.owner === account && typeof d.id === "number")
    .map((d) => d.id!);
}

export function rememberOrders(account: string, ids: number[]) {
  if (ids.length === 0) return;
  const all = readAll();
  all[account] = [...new Set([...(all[account] ?? []), ...ids])];
  write(all);
}

/** The account's orders still resting on the book; ones that filled or were cancelled are forgotten. */
export async function readOpenOrders(account: string): Promise<Order[]> {
  const ids = readAll()[account] ?? [];
  if (ids.length === 0) return [];
  const orders = await Promise.all(ids.map((id) => readOrder(id).catch(() => undefined)));
  const open = orders.filter((o): o is Order => Boolean(o) && o!.owner === account);
  // A failed read keeps its id; only an order the book no longer has is dropped.
  const keep = ids.filter((id, i) => orders[i] === undefined || open.some((o) => o.id === id));
  if (keep.length !== ids.length) {
    const all = readAll();
    all[account] = keep;
    write(all);
  }
  return open;
}
