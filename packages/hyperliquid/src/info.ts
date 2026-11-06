/**
 * Hyperliquid's public info API: perp markets with their marks and funding, an account's
 * positions and fills, candles, and the public leaderboard (the traders Tredio accounts can copy).
 */

// #mainnet: each network has its own hosts below; Hyperliquid's leaderboard exists on mainnet only.
export type HlNetwork = "testnet" | "mainnet";

export const API_URL: Record<HlNetwork, string> = {
  mainnet: "https://api.hyperliquid.xyz",
  testnet: "https://api.hyperliquid-testnet.xyz",
};
export const APP_URL: Record<HlNetwork, string> = {
  mainnet: "https://app.hyperliquid.xyz",
  testnet: "https://app.hyperliquid-testnet.xyz",
};
/**
 * Hyperliquid publishes a leaderboard for mainnet only. Leaders are always real mainnet traders:
 * a follower on testnet copies their mainnet positions into its own testnet account.
 */
export const LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";

export interface PerpMarket {
  /** Asset index, as orders name it. */
  index: number;
  symbol: string;
  szDecimals: number;
  maxLeverage: number;
  markPx: number;
  midPx: number | null;
  oraclePx: number;
  /** Hourly funding rate (fraction). */
  funding: number;
  openInterest: number;
  dayNtlVlm: number;
  prevDayPx: number;
}

export interface Position {
  coin: string;
  /** Signed size: positive long, negative short. */
  szi: number;
  entryPx: number | null;
  positionValue: number;
  unrealizedPnl: number;
  marginUsed: number;
  leverage: number;
  liquidationPx: number | null;
}

export interface AccountState {
  accountValue: number;
  withdrawable: number;
  totalMarginUsed: number;
  positions: Position[];
  time: number;
}

export interface Fill {
  coin: string;
  px: number;
  sz: number;
  side: "B" | "A";
  time: number;
  closedPnl: number;
  dir: string;
  hash: string;
  oid: number;
  fee: number;
}

export interface Candle {
  /** Open time, ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Leader {
  address: string;
  displayName: string | null;
  accountValue: number;
  /** Profit and return over the window, from Hyperliquid's leaderboard. */
  pnl: number;
  roi: number;
  volume: number;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const n = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : Number.NaN);
const nOrNull = (v: unknown) => (v === null || v === undefined || v === "" ? null : n(v));

export class HyperliquidInfo {
  readonly url: string;
  private markets: { at: number; list: PerpMarket[] } | null = null;

  constructor(
    readonly network: HlNetwork,
    private readonly fetchImpl: Fetch = fetch,
    url?: string,
  ) {
    this.url = url ?? API_URL[network];
  }

  async post<T>(body: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(`${this.url}/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Hyperliquid info ${String(body.type)}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /** Every listed perp with its mark, cached for `maxAgeMs`. Delisted markets are left out. */
  async perpMarkets(maxAgeMs = 5_000): Promise<PerpMarket[]> {
    if (this.markets && Date.now() - this.markets.at < maxAgeMs) return this.markets.list;
    const [meta, ctxs] = await this.post<[{ universe: Array<{ name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean }> }, Array<Record<string, unknown>>]>({ type: "metaAndAssetCtxs" });
    const list = meta.universe.flatMap((u, index): PerpMarket[] => {
      const c = ctxs[index];
      if (!c || u.isDelisted) return [];
      return [
        {
          index,
          symbol: u.name,
          szDecimals: u.szDecimals,
          maxLeverage: u.maxLeverage,
          markPx: n(c.markPx),
          midPx: nOrNull(c.midPx),
          oraclePx: n(c.oraclePx),
          funding: n(c.funding),
          openInterest: n(c.openInterest),
          dayNtlVlm: n(c.dayNtlVlm),
          prevDayPx: n(c.prevDayPx),
        },
      ];
    });
    this.markets = { at: Date.now(), list };
    return list;
  }

  async market(symbol: string): Promise<PerpMarket | null> {
    return (await this.perpMarkets()).find((m) => m.symbol.toUpperCase() === symbol.toUpperCase()) ?? null;
  }

  async accountState(user: string): Promise<AccountState> {
    const s = await this.post<{
      marginSummary: { accountValue: string; totalMarginUsed: string };
      withdrawable: string;
      assetPositions: Array<{ position: Record<string, unknown> & { leverage?: { value: number } } }>;
      time: number;
    }>({ type: "clearinghouseState", user: user.toLowerCase() });
    return {
      accountValue: n(s.marginSummary.accountValue),
      withdrawable: n(s.withdrawable),
      totalMarginUsed: n(s.marginSummary.totalMarginUsed),
      time: s.time,
      positions: s.assetPositions.map(({ position: p }) => ({
        coin: String(p.coin),
        szi: n(p.szi),
        entryPx: nOrNull(p.entryPx),
        positionValue: n(p.positionValue),
        unrealizedPnl: n(p.unrealizedPnl),
        marginUsed: n(p.marginUsed),
        leverage: p.leverage?.value ?? 1,
        liquidationPx: nOrNull(p.liquidationPx),
      })),
    };
  }

  async fills(user: string): Promise<Fill[]> {
    const rows = await this.post<Array<Record<string, unknown>>>({ type: "userFills", user: user.toLowerCase() });
    return rows.map((f) => ({
      coin: String(f.coin),
      px: n(f.px),
      sz: n(f.sz),
      side: f.side === "B" ? "B" : "A",
      time: n(f.time),
      closedPnl: n(f.closedPnl),
      dir: String(f.dir ?? ""),
      hash: String(f.hash ?? ""),
      oid: n(f.oid),
      fee: n(f.fee),
    }));
  }

  async openOrders(user: string): Promise<Array<{ coin: string; oid: number; side: "B" | "A"; limitPx: number; sz: number; timestamp: number }>> {
    const rows = await this.post<Array<Record<string, unknown>>>({ type: "openOrders", user: user.toLowerCase() });
    return rows.map((o) => ({ coin: String(o.coin), oid: n(o.oid), side: o.side === "B" ? "B" : "A", limitPx: n(o.limitPx), sz: n(o.sz), timestamp: n(o.timestamp) }));
  }

  async candles(coin: string, interval: "1m" | "5m" | "15m" | "1h" | "4h" | "1d", startTime: number, endTime: number): Promise<Candle[]> {
    const rows = await this.post<Array<Record<string, unknown>>>({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } });
    return rows.map((c) => ({ t: n(c.t), o: n(c.o), h: n(c.h), l: n(c.l), c: n(c.c), v: n(c.v) }));
  }

  /** Mainnet's public leaderboard over `window`, best by profit first (whatever this client's network). */
  async leaders(window: "day" | "week" | "month" | "allTime" = "month", limit = 50): Promise<Leader[]> {
    const res = await this.fetchImpl(LEADERBOARD_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Hyperliquid leaderboard: HTTP ${res.status}`);
    const body = (await res.json()) as { leaderboardRows?: Array<{ ethAddress: string; displayName: string | null; accountValue: string; windowPerformances: Array<[string, { pnl: string; roi: string; vlm: string }]> }> };
    return (body.leaderboardRows ?? [])
      .map((r) => {
        const w = r.windowPerformances.find(([k]) => k === window)?.[1];
        return { address: r.ethAddress.toLowerCase(), displayName: r.displayName, accountValue: n(r.accountValue), pnl: n(w?.pnl), roi: n(w?.roi), volume: n(w?.vlm) };
      })
      .filter((l) => Number.isFinite(l.pnl))
      .sort((a, b) => b.pnl - a.pnl)
      .slice(0, limit);
  }
}
