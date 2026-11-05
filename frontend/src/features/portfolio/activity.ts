"use client";
import { useQuery } from "@tanstack/react-query";
import { type ActivityItem, ApiError, history } from "@/lib/api";
import { portfolioKey } from "./keys";

/** The account's trade activity from the indexer: light, so Home shows the newest without the portfolio. */

/** A 404 means no activity yet (or the route is not deployed); a 503 means no indexer here. */
export const statusOf = (e: unknown) => (e instanceof ApiError ? e.status : 0);

/** The account's newest trades from the indexer (Home's recent activity and the portfolio's history). */
export function useActivity(address: string | undefined, enabled = true) {
  return useQuery({
    queryKey: [...portfolioKey(address), "history", "activity"],
    enabled: enabled && Boolean(address),
    refetchInterval: 15_000,
    retry: (n, e) => n < 1 && statusOf(e) !== 404 && statusOf(e) !== 503,
    queryFn: () => history.activity(address!, 50),
  });
}

/** "Long", "Bought UP", "Sold". */
export function action(item: ActivityItem): string {
  const s = item.side.toLowerCase();
  const [verb, side] = s.split(" ");
  if (verb === "buy" || verb === "sell") return `${verb === "buy" ? "Bought" : "Sold"}${side ? ` ${side.toUpperCase()}` : ""}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

