import { ruleSchema, type BacktestResult, type Rule } from "@tredio/autopilot";
import { NEAR_CAIP2, Sender, type Viewer, X402_VERSION } from "@tredio/chain";
import { fromRaw, USDC_DECIMALS } from "@tredio/contracts";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { ChainTrend } from "../chain";
import type { Config } from "../config";
import type { Sql } from "../db";
import type { IndexHistory } from "../history";
import { byIp, rateLimit } from "../api/rate-limit";
import { baseOf, isNormalized } from "../identifiers";
import type { Log } from "../log";
import { NearReads, RelayerSettler, type Settler } from "./near";
import { type Offer, Paywall } from "./paywall";
import type { NearState } from "./scheme";
import { X402Payments } from "./store";

/**
 * Tredio's paid API (x402 v2, NEAR `exact` scheme; see paywall.ts). Agents pay per call in USDC
 * from any NEAR account with a full-access key, with no sign-in and no NEAR for gas.
 *
 * - `GET /x402`: free; the paid resources, their prices, the asset, payee and relayer.
 * - `GET /x402/trends/:identifier/history`: every index checkpoint of a trend (the free trend
 *   route shows 7 days) and every per-source reading behind it, with metric and window.
 * - `POST /x402/backtests`: an Autopilot rule backtested on real index history and Hyperliquid
 *   candles, without an account (the app's own backtests need a signed-in account).
 *
 * Paid routes are on when a relayer key is configured (X402_RELAYER_ACCOUNT, X402_RELAYER_KEY).
 */

export interface X402Deps {
  cfg: Config;
  sql: Sql;
  viewer: Viewer;
  trends: () => Promise<ChainTrend[]>;
  history: Pick<IndexHistory, "points">;
  backtest: (rule: Rule, days: number, nowSec: number) => Promise<BacktestResult & { trendId: string | null; resolutionSec: number }>;
  log: Log;
  now?: () => number;
  /** Tests: the chain reads and the settler, instead of RPC and the configured relayer. */
  state?: NearState;
  settler?: Settler | null;
}

/** The most readings one history answer carries; a range narrows a longer history. */
export const MAX_READINGS = 100_000;
/**
 * Paid-route requests per client address per minute. Payments bound real use; this bounds what a
 * client can make the relayer spend on settlements that fail (a balance spent elsewhere meanwhile).
 */
export const PAID_REQUESTS_PER_MINUTE = 60;

const range = z.object({
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
});
const backtestBody = z.object({ rule: z.unknown(), days: z.number().int().min(1).max(30).default(7) });

/** The relayer the paid routes settle through, from config; null leaves them off. */
export function configuredSettler(cfg: Config): Settler | null {
  if (!cfg.X402_RELAYER_ACCOUNT || !cfg.X402_RELAYER_KEY) return null;
  return new RelayerSettler(new Sender({ network: cfg.NEAR_NETWORK, accountId: cfg.X402_RELAYER_ACCOUNT, privateKey: cfg.X402_RELAYER_KEY, rpc: cfg.rpc }));
}

export function x402Routes(d: X402Deps): Hono {
  const app = new Hono();
  const now = d.now ?? Date.now;
  const settler = d.settler === undefined ? configuredSettler(d.cfg) : d.settler;
  const payTo = d.cfg.X402_PAYEE ?? d.cfg.deployment.treasury;
  const asset = d.cfg.deployment.contracts.usdc;
  const paywall = settler
    ? new Paywall({ network: d.cfg.NEAR_NETWORK, asset, payTo, state: d.state ?? new NearReads(d.viewer), settler, payments: new X402Payments(d.sql), trustProxy: d.cfg.TRUSTED_PROXY_HOPS > 0, log: d.log })
    : null;
  const offers = {
    history: { description: "Full-resolution attention index history of a trend with every per-source reading behind it", amount: d.cfg.X402_PRICE },
    backtest: { description: "Backtest of an Autopilot rule on real attention index history and Hyperliquid candles", amount: d.cfg.X402_BACKTEST_PRICE },
  } satisfies Record<string, Offer>;
  const off = (c: Context) => c.json({ error: "paid endpoints are not configured on this server" }, 503);
  const ip = byIp(d.cfg.TRUSTED_PROXY_HOPS);
  const limit = rateLimit(PAID_REQUESTS_PER_MINUTE, 60_000, (c) => `x402:${ip(c)}`, now);

  app.get("/x402", (c) =>
    c.json({
      x402Version: X402_VERSION,
      enabled: paywall !== null,
      scheme: "exact",
      network: NEAR_CAIP2[d.cfg.NEAR_NETWORK],
      asset,
      decimals: USDC_DECIMALS,
      payTo,
      /** Who submits the payment and pays its gas (the facilitator's relayer). */
      relayers: settler?.relayers ?? [],
      spec: "https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_near.md",
      resources: [
        { method: "GET", path: "/v1/x402/trends/{identifier}/history", query: { from: "unix seconds, optional", to: "unix seconds, optional" }, description: offers.history.description, amount: offers.history.amount.toString(), usdc: fromRaw(offers.history.amount, USDC_DECIMALS) },
        { method: "POST", path: "/v1/x402/backtests", body: { rule: "an Autopilot rule", days: "1 to 30, default 7" }, description: offers.backtest.description, amount: offers.backtest.amount.toString(), usdc: fromRaw(offers.backtest.amount, USDC_DECIMALS) },
      ],
    }),
  );

  app.get("/x402/trends/:identifier/history", limit, async (c) => {
    if (!paywall) return off(c);
    const id = c.req.param("identifier").toLowerCase();
    if (!isNormalized(id)) return c.json({ error: "bad identifier" }, 400);
    const q = range.safeParse({ from: c.req.query("from"), to: c.req.query("to") });
    if (!q.success) return c.json({ error: "from and to are unix seconds" }, 400);
    const from = q.data.from ?? 0;
    const to = q.data.to ?? Math.floor(now() / 1000);
    if (to < from) return c.json({ error: "to is before from" }, 400);
    // Free checks first: nobody is asked to pay for a trend that does not exist.
    const trend = (await d.trends()).find((t) => t.identifier === id);
    if (!trend) return c.json({ error: "no such trend" }, 404);
    return paywall.charge(c, offers.history, async () => {
      const base = baseOf(id);
      const [index, rows] = await Promise.all([
        d.history.points(trend.id, from, to),
        d.sql<{ source: string; metric: string; value: number; window_sec: number; observed_at: Date }[]>`
          SELECT source, metric, value, window_sec, observed_at FROM measurements
           WHERE identifier = ${base} AND observed_at >= to_timestamp(${from}) AND observed_at <= to_timestamp(${to})
           ORDER BY observed_at, source LIMIT ${MAX_READINGS + 1}`,
      ]);
      const truncated = rows.length > MAX_READINGS;
      return c.json({
        trend: { identifier: trend.identifier, base, status: trend.status.toLowerCase(), index: trend.index, peakIndex: trend.peakIndex, createdAt: trend.createdAt, updatedAt: trend.updatedAt, reviewHash: trend.reviewHash },
        from,
        to,
        /** Every oracle checkpoint in the range (unix seconds, index points 0 to 100), oldest first. */
        index,
        /** Every collector reading of the topic in the range, oldest first. */
        readings: rows.slice(0, MAX_READINGS).map((r) => ({ source: r.source, metric: r.metric, value: r.value, windowSec: r.window_sec, observedAt: Math.floor(r.observed_at.getTime() / 1000) })),
        truncated,
      });
    });
  });

  app.post("/x402/backtests", limit, async (c) => {
    if (!paywall) return off(c);
    const body = backtestBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") }, 400);
    const rule = ruleSchema.safeParse(body.data.rule);
    if (!rule.success) return c.json({ error: rule.error.issues.map((i) => `rule.${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    return paywall.charge(c, offers.backtest, async () => {
      const result = await d.backtest(rule.data, body.data.days, Math.floor(now() / 1000)).catch((e: Error) => e);
      // A rule the backtester cannot run (no such market) is answered, and not charged.
      if (result instanceof Error) return c.json({ error: result.message }, 422);
      return c.json({ rule: rule.data, days: body.data.days, result });
    });
  });

  return app;
}
