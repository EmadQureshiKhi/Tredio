"use client";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useAccount } from "@/lib/account/AccountProvider";
import { ApiError, autopilot, history, hyperliquid, type IndexedOutcomeHolding, type RuleDetail, type StoredRule, type Trend, trends as trendsApi } from "@/lib/api";
import { view } from "@/lib/chain/client";
import { DEPLOYMENT } from "@/lib/config";
import { readUsdc, useUsdcBalance } from "@/lib/hooks/queries";
import { mid } from "@/lib/trade/math";
import { readCuration, readCurves, readDepth, readOutcomeBalances, readPerpPositions, readSeries, readSeriesById, readTokenBalance, type PerpPositionView, type SeriesView } from "@/lib/trade/reads";
import { portfolioKey } from "./keys";
import { outcomeValue, toUsdc } from "./math";

/**
 * The portfolio's data, read live from NEAR (balances, positions, books) and Hyperliquid, with the
 * indexer's history for series held earlier and each holding's average cost. Positions refresh
 * every few seconds, slow-moving holdings every half minute, and everything right after a trade.
 */

export { portfolioKey } from "./keys";

const FAST = "fast";
const SLOW = "slow";

export function useAllTrends() {
  return useQuery({ queryKey: ["trends", "all"], queryFn: () => trendsApi.list(true), refetchInterval: 30_000, placeholderData: keepPreviousData });
}

export interface OutcomeHolding extends SeriesView {
  trendInfo: Trend | null;
  up: bigint;
  down: bigint;
  upMid: number | null;
  downMid: number | null;
  /** USDC, or null while part of it has no price. */
  value: number | null;
  sets: bigint;
  /** The indexer's average-cost book of each side, when it covers the holding. */
  cost: { up: bigint | null; down: bigint | null };
  /** "open" trading, "settling" (ended, outcome not in yet), "settled". */
  phase: "open" | "settling" | "settled";
}

/** Series the account holds: the indexer's list (old ones included) and the current series of every listing. */
async function readOutcomeHoldings(account: string, list: readonly Trend[], indexed: readonly IndexedOutcomeHolding[]): Promise<{ cash: bigint; holdings: OutcomeHolding[] }> {
  const live = list.filter((t) => t.status !== "retired");
  const current = (await Promise.all(live.map((t) => readSeries(t.id).catch(() => [] as SeriesView[])))).flat();
  const known = new Map(current.map((s) => [s.series, s]));
  const extra = indexed.filter((h) => !known.has(h.series)).map((h) => h.series);
  for (const s of await Promise.all(extra.map((id) => readSeriesById(id).catch(() => null)))) if (s) known.set(s.series, s);
  const [cash, rows] = await Promise.all([
    readUsdc(account),
    Promise.all(
      [...known.values()].map(async (s) => {
        const b = await readOutcomeBalances(account, s.series);
        return b.up > 0n || b.down > 0n ? { s, ...b } : null;
      }),
    ),
  ]);
  const held = rows.filter((r): r is NonNullable<typeof r> => r !== null);
  const now = Date.now() / 1000;
  const holdings = await Promise.all(
    held.map(async ({ s, up, down }): Promise<OutcomeHolding> => {
      const open = s.outcome === "open" && s.expiry > now && s.listed;
      const [upBook, downBook] = open ? await Promise.all([up > 0n ? readDepth(s.series, "up", 4).catch(() => null) : null, down > 0n ? readDepth(s.series, "down", 4).catch(() => null) : null]) : [null, null];
      const upMid = mid(upBook);
      const downMid = mid(downBook);
      const { value, sets } = outcomeValue({ up, down, outcome: s.outcome, upMid, downMid });
      const ix = indexed.find((h) => h.series === s.series);
      return {
        ...s,
        trendInfo: list.find((t) => t.id === s.trend) ?? null,
        up,
        down,
        upMid,
        downMid,
        value,
        sets,
        cost: { up: ix && BigInt(ix.upPosition) === up ? BigInt(ix.upCostBasis) : null, down: ix && BigInt(ix.downPosition) === down ? BigInt(ix.downCostBasis) : null },
        phase: s.outcome !== "open" ? "settled" : s.expiry <= now ? "settling" : "open",
      };
    }),
  );
  return { cash, holdings };
}

export interface PerpHolding extends PerpPositionView {
  trendInfo: Trend | null;
}

export interface CoinHolding {
  trend: string;
  trendInfo: Trend | null;
  coin: string;
  balance: bigint;
  spot: number;
  value: number | null;
  stage: string;
}

async function readCoinHoldings(account: string, list: readonly Trend[]): Promise<CoinHolding[]> {
  const curves = await readCurves();
  const rows = await Promise.all(
    curves
      .filter((c) => c.stage !== "creating")
      .map(async (c): Promise<CoinHolding | null> => {
        const balance = await readTokenBalance(c.coin, account);
        if (balance === 0n) return null;
        const spot = c.stage === "open" || c.stage === "ready" ? Number(await view<string>(DEPLOYMENT.contracts.coins, "spot_price", { trend: c.trend }).catch(() => "0")) / 1e18 / 1e6 : 0;
        return { trend: c.trend, trendInfo: list.find((t) => t.id === c.trend) ?? null, coin: c.coin, balance, spot, value: spot > 0 ? (Number(balance) / 1e18) * spot : null, stage: c.stage };
      }),
  );
  return rows.filter((r): r is CoinHolding => r !== null);
}

/** An open Hyperliquid position of the account's address, priced as the portfolio shows it. */
export interface AssetPerpPosition {
  market: { id: number; symbol: string; szDecimals: number; markPx: number; midPx: number | null };
  side: "long" | "short";
  size: number;
  entryPrice: number | null;
  marginUsdc: number;
  pnl: number;
  leverage: number;
  liquidationPx: number | null;
}

export function usePortfolioData() {
  const account = useAccount();
  const address = account.address;
  const trends = useAllTrends();
  const list = trends.data?.trends;
  const trendKey = useMemo(() => (list ?? []).map((t) => t.id).join(","), [list]);
  const key = portfolioKey(address);
  const enabled = Boolean(address) && Boolean(list);

  const cash = useUsdcBalance(address);
  const indexed = useQuery({
    queryKey: [...key, "history", "outcomes"],
    enabled: Boolean(address),
    refetchInterval: 30_000,
    retry: (n, e) => n < 1 && !(e instanceof ApiError && (e.status === 404 || e.status === 503)),
    queryFn: () => history.outcomes(address!),
  });
  const indexedRows = indexed.data?.holdings;
  const outcomes = useQuery({
    // The indexed list changes rarely; its size in the key reads a newly found series at once.
    queryKey: [...key, FAST, "outcomes", trendKey, indexedRows?.length ?? 0],
    enabled,
    refetchInterval: 6_000,
    placeholderData: keepPreviousData,
    queryFn: () => readOutcomeHoldings(address!, list!, indexedRows ?? []),
  });
  const perps = useQuery({
    queryKey: [...key, FAST, "perps", trendKey],
    enabled,
    refetchInterval: 6_000,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<PerpHolding[]> => (await readPerpPositions(address!)).map((p) => ({ ...p, trendInfo: list!.find((t) => t.id === p.trend) ?? null })),
  });
  const coins = useQuery({ queryKey: [...key, SLOW, "coins", trendKey], enabled, refetchInterval: 20_000, placeholderData: keepPreviousData, queryFn: () => readCoinHoldings(address!, list!) });
  const assetPerpMarkets = useQuery({ queryKey: ["hl-markets"], queryFn: async () => (await hyperliquid.markets()).markets, refetchInterval: 5_000, staleTime: 4_000 });
  const assetPerps = useQuery({
    queryKey: [...key, FAST, "hyperliquid", assetPerpMarkets.data?.length ?? 0],
    enabled: Boolean(address) && account.kind === "passkey" && Boolean(assetPerpMarkets.data),
    refetchInterval: 5_000,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const r = await hyperliquid.account(address!);
      const markets = assetPerpMarkets.data ?? [];
      const positions: AssetPerpPosition[] = (r.state?.positions ?? [])
        .filter((p) => p.szi !== 0)
        .map((p) => {
          const m = markets.find((x) => x.symbol === p.coin);
          return {
            market: { id: m?.index ?? -1, symbol: p.coin, szDecimals: m?.szDecimals ?? 4, markPx: m?.markPx ?? 0, midPx: m?.midPx ?? null },
            side: p.szi > 0 ? "long" : "short",
            size: Math.abs(p.szi),
            entryPrice: p.entryPx,
            marginUsdc: p.marginUsed,
            pnl: p.unrealizedPnl,
            leverage: p.leverage,
            liquidationPx: p.liquidationPx,
          };
        });
      const inPositions = positions.reduce((a, p) => a + p.marginUsdc + p.pnl, 0);
      return { address: r.address, balance: Math.max(0, (r.state?.accountValue ?? 0) - inPositions), positions };
    },
  });
  const curation = useQuery({ queryKey: [...key, SLOW, "curation"], enabled: Boolean(address), refetchInterval: 30_000, placeholderData: keepPreviousData, queryFn: () => readCuration(address!) });

  // Autopilot: public performance, and (signed in to the API) rules and follows to label positions.
  const performance = useQuery({ queryKey: [...key, "performance"], enabled: Boolean(address), refetchInterval: 60_000, queryFn: () => autopilot.performance(address!) });
  const automation = useQuery({
    queryKey: [...key, "automation"],
    enabled: Boolean(address) && account.backendReady,
    refetchInterval: 30_000,
    queryFn: async (): Promise<{ rules: StoredRule[]; details: RuleDetail[]; following: boolean }> => {
      const [{ rules }, { follows }] = await Promise.all([autopilot.rules(), autopilot.follows()]);
      const details = await Promise.all(rules.slice(0, 12).map((r) => autopilot.rule(r.id).catch(() => null)));
      return { rules, details: details.filter((x): x is RuleDetail => x !== null), following: follows.some((f) => f.status !== "stopped") };
    },
  });

  return { account, address, trends, cash, outcomes, perps, coins, assetPerps, assetPerpMarkets, curation, performance, automation };
}

/** Refreshes everything the portfolio shows right away (after a trade fills). */
export function useRefreshPortfolio() {
  const qc = useQueryClient();
  const { address } = useAccount();
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: portfolioKey(address) }, { cancelRefetch: false });
    void qc.invalidateQueries({ queryKey: ["usdc"] });
  }, [qc, address]);
}

export type PortfolioData = ReturnType<typeof usePortfolioData>;
export { toUsdc };
