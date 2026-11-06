import type { Call, CallerRecord, Trend } from "@/lib/api";
import { rpc } from "@/lib/chain/client";
import { eventsOf, failureOf, type Outcome } from "@/lib/chain/outcome";
import { BACKEND_URL, DEPLOYMENT } from "@/lib/config";
import { attentionStory, baseIdentifier, trendName } from "@/lib/trends";
import type { PnlShare } from "./share";

/**
 * Server-side reads for the share pages and link cards. Each is cached briefly (cards are fetched
 * by crawlers in bursts) and fails soft: a card without data still renders.
 */

const REVALIDATE = 120;

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BACKEND_URL}${path}`, { next: { revalidate: REVALIDATE }, signal: AbortSignal.timeout(4000) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** A trend as the home cards show it (with its 24h change and hourly sparkline), any status. */
export async function trendCard(identifier: string): Promise<Trend | null> {
  const id = identifier.toLowerCase();
  const list = await getJson<{ trends: Trend[] }>("/v1/trends?all=1");
  return list?.trends.find((t) => t.identifier === id) ?? null;
}

export { attentionStory, baseIdentifier, trendName };

export interface SharedCall {
  call: Call;
  trend: Trend | null;
  /** The caller's record across resolved calls. */
  record: { hits: number; misses: number; hitRate: number } | null;
}

/**
 * One call by its id however old it is, with the trend and the caller's record; null when there is
 * no such call (or moderation hid it) or the link names another trend than the call's.
 */
export async function sharedCall(identifier: string, callId: number): Promise<SharedCall | null> {
  const id = identifier.toLowerCase();
  const [found, trend] = await Promise.all([getJson<{ call: Call; record: CallerRecord }>(`/v1/calls/${callId}`), trendCard(id)]);
  if (!found || found.call.identifier !== id) return null;
  return { call: found.call, trend, record: found.record };
}

export const callerName = (c: Pick<Call, "handle" | "caller">) => (c.handle ? `@${c.handle}` : `${c.caller.slice(0, 6)}...${c.caller.slice(-4)}`);

/** "24-hour", "7-day": a call's horizon as an adjective. */
export const horizonLabel = (sec: number) => (sec === 86_400 ? "24-hour" : sec >= 86_400 ? `${Math.round(sec / 86_400)}-day` : sec >= 3600 ? `${Math.round(sec / 3600)}-hour` : `${Math.round(sec / 60)}-minute`);
/** "24 hours", "7 days". */
export const horizonWords = (sec: number) => (sec === 86_400 ? "24 hours" : sec >= 86_400 ? `${Math.round(sec / 86_400)} days` : sec >= 3600 ? `${Math.round(sec / 3600)} hours` : `${Math.round(sec / 60)} minutes`);

// ---------------------------------------------------------------------------------------------
// Verifying a PnL share against NEAR
// ---------------------------------------------------------------------------------------------

/** An attention perp close as the perps contract logged it (`position_closed`). */
export interface PerpClose {
  id: number;
  owner: string;
  trend: string;
  isLong: boolean;
  /** Points. */
  entryIndex: number;
  exitIndex: number;
  /** USDC: margin (net of the opening fee) and what the close paid out, net of funding and the closing fee. */
  margin: number;
  payout: number;
  /** Notional at entry, USDC (the opening fee was 0.1% of it). */
  entryNotional: number;
}

/** The position closes the perps contract itself logged in a transaction's receipts (any contract can print an event). */
export function perpClosesOf(o: Outcome): PerpClose[] {
  const own: Outcome = { receipts_outcome: (o.receipts_outcome ?? []).filter((r) => r.outcome.executor_id === DEPLOYMENT.contracts.perps) };
  return eventsOf(own)
    .filter((e) => e.standard === "tredio-perps" && e.event === "position_closed")
    .flatMap((e) => (Array.isArray(e.data) ? e.data : [e.data]) as Array<Record<string, unknown>>)
    .map((d) => {
      const qty = BigInt(String(d.qty ?? "0"));
      const entry = Number(d.entry_index ?? 0);
      return {
        id: Number(d.id),
        owner: String(d.owner),
        trend: String(d.trend),
        isLong: Boolean(d.is_long),
        entryIndex: entry / 1e6,
        exitIndex: Number(d.exit_index ?? 0) / 1e6,
        margin: Number(String(d.margin ?? "0")) / 1e6,
        payout: Number(String(d.payout ?? "0")) / 1e6,
        entryNotional: Number((qty * BigInt(entry)) / 10n ** 18n) / 1e6,
      };
    });
}

const cache = new Map<string, Promise<PerpClose | null>>();

/** The attention perp close in transaction `tx` sent by `sender`, read from its receipts' logs, or null. */
export function perpClose(tx: string, sender: string): Promise<PerpClose | null> {
  const key = `${tx}:${sender}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      try {
        const o = await rpc<Outcome>("EXPERIMENTAL_tx_status", { tx_hash: tx, sender_account_id: sender, wait_until: "EXECUTED_OPTIMISTIC" });
        if (failureOf(o)) return null;
        return perpClosesOf(o).find((c) => c.owner === sender) ?? null;
      } catch {
        // Unknown transaction or the node is unreachable: unverified, and worth asking again later.
        cache.delete(key);
        return null;
      }
    })();
    cache.set(key, p);
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
  }
  return p;
}

/**
 * The shared result as NEAR records it, when the shared numbers check out; otherwise null. Every
 * field under the "Verified" badge comes from the closing transaction's `position_closed` event,
 * never from the link: the trend, side, entry, exit and leverage, and the PnL either as the close
 * nets it (funding and the closing fee) or also net of the opening fee. The owner is the
 * transaction's own signer, so nobody can borrow someone else's close.
 */
export async function verifiedPerpShare(share: PnlShare): Promise<{ share: PnlShare; owner: string } | null> {
  if (share.kind !== "attention" || !share.tx || !share.account) return null;
  const close = await perpClose(share.tx, share.account);
  if (!close) return null;
  if (share.exit !== null && Math.abs(close.exitIndex - share.exit) >= 0.006) return null;
  const closeNet = close.payout - close.margin;
  const afterOpenFee = closeNet - close.entryNotional * 0.001;
  const near = (v: number) => Math.abs(v - share.pnl) < 0.006;
  if (!near(closeNet) && !near(afterOpenFee)) return null;
  const trend = await trendCard(close.trend);
  return {
    owner: close.owner,
    share: {
      kind: "attention",
      market: trend ? trendName(trend) : baseIdentifier(close.trend),
      side: close.isLong ? "long" : "short",
      pnl: share.pnl,
      roi: close.margin > 0 ? (share.pnl / close.margin) * 100 : null,
      entry: close.entryIndex,
      exit: close.exitIndex,
      leverage: close.margin > 0 ? Math.round((close.entryNotional / close.margin) * 10) / 10 : null,
      tx: share.tx,
      account: close.owner,
      identifier: close.trend,
    },
  };
}
