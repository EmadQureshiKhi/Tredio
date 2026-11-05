import { type BacktestResult, backtest, type Candle, type Point, type Rule } from "@tredio/autopilot";
import type { HyperliquidInfo, PerpMarket } from "@tredio/hyperliquid";
import type { ChainReader, ChainTrend } from "../chain";
import type { Sql } from "../db";
import type { IndexHistory } from "../history";
import { baseOf } from "../identifiers";

/**
 * Autopilot reads: Hyperliquid's perp markets, the trend a rule follows, and backtests built from
 * the trend's attention history, smart-money readings and Hyperliquid candles.
 */

export const MAX_BACKTEST_DAYS = 30;
/** Hyperliquid returns at most 5,000 candles per request; pages stay well under that. */
const CANDLES_PER_REQUEST = 1000;
/**
 * Candle pages are cached so backtests share upstream requests: a page wholly in the past never
 * changes, so it is kept longer; the page holding the current candle is refetched after a minute.
 */
export const LIVE_CANDLE_PAGE_MS = 60_000;
export const PAST_CANDLE_PAGE_MS = 15 * 60_000;

const INTERVALS = [
  { sec: 300, name: "5m" },
  { sec: 900, name: "15m" },
  { sec: 3600, name: "1h" },
] as const;

export class AutopilotService {
  private candlePages = new Map<string, { expires: number; value: Promise<Candle[]> }>();

  constructor(
    private readonly sql: Sql,
    private readonly chain: ChainReader,
    private readonly history: IndexHistory,
    readonly hyperliquid: HyperliquidInfo,
    private readonly opts: { takerFeeBps: number; slippageBps: number },
    private readonly now: () => number = Date.now,
  ) {}

  /** Hyperliquid's listed perps on this network, with their marks (cached a few seconds). */
  markets(): Promise<PerpMarket[]> {
    return this.hyperliquid.perpMarkets();
  }

  async market(symbol: string): Promise<PerpMarket | null> {
    return this.hyperliquid.market(symbol);
  }

  /** The trend a rule follows: the newest listing of its base identifier, live ones first. */
  async trendFor(identifier: string): Promise<ChainTrend | null> {
    const base = baseOf(identifier.toLowerCase());
    const matches = (await this.chain.trends()).filter((t) => baseOf(t.identifier) === base);
    const live = matches.filter((t) => t.status !== "Retired");
    return (live.length > 0 ? live : matches).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  }

  async attention(trendId: string, sinceSec: number, untilSec?: number): Promise<Point[]> {
    return this.history.points(trendId, sinceSec, untilSec);
  }

  async netflow(identifier: string, sinceSec: number): Promise<Point[]> {
    const rows = await this.sql<{ value: number; observed_at: Date }[]>`
      SELECT value, observed_at FROM measurements
       WHERE identifier = ${baseOf(identifier)} AND source = 'nansen' AND observed_at >= to_timestamp(${sinceSec})
       ORDER BY observed_at`;
    return rows.map((r) => ({ t: Math.floor(r.observed_at.getTime() / 1000), v: r.value }));
  }

  async candles(market: PerpMarket, fromSec: number, toSec: number): Promise<{ candles: Candle[]; resolutionSec: number }> {
    // Five-minute candles for up to about a month, coarser beyond, about ten requests at most.
    const span = toSec - fromSec;
    const interval = INTERVALS.find((r) => span / r.sec <= CANDLES_PER_REQUEST * 10) ?? INTERVALS[INTERVALS.length - 1]!;
    // Pages sit on a fixed grid, so backtests of any length and start share them.
    const pageSec = interval.sec * CANDLES_PER_REQUEST;
    const pages: Promise<Candle[]>[] = [];
    for (let p = Math.floor(fromSec / pageSec); p * pageSec < toSec; p++) pages.push(this.candlePage(market.symbol, interval, p * pageSec, (p + 1) * pageSec));
    const seen = new Set<number>();
    const candles = (await Promise.all(pages))
      .flat()
      .filter((c) => c.t >= fromSec && c.t <= toSec && !seen.has(c.t) && seen.add(c.t))
      .sort((a, b) => a.t - b.t);
    return { candles, resolutionSec: interval.sec };
  }

  /** One page of candles, shared by every caller while it is fresh; a failed read is not kept. */
  private candlePage(coin: string, interval: (typeof INTERVALS)[number], startSec: number, endSec: number): Promise<Candle[]> {
    const key = `${coin}:${interval.sec}:${startSec}`;
    const now = this.now();
    const hit = this.candlePages.get(key);
    if (hit && hit.expires > now) return hit.value;
    for (const [k, v] of this.candlePages) if (v.expires <= now) this.candlePages.delete(k);
    const value = this.hyperliquid
      .candles(coin, interval.name, startSec * 1000, Math.min(endSec, Math.floor(now / 1000)) * 1000)
      .then((page) => page.map((c) => ({ t: Math.floor(c.t / 1000), o: c.o, h: c.h, l: c.l, c: c.c })));
    const entry = { expires: now + (endSec * 1000 > now ? LIVE_CANDLE_PAGE_MS : PAST_CANDLE_PAGE_MS), value };
    this.candlePages.set(key, entry);
    value.catch(() => {
      if (this.candlePages.get(key) === entry) this.candlePages.delete(key);
    });
    return value;
  }

  /** Replays `rule` over the last `days` days. */
  async backtest(rule: Rule, days: number, nowSec = Math.floor(Date.now() / 1000)): Promise<BacktestResult & { trendId: string | null; resolutionSec: number }> {
    const market = await this.market(rule.market);
    if (!market) throw new Error(`Hyperliquid has no ${rule.market} perp on this network`);
    const from = nowSec - Math.min(days, MAX_BACKTEST_DAYS) * 86_400;
    const trend = await this.trendFor(rule.trend);
    // Index history from before the window lets the first candles see a full lookback.
    const lookback = rule.entry.windowMin * 60;
    const [attention, netflow, priced] = await Promise.all([
      trend ? this.attention(trend.id, from - lookback, nowSec) : Promise.resolve([]),
      this.netflow(rule.trend, from - 86_400),
      this.candles(market, from, nowSec),
    ]);
    const result = backtest({
      rule,
      candles: priced.candles,
      resolutionSec: priced.resolutionSec,
      attention,
      netflow,
      feeBps: this.opts.takerFeeBps,
      slippageBps: this.opts.slippageBps,
    });
    if (!trend) result.warnings.unshift(`no trend ${rule.trend} is listed yet`);
    return { ...result, trendId: trend?.id ?? null, resolutionSec: priced.resolutionSec };
  }
}
