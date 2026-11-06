"use client";
import { useQuery } from "@tanstack/react-query";
import type { Side } from "@tredio/contracts";
import { type HlMarket, hyperliquid } from "@/lib/api";
import { readOpenOrders } from "@/lib/trade/orders";
import {
  readBookBalances,
  readCurve,
  readCurveQuote,
  readDepth,
  readFairUp,
  readIndex,
  readMark,
  readOutcomeBalances,
  readPerpMarket,
  readPerpPositions,
  readSeries,
  readTokenBalance,
  type SeriesView,
} from "@/lib/trade/reads";

/** Live chain state for the trend page, each read refreshed at the pace it moves. */

/** The registry's own view: the index the contracts trade at, and whether it is fresh. */
export function useRegistryIndex(trend: string | undefined) {
  return useQuery({ queryKey: ["registry-index", trend], enabled: Boolean(trend), refetchInterval: 10_000, queryFn: () => readIndex(trend!) });
}

export function useSeries(trend: string | undefined) {
  return useQuery({ queryKey: ["series", trend], enabled: Boolean(trend), refetchInterval: 30_000, queryFn: () => readSeries(trend!) });
}

/** A book market's best levels, every few seconds while on screen; null when the book does not list it. */
export function useBook(series: number | undefined, side: Side, levels = 8) {
  return useQuery({ queryKey: ["book", series, side, levels], enabled: series !== undefined, refetchInterval: 4_000, queryFn: () => readDepth(series!, side, levels) });
}

/** The attention-implied value of UP (USDC); DOWN's is one minus it. */
export function useFairUp(s: SeriesView | undefined) {
  return useQuery({ queryKey: ["fair-up", s?.series], enabled: Boolean(s), refetchInterval: 10_000, queryFn: () => readFairUp(s!.trend, s!.openingIndex, s!.expiry) });
}

export function useOutcomeBalances(account: string | undefined, series: number | undefined) {
  return useQuery({ queryKey: ["outcome-balances", account, series], enabled: Boolean(account) && series !== undefined, refetchInterval: 6_000, queryFn: () => readOutcomeBalances(account!, series!) });
}

/** What the account holds inside the book from limit orders: withdrawable at any time. */
export function useBookBalances(account: string | undefined, series: number | undefined) {
  return useQuery({ queryKey: ["book-balances", account, series], enabled: Boolean(account) && series !== undefined, refetchInterval: 8_000, queryFn: () => readBookBalances(account!, series!) });
}

export function useOpenOrders(account: string | undefined) {
  return useQuery({ queryKey: ["open-orders", account], enabled: Boolean(account), refetchInterval: 10_000, queryFn: () => readOpenOrders(account!) });
}

export function usePerpMarket(trend: string | undefined, index: number | undefined) {
  return useQuery({ queryKey: ["perp-market", trend], enabled: Boolean(trend) && index !== undefined, refetchInterval: 8_000, queryFn: () => readPerpMarket(trend!, index!) });
}

export function usePerpPositions(account: string | undefined) {
  return useQuery({ queryKey: ["perp-positions", account], enabled: Boolean(account), refetchInterval: 6_000, queryFn: () => readPerpPositions(account!) });
}

export function useCurve(trend: string | undefined) {
  return useQuery({ queryKey: ["curve", trend], enabled: Boolean(trend), refetchInterval: 8_000, queryFn: () => readCurve(trend!) });
}

/** The curve's own quote for a trade (out and fee). */
export function useCurveQuote(trend: string | undefined, side: "buy" | "sell", amount: bigint | null, peakRaw: number | null = null) {
  return useQuery({
    queryKey: ["curve-quote", trend, side, amount?.toString(), peakRaw],
    enabled: Boolean(trend) && amount !== null && amount > 0n,
    refetchInterval: 8_000,
    queryFn: () => readCurveQuote(trend!, side, amount!, peakRaw),
  });
}

export function useTokenBalance(token: string | undefined, account: string | undefined) {
  return useQuery({ queryKey: ["token-balance", token, account], enabled: Boolean(token) && Boolean(account), refetchInterval: 8_000, queryFn: () => readTokenBalance(token!, account!) });
}

/** Hyperliquid's perp markets with marks and funding, from the API. */
export function useHlMarkets() {
  return useQuery({ queryKey: ["hl-markets"], queryFn: async () => (await hyperliquid.markets()).markets, refetchInterval: 5_000, staleTime: 4_000 });
}

/** Hyperliquid's market for a trend's asset, if it lists one. */
export function useAssetPerpMarket(asset: string | null | undefined): { market: HlMarket | null; isLoading: boolean } {
  const markets = useHlMarkets();
  const market = asset ? (markets.data?.find((m) => m.symbol.toUpperCase() === asset.toUpperCase()) ?? null) : null;
  return { market, isLoading: markets.isLoading };
}

/** The account's Hyperliquid address (its own Chain Signatures key) with its balance, positions and orders. */
export function useHlAccount(account: string | undefined) {
  return useQuery({ queryKey: ["hl-account", account], enabled: Boolean(account), refetchInterval: 5_000, queryFn: () => hyperliquid.account(account!) });
}

/** The registry's mark for an asset, which the account's guard checks each session order against. */
export function useMark(asset: string | undefined) {
  return useQuery({ queryKey: ["hl-mark", asset], enabled: Boolean(asset), refetchInterval: 5_000, queryFn: () => readMark(asset!) });
}
