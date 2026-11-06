"use client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { type ActivityItem, ApiError, history, hyperliquid } from "@/lib/api";
import { portfolioKey } from "./keys";

/** The account's trade activity: the indexer's record on NEAR, with its Hyperliquid fills merged in. */

/** A 404 means no activity yet (or the route is not deployed); a 503 means no indexer here. */
export const statusOf = (e: unknown) => (e instanceof ApiError ? e.status : 0);

/** Hyperliquid fills of the account's own address as activity rows (none when Hyperliquid cannot be read). */
async function hyperliquidActivity(account: string): Promise<ActivityItem[]> {
  const fills = await hyperliquid
    .fills(account)
    .then((r) => r.fills)
    .catch(() => []);
  return fills.map((f) => ({
    kind: "assetPerp",
    identifier: null,
    label: `${f.coin} perp`,
    side: f.dir || (f.side === "B" ? "buy" : "sell"),
    status: "filled",
    amountUsdc: f.px * f.sz,
    pnlUsdc: f.closedPnl !== 0 ? f.closedPnl - f.fee : null,
    entry: null,
    exit: null,
    at: Math.floor(f.time / 1000),
    receipt: null,
  }));
}

/** The account's newest trades (Home's recent activity and the portfolio's history). */
/**
 * The NEAR record shows as soon as the indexer answers; Hyperliquid fills (slower: the address is
 * derived from the account's Chain Signatures key) join when they arrive.
 */
export function useActivity(address: string | undefined, enabled = true) {
  const on = enabled && Boolean(address);
  const near = useQuery({
    queryKey: [...portfolioKey(address), "history", "activity"],
    enabled: on,
    refetchInterval: 15_000,
    retry: (n, e) => n < 1 && statusOf(e) !== 404 && statusOf(e) !== 503,
    queryFn: () => history.activity(address!, 50),
  });
  const hl = useQuery({ queryKey: [...portfolioKey(address), "history", "hl-fills"], enabled: on, refetchInterval: 30_000, queryFn: () => hyperliquidActivity(address!) });
  const nearItems = near.data?.items;
  const hlItems = hl.data;
  const data = useMemo(() => (nearItems || hlItems ? { items: [...(nearItems ?? []), ...(hlItems ?? [])].sort((a, b) => b.at - a.at).slice(0, 60) } : undefined), [nearItems, hlItems]);
  const refetch = useCallback(() => Promise.all([near.refetch(), hl.refetch()]), [near, hl]);
  return { data, error: near.error, isError: near.isError, isLoading: near.isLoading, isPending: near.isPending, refetch };
}

/** "Long", "Bought UP", "Open long". */
export function action(item: ActivityItem): string {
  const s = item.side.toLowerCase();
  const [verb, side] = s.split(" ");
  if (verb === "buy" || verb === "sell") return `${verb === "buy" ? "Bought" : "Sold"}${side ? ` ${side.toUpperCase()}` : ""}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
