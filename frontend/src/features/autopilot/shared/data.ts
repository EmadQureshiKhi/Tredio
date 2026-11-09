"use client";
import { useQueries, useQuery } from "@tanstack/react-query";
import { withFollowDefaults } from "@tredio/autopilot";
import type { Session } from "@tredio/contracts";
import { useAccount } from "@/lib/account/AccountProvider";
import { ApiError, autopilot, type Grant, type GrantWallet, history, hyperliquid, social } from "@/lib/api";
import { view } from "@/lib/chain/client";
import { BOT_ACCOUNT, isBot } from "@/lib/bot";

/** Queries for Autopilot, copy-trading and the caller screens, keyed by account. */

export { BOT_ACCOUNT, isBot };

/** Hyperliquid's perp markets as Autopilot and the rule screens use them. */
export interface AssetPerpMarket {
  /** Hyperliquid's asset index. */
  id: number;
  symbol: string;
  maxLeverage: number;
  szDecimals: number;
  markPx: number;
  midPx: number | null;
  /** Hyperliquid's maintenance margin: half the initial margin at the market's maximum leverage. */
  maintenanceMargin: number;
}

export function useAssetPerpMarkets() {
  return useQuery({
    queryKey: ["hl-markets"],
    queryFn: async () => (await hyperliquid.markets()).markets,
    refetchInterval: 5_000,
    staleTime: 4_000,
    select: (list): { markets: AssetPerpMarket[] } => ({ markets: list.map((m) => ({ id: m.index, symbol: m.symbol, maxLeverage: m.maxLeverage, szDecimals: m.szDecimals, markPx: m.markPx, midPx: m.midPx, maintenanceMargin: 1 / (2 * Math.max(1, m.maxLeverage)) })) }),
  });
}

/** A market's live mark, from the same refreshing list. */
export function useAssetPerpTicker(id: number | null | undefined) {
  const markets = useAssetPerpMarkets();
  const m = typeof id === "number" ? markets.data?.markets.find((x) => x.id === id) : undefined;
  return { data: m ? { ticker: { mark: m.markPx, mid: m.midPx } } : undefined, isLoading: markets.isLoading };
}

export function useRules() {
  const { address, backendReady } = useAccount();
  return useQuery({ queryKey: ["ap-rules", address], queryFn: () => autopilot.rules(), enabled: backendReady && Boolean(address), refetchInterval: 20_000 });
}

export function useRuleDetail(id: number | null) {
  const { address, backendReady } = useAccount();
  return useQuery({
    queryKey: ["ap-rule", address, id],
    queryFn: () => autopilot.rule(id!),
    enabled: backendReady && id !== null && Number.isInteger(id),
    refetchInterval: 10_000,
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 1,
  });
}

/** Details (stats, last audit event) for each rule in a list, refreshed together. */
export function useRuleDetails(ids: number[]) {
  const { address, backendReady } = useAccount();
  return useQueries({
    queries: ids.map((id) => ({ queryKey: ["ap-rule", address, id], queryFn: () => autopilot.rule(id), enabled: backendReady, refetchInterval: 20_000 })),
  });
}

/** An account's Autopilot record (rules and copies it ran), public. */
export function usePerformance(owner: string | null | undefined) {
  return useQuery({
    queryKey: ["ap-performance", owner?.toLowerCase()],
    queryFn: () => autopilot.performance(owner!.toLowerCase()),
    enabled: Boolean(owner),
    refetchInterval: 30_000,
  });
}

export function useFollows() {
  const { address, backendReady } = useAccount();
  return useQuery({
    queryKey: ["follows", address],
    queryFn: () => autopilot.follows(),
    // Follows stored before slippage and the loss cap read with their defaults.
    select: (d) => ({ follows: d.follows.map((f) => ({ ...f, settings: withFollowDefaults(f.settings) })) }),
    enabled: backendReady && Boolean(address),
    refetchInterval: 20_000,
  });
}

/** The traders worth copying: Hyperliquid mainnet's public leaderboard (testnet has none), with how many Tredio accounts follow each. */
export function useHlLeaders() {
  return useQuery({ queryKey: ["hl-leaders"], queryFn: () => hyperliquid.leaders(), refetchInterval: 300_000, staleTime: 120_000, retry: 1 });
}

/** The Hyperliquid address a Tredio account trades from (its Chain Signatures key); fixed. */
export function useHlAddress(account: string | null | undefined) {
  return useQuery({ queryKey: ["hl-address", account], enabled: Boolean(account), staleTime: Infinity, queryFn: async () => (await hyperliquid.account(account!)).address.toLowerCase() });
}

export function useLeaderboard() {
  return useQuery({ queryKey: ["callers-leaderboard"], queryFn: () => social.leaderboard(), refetchInterval: 30_000 });
}

/** Traders across every product, by realized PnL (from the indexer; 503 while it is not set up). */
export function useTraders() {
  return useQuery({ queryKey: ["leaderboard-traders"], queryFn: () => history.traders(), refetchInterval: 60_000, retry: (n, e) => !(e instanceof ApiError && e.status === 503) && n < 1 });
}

/** One account's record across every product, from the indexer. */
export function useAccountHistory(account: string | null | undefined) {
  return useQuery({
    queryKey: ["account-history", account],
    queryFn: () => history.account(account!),
    enabled: Boolean(account),
    refetchInterval: 60_000,
    retry: (n, e) => !(e instanceof ApiError && (e.status === 503 || e.status === 404)) && n < 1,
  });
}

export function useCaller(idOrHandle: string | null | undefined) {
  return useQuery({
    queryKey: ["caller", idOrHandle?.toLowerCase()],
    queryFn: () => social.caller(idOrHandle!.toLowerCase()),
    enabled: Boolean(idOrHandle),
    refetchInterval: 30_000,
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 1,
  });
}

/**
 * Autopilot's access to the account, as the chain sees it: the API records the grant, the account
 * holds the session. A session revoked or expired on chain no longer trades, whatever the API says.
 */
export type GrantState = "none" | "active" | "expired" | "revoked";
export interface GrantView {
  state: GrantState;
  sessionKey: string | null;
  validUntil: number;
  /** USDC the session may move per UTC day. */
  dailyLimit: number;
  /** USDC moved so far today. */
  spentToday: number;
  backend: Grant | null;
  /** The policy wallet that signs Autopilot's session calls, or null when the executor holds a sealed session key. */
  wallet: GrantWallet | null;
}

const NONE: GrantView = { state: "none", sessionKey: null, validUntil: 0, dailyLimit: 0, spentToday: 0, backend: null, wallet: null };

const readSession = (account: string, key: string) => view<Session | null>(account, "session", { public_key: key });

export async function loadGrant(account: string): Promise<GrantView> {
  const stored = (await autopilot.grant()).grant;
  if (!stored) return NONE;
  let grant: Grant = stored;
  const now = Math.floor(Date.now() / 1000);
  // A grant (or replacement key) added on chain whose confirmation never reached the API: finish it now.
  const waiting = grant.status === "pending" ? grant.sessionKey : (grant.nextSessionKey ?? null);
  if (waiting) {
    const s = await readSession(account, waiting);
    if (s && s.expires_at > now) grant = await autopilot.confirmGrant().then((r) => r.grant, () => stored);
  }
  const onChain = await readSession(account, grant.sessionKey);
  if (grant.status === "pending") return { ...NONE, backend: grant };
  const today = Math.floor(now / 86_400);
  const base = {
    sessionKey: grant.sessionKey,
    validUntil: onChain?.expires_at ?? grant.validUntil,
    dailyLimit: Number(onChain?.daily_limit ?? grant.dailyLimit) / 1e6,
    spentToday: onChain && onChain.day === today ? Number(onChain.spent) / 1e6 : 0,
    backend: grant,
    wallet: grant.wallet ?? null,
  };
  if (!onChain || grant.status === "revoked") return { ...base, state: "revoked" };
  if (onChain.expires_at <= now || grant.status === "expired") return { ...base, state: "expired" };
  return { ...base, state: "active" };
}

export function useGrant() {
  const { address, backendReady, kind } = useAccount();
  return useQuery({ queryKey: ["ap-grant", address], queryFn: () => loadGrant(address!), enabled: backendReady && Boolean(address) && kind === "passkey", refetchInterval: 30_000 });
}

/** Autopilot refuses to enable rules on a grant with less than an hour left. */
export const grantUsable = (g: GrantView | undefined) => g?.state === "active" && g.validUntil > Date.now() / 1000 + 3600;
