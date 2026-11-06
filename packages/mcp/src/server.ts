import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type RpcReader, type X402Signer, x402Fetch } from "@tredio/chain";
import {
  COIN_DECIMALS,
  type Curve,
  type CurveQuote,
  type Deployment,
  type Depth,
  fromRaw,
  type IndexSnapshot,
  indexPoints,
  type Market,
  type PerpMarket,
  type Position,
  type PositionState,
  type Series,
  type Session,
  tickToPrice,
  toRaw,
  type Trend,
  USDC_DECIMALS,
} from "@tredio/contracts";
import { z } from "zod";
import type { TredioApi } from "./api";
import type { ChainViews, TxIndex } from "./chain";
import { checkReview, type ReviewEvidence, verifyIndex } from "./verify";

/**
 * The Tredio MCP server: tools an agent uses to read Tredio's attention markets, each answering
 * structured JSON. Reads come from the public API and, where the truth is on chain, from NEAR
 * RPC views of the Tredio contracts. Every tool is read-only, except `buy_trend_history`, which
 * exists only when a payer key is configured and spends at most the configured USDC per call.
 */

export interface ServerDeps {
  api: TredioApi;
  chain: ChainViews;
  txIndex: TxIndex;
  deployment: Deployment;
  network: "testnet" | "mainnet";
  /** x402 purchases: the payer and the most it pays per call (USDC atomic units). Absent, no paying tool. */
  x402?: { signer: X402Signer; rpc: RpcReader; maxAmount: bigint } | null;
  fetchImpl?: typeof fetch;
}

export const SERVER_NAME = "tredio";
export const SERVER_VERSION = "0.1.0";

const usdc = (raw: string | bigint | number) => fromRaw(BigInt(raw), USDC_DECIMALS);
const identifier = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9:._-]{1,64}$/, "a trend identifier such as topic:world-cup");
const account = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, "a NEAR account id")
  .min(2)
  .max(64);
const WINDOWS = { "15m": 900, "24h": 86_400, "7d": 604_800 } as const;
const windowName = (sec: number) => (Object.entries(WINDOWS).find(([, s]) => s === sec)?.[0] ?? `${sec}s`) as string;
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

type Result = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
const run =
  <A>(fn: (args: A) => Promise<Record<string, unknown>>) =>
  async (args: A): Promise<Result> => {
    try {
      const data = await fn(args);
      return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
    } catch (e) {
      return { content: [{ type: "text", text: String((e as Error).message ?? e) }], isError: true };
    }
  };

interface ApiTrend {
  identifier: string;
  displayName: string | null;
  summary: string | null;
  assetClass: string;
  status: string;
  index: number;
  peakIndex: number;
  createdAt: number;
  updatedAt: number;
  surfacer: string;
  reviewHash: string | null;
  asset: string | null;
  keywords: string[];
  article: string | null;
  ticker: string | null;
  readings: Record<string, { value: number; windowSec: number; observedAt: number } | null>;
  change24h?: number | null;
  rotatingOut?: boolean;
}

const seriesJson = (s: Series) => ({
  series: s.id,
  trend: s.trend,
  window: windowName(s.window),
  openedAt: s.opened_at,
  expiry: s.expiry,
  openingIndex: indexPoints(s.opening_index),
  outcome: s.outcome,
  settlementIndex: s.settlement_index === null ? null : indexPoints(s.settlement_index),
  upSupply: usdc(s.up_supply),
  downSupply: usdc(s.down_supply),
  backingUsdc: usdc(s.backing),
});

export function createServer(d: ServerDeps): McpServer {
  const c = d.deployment.contracts;
  const view = <T>(contract: string, method: string, args: object = {}) => d.chain.view<T>(contract, method, args);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tredio lists internet trends on NEAR, each with an attention index from 0 to 100 that a TEE oracle writes to the registry contract, and markets on it: Up/Down outcome series (24h, 7d), attention perps (up to 3x) and trend coins. " +
        "Start with list_trends, then get_trend for one trend's markets. Index values are points (0 to 100, 6 decimals on chain); USDC amounts are decimal strings. " +
        `This server reads ${d.network}; testnet balances have no value. verify_index checks the oracle's signature on chain instead of trusting the API.`,
    },
  );

  server.registerTool(
    "get_status",
    {
      title: "Tredio status",
      description: "Health of Tredio on this network: each service, the oracle's freshness (seconds since its last run, stale trends), the NEAR chain head, the service wallets, and the contract account ids.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    run(async () => {
      const status = await d.api.get<Record<string, unknown>>("/v1/status", { okStatuses: [503] });
      return { network: d.network, api: d.api.baseUrl, contracts: c, ...status };
    }),
  );

  server.registerTool(
    "list_trends",
    {
      title: "List trends",
      description: "The trends listed on Tredio with their current attention index (points, 0 to 100), peak, 24h change in percent, status (active, cooling, retired), asset class and the NEAR AI review hash. Live trends only unless includeRetired.",
      inputSchema: { includeRetired: z.boolean().default(false).describe("also list retired trends") },
      annotations: READ_ONLY,
    },
    run(async ({ includeRetired }: { includeRetired: boolean }) => {
      const r = await d.api.get<{ lastRunId: number; trends: ApiTrend[] }>(`/v1/trends${includeRetired ? "?all=1" : ""}`);
      return {
        lastOracleRun: r.lastRunId,
        trends: r.trends.map((t) => ({
          identifier: t.identifier,
          name: t.displayName,
          summary: t.summary,
          assetClass: t.assetClass,
          status: t.status,
          index: t.index,
          peakIndex: t.peakIndex,
          change24hPct: t.change24h ?? null,
          updatedAt: t.updatedAt,
          reviewHash: t.reviewHash,
          hyperliquidAsset: t.asset,
          rotatingOut: t.rotatingOut ?? false,
        })),
      };
    }),
  );

  server.registerTool(
    "get_trend",
    {
      title: "Get a trend",
      description:
        "One trend: what it is, its attention index and peak as the registry contract holds them (with freshness), the latest reading of each source (Bluesky, GDELT, Wikipedia, Hacker News, Elfa, Nansen), the NEAR AI review hash, and its markets: the current Up/Down series per window, the perp's open interest and funding, and the trend coin. Use get_market, get_perp_market or get_coin next.",
      inputSchema: { identifier: identifier.describe("trend identifier, for example topic:world-cup") },
      annotations: READ_ONLY,
    },
    run(async ({ identifier: id }: { identifier: string }) => {
      const [detail, onChain, windows] = await Promise.all([
        d.api.get<{ trend: ApiTrend; relistedAs: string | null }>(`/v1/trends/${encodeURIComponent(id)}`),
        view<Trend | null>(c.registry, "get_trend", { id }),
        view<number[]>(c.outcomes, "windows").catch(() => [WINDOWS["24h"], WINDOWS["7d"]]),
      ]);
      const [series, perp, funding, curve] = await Promise.all([
        Promise.all(windows.map((w) => view<Series | null>(c.outcomes, "latest_series", { trend: id, window: w }))),
        view<PerpMarket>(c.perps, "get_market", { trend: id }),
        view<string>(c.perps, "funding_rate", { trend: id }),
        view<Curve | null>(c.coins, "get_curve", { trend: id }),
      ]);
      const t = detail.trend;
      return {
        identifier: t.identifier,
        name: t.displayName,
        summary: t.summary,
        assetClass: t.assetClass,
        keywords: t.keywords,
        wikipediaArticle: t.article,
        surfacer: t.surfacer,
        createdAt: t.createdAt,
        reviewHash: t.reviewHash,
        relistedAs: detail.relistedAs,
        rotatingOut: t.rotatingOut ?? false,
        onChain: onChain
          ? { registry: c.registry, status: onChain.status, index: indexPoints(onChain.index), peakIndex: indexPoints(onChain.peak_index), updatedAt: onChain.updated_at, fresh: onChain.fresh, reviewHash: onChain.review_hash }
          : null,
        readings: t.readings,
        markets: {
          series: series.filter((s): s is Series => s !== null).map(seriesJson),
          perp: { contract: c.perps, longContracts: fromRaw(BigInt(perp.long_qty), COIN_DECIMALS, 6), shortContracts: fromRaw(BigInt(perp.short_qty), COIN_DECIMALS, 6), fundingRatePerSec: Number(funding) / 1e18, lastMark: indexPoints(perp.last_mark) },
          coin: curve ? { account: curve.coin, stage: curve.stage, reserveUsdc: usdc(curve.reserve), soldCoins: fromRaw(BigInt(curve.sold), COIN_DECIMALS, 6), rheaPoolId: curve.pool_id } : null,
          hyperliquid: t.asset ? { asset: t.asset } : null,
        },
      };
    }),
  );

  server.registerTool(
    "get_index_history",
    {
      title: "Attention index history",
      description:
        "A trend's attention index over time as [{t: unix seconds, v: points}], oldest first. source \"api\": the last 7 days of every oracle checkpoint from Tredio's mirror; source \"chain\": the last 96 checkpoints straight from the registry contract. The full history since listing with per-source readings is a paid x402 resource (get_paid_api).",
      inputSchema: { identifier: identifier.describe("trend identifier"), source: z.enum(["api", "chain"]).default("api") },
      annotations: READ_ONLY,
    },
    run(async ({ identifier: id, source }: { identifier: string; source: "api" | "chain" }) => {
      const points =
        source === "chain"
          ? (await view<Array<{ at: number; index: number }>>(c.registry, "history", { id })).map((p) => ({ t: p.at, v: indexPoints(p.index) }))
          : (await d.api.get<{ index: Array<{ t: number; v: number }> }>(`/v1/trends/${encodeURIComponent(id)}`)).index;
      const values = points.map((p) => p.v);
      return {
        identifier: id,
        source,
        count: points.length,
        first: points[0] ?? null,
        last: points.at(-1) ?? null,
        min: values.length ? Math.min(...values) : null,
        max: values.length ? Math.max(...values) : null,
        points,
      };
    }),
  );

  server.registerTool(
    "get_market",
    {
      title: "Up/Down series market",
      description:
        "An Up/Down outcome series and its order book on the book contract: the series (opening index, expiry, outcome), the attention-implied fair value of Up and Down from the registry, and for each side the last price, volume and the best bid and ask levels. Prices are USDC per token (a winning token redeems 1 USDC, a complete Up+Down set always 1 USDC); sizes are tokens. Give a series id, or a trend and a window.",
      inputSchema: {
        series: z.number().int().positive().optional().describe("series id (from get_trend)"),
        trend: identifier.optional().describe("trend identifier, with window"),
        window: z.enum(["15m", "24h", "7d"]).default("24h").describe("series window when picking by trend (15m exists on testnet only)"),
        levels: z.number().int().min(1).max(20).default(5).describe("price levels per side"),
      },
      annotations: READ_ONLY,
    },
    run(async (a: { series?: number; trend?: string; window: keyof typeof WINDOWS; levels: number }) => {
      if (a.series === undefined && !a.trend) throw new Error("give a series id, or a trend and a window");
      const s = a.series !== undefined ? await view<Series | null>(c.outcomes, "get_series", { series: a.series }) : await view<Series | null>(c.outcomes, "latest_series", { trend: a.trend, window: WINDOWS[a.window] });
      if (!s) throw new Error(a.series !== undefined ? `no series ${a.series}` : `no ${a.window} series for ${a.trend}`);
      const side = async (name: "up" | "down") => {
        const [m, depth] = await Promise.all([view<Market | null>(c.book, "get_market", { series: s.id, side: name }), view<Depth>(c.book, "depth", { series: s.id, side: name, levels: a.levels }).catch(() => null)]);
        const level = (l: { tick: number; size: string }) => ({ price: tickToPrice(l.tick), size: usdc(l.size) });
        return m
          ? { listed: true, lastPrice: m.last_tick === null ? null : tickToPrice(m.last_tick), volumeUsdc: usdc(m.volume_usdc), trades: m.trades, bids: depth?.bids.map(level) ?? [], asks: depth?.asks.map(level) ?? [] }
          : { listed: false, lastPrice: null, volumeUsdc: "0", trades: 0, bids: [], asks: [] };
      };
      const [snap, fair, up, down] = await Promise.all([
        view<IndexSnapshot | null>(c.registry, "index_of", { id: s.trend }),
        s.outcome === "open" ? view<string>(c.registry, "fair_up", { id: s.trend, opening: s.opening_index, expiry: s.expiry }).catch(() => null) : Promise.resolve(null),
        side("up"),
        side("down"),
      ]);
      return {
        book: c.book,
        ...seriesJson(s),
        index: snap ? { now: indexPoints(snap.index), fresh: snap.fresh, updatedAt: snap.updated_at } : null,
        fairValue: fair === null ? null : { up: Number(usdc(fair)), down: Number(usdc(1_000_000n - BigInt(fair))) },
        up,
        down,
        tickUsdc: 0.001,
        takerFeeBps: d.deployment.params.bookTakerFeeBps,
      };
    }),
  );

  server.registerTool(
    "get_perp_market",
    {
      title: "Attention perp market",
      description:
        "A trend's attention perp on the perps contract: long and short open interest (contracts and USDC notional), the funding rate (positive: longs pay shorts), the last mark, the open interest cap per side and the insurance pool. One contract is worth 1 USDC per index point; isolated margin up to 3x; 10% maintenance margin; 10 bps fee per trade.",
      inputSchema: { trend: identifier.describe("trend identifier") },
      annotations: READ_ONLY,
    },
    run(async ({ trend }: { trend: string }) => {
      const [m, rate, pool, snap] = await Promise.all([view<PerpMarket>(c.perps, "get_market", { trend }), view<string>(c.perps, "funding_rate", { trend }), view<string>(c.perps, "pool"), view<IndexSnapshot | null>(c.registry, "index_of", { id: trend })]);
      if (!snap) throw new Error(`no trend ${trend} in the registry`);
      const cap = await view<string>(c.perps, "open_interest_cap", { index: snap.index });
      const contracts = (qty: string) => Number(fromRaw(BigInt(qty), COIN_DECIMALS, 9));
      const perSec = Number(rate) / 1e18;
      return {
        contract: c.perps,
        trend,
        index: indexPoints(snap.index),
        fresh: snap.fresh,
        status: snap.status,
        longContracts: contracts(m.long_qty),
        shortContracts: contracts(m.short_qty),
        longNotionalUsdc: Number((contracts(m.long_qty) * indexPoints(snap.index)).toFixed(6)),
        shortNotionalUsdc: Number((contracts(m.short_qty) * indexPoints(snap.index)).toFixed(6)),
        fundingRatePerSec: perSec,
        fundingPctPerDay: Number((perSec * 86_400 * 100).toFixed(6)),
        lastMark: indexPoints(m.last_mark),
        lastMarkAt: m.last_time,
        openInterestCapPerSideUsdc: usdc(cap),
        poolUsdc: usdc(pool),
        maxLeverage: 3,
        maintenanceMarginPct: 10,
        tradeFeeBps: 10,
      };
    }),
  );

  server.registerTool(
    "get_coin",
    {
      title: "Trend coin",
      description:
        "A trend's coin on the coins factory: its NEP-141 account, bonding-curve stage (open, then pooled and graduated into a Rhea pool), USDC reserve, coins sold, the floor reserve that ratchets with peak attention, and the spot price in USDC per coin. With buyUsdc, also quotes how many coins that USDC buys now (fee included).",
      inputSchema: { trend: identifier.describe("trend identifier"), buyUsdc: z.string().regex(/^\d+(\.\d{1,6})?$/).optional().describe("USDC to quote a buy for, for example \"5\"") },
      annotations: READ_ONLY,
    },
    run(async ({ trend, buyUsdc }: { trend: string; buyUsdc?: string }) => {
      const curve = await view<Curve | null>(c.coins, "get_curve", { trend });
      if (!curve) throw new Error(`${trend} has no coin yet`);
      // A buy first raises the floor to the trend's peak attention, so the quote takes the registry's peak.
      const peak = buyUsdc ? ((await view<{ peak_index: number } | null>(c.registry, "index_of", { id: trend }))?.peak_index ?? null) : null;
      const [spot, quote] = await Promise.all([view<string>(c.coins, "spot_price", { trend }), buyUsdc ? view<CurveQuote | null>(c.coins, "quote_buy", { trend, usdc_in: toRaw(buyUsdc, USDC_DECIMALS).toString(), ...(peak !== null ? { peak_index: peak } : {}) }) : Promise.resolve(null)]);
      return {
        factory: c.coins,
        coin: curve.coin,
        trend,
        stage: curve.stage,
        createdAt: curve.created_at,
        peakIndexAtCreation: indexPoints(curve.peak_at_creation),
        // Spot is USDC (6 decimals) per whole coin, WAD-scaled.
        spotUsdc: fromRaw(BigInt(spot), USDC_DECIMALS + 18, 12),
        reserveUsdc: usdc(curve.reserve),
        floorReserveUsdc: usdc(curve.floor_reserve),
        virtualQuoteUsdc: usdc(curve.virtual_quote),
        soldCoins: fromRaw(BigInt(curve.sold), COIN_DECIMALS, 6),
        rheaPoolId: curve.pool_id,
        decimals: COIN_DECIMALS,
        quote: quote ? { usdcIn: buyUsdc, coinsOut: fromRaw(BigInt(quote.out), COIN_DECIMALS, 6), feeUsdc: usdc(quote.fee), spotAfterUsdc: fromRaw(BigInt(quote.spot_after), USDC_DECIMALS + 18, 12) } : null,
      };
    }),
  );

  server.registerTool(
    "get_review",
    {
      title: "NEAR AI Cloud review",
      description:
        "The signed NEAR AI Cloud evidence behind a listing's AI review, by the review hash the registry stores with the trend: the verifiable model, the signature kind (provider_tee: signed inside the model's TEE), the signed text, signer address and signature. Also checks it here: the evidence hashes to the review hash, and the ECDSA signature recovers the named signer. The signer's hardware attestation is at verifyUrl.",
      inputSchema: { hash: z.string().trim().toLowerCase().regex(/^[0-9a-f]{64}$/, "a 64-hex review hash").describe("review hash from get_trend or list_trends") },
      annotations: READ_ONLY,
    },
    run(async ({ hash }: { hash: string }) => {
      const r = await d.api.get<{ hash: string; evidence: ReviewEvidence; createdAt: string }>(`/v1/reviews/${hash}`);
      return { hash: r.hash, createdAt: r.createdAt, evidence: r.evidence, checks: checkReview(hash, r.evidence) };
    }),
  );

  server.registerTool(
    "verify_index",
    {
      title: "Verify the attention index",
      description:
        "Checks, without trusting the API, that a trend's newest index checkpoint on the registry came from the oracle: finds the submit_report transaction for that checkpoint, reads it from NEAR RPC, verifies the ed25519 signature over SHA-256 of the exact report JSON with the oracle key the registry trusts (as the registry itself does), and confirms the transaction succeeded and wrote that value (reporting a move the registry clamped).",
      inputSchema: { identifier: identifier.describe("trend identifier") },
      annotations: READ_ONLY,
    },
    run(async ({ identifier: id }: { identifier: string }) => ({ ...(await verifyIndex({ identifier: id, chain: d.chain, txIndex: d.txIndex, deployment: d.deployment, network: d.network })) })),
  );

  server.registerTool(
    "get_account",
    {
      title: "Account holdings",
      description:
        "A NEAR account on Tredio: USDC in the wallet and on the book, open attention perp positions (with equity, PnL and liquidation index), curation fees to claim, its trading sessions when it is a Tredio passkey account (scope, expiry, daily USDC limit and spend), and from the indexer its outcome token holdings, open book orders and trading summary.",
      inputSchema: { account: account.describe("NEAR account id, for example 0u... or alice.testnet") },
      annotations: READ_ONLY,
    },
    run(async ({ account: a }: { account: string }) => {
      const optional = <T>(p: Promise<T>) => p.catch(() => null);
      const [wallet, book, claimable, positions, sessions, summary, holdings, orders] = await Promise.all([
        view<string>(c.usdc, "ft_balance_of", { account_id: a }),
        optional(view<string>(c.book, "balance_of", { account_id: a, asset: "usdc" })),
        optional(view<string>(c.curation, "claimable_of", { account_id: a })),
        view<Position[]>(c.perps, "positions_of", { account_id: a }),
        // Only Tredio's account contract has sessions; any other account answers no such method.
        optional(view<Array<[string, Session]>>(a, "sessions")),
        optional(d.api.get<{ account: unknown }>(`/v1/accounts/${a}?optional=1`)),
        optional(d.api.get<{ holdings: unknown[] }>(`/v1/accounts/${a}/outcomes`)),
        optional(d.api.get<{ orders: unknown[] }>(`/v1/accounts/${a}/orders`)),
      ]);
      const states = await Promise.all(positions.slice(0, 16).map((p) => optional(view<PositionState>(c.perps, "position_state", { id: p.id }))));
      return {
        account: a,
        tredioAccount: sessions !== null,
        usdc: { wallet: usdc(wallet), book: book === null ? null : usdc(book) },
        curationClaimableUsdc: claimable === null ? null : usdc(claimable),
        perpPositions: positions.map((p, i) => {
          const s = states[i];
          return {
            id: p.id,
            trend: p.trend,
            side: p.is_long ? "long" : "short",
            contracts: Number(fromRaw(BigInt(p.qty), COIN_DECIMALS, 9)),
            entryIndex: indexPoints(p.entry_index),
            marginUsdc: usdc(p.margin),
            openedAt: p.opened_at,
            ...(s ? { equityUsdc: Number(s.equity) / 1e6, pnlUsdc: Number(s.pnl) / 1e6, fundingUsdc: Number(s.funding) / 1e6, liquidationIndex: indexPoints(s.liquidation_index), liquidatable: s.liquidatable } : {}),
          };
        }),
        sessions:
          sessions?.map(([publicKey, s]) => ({
            publicKey,
            label: s.label,
            scope: s.scope,
            expiresAt: s.expires_at,
            dailyLimitUsdc: usdc(s.daily_limit),
            spentTodayUsdc: s.day === Math.floor(Date.now() / 86_400_000) ? usdc(s.spent) : "0",
            gasKey: s.gas_key,
          })) ?? null,
        indexer: { summary: summary?.account ?? null, outcomeHoldings: holdings?.holdings ?? null, openOrders: orders?.orders ?? null },
      };
    }),
  );

  server.registerTool(
    "get_leaders",
    {
      title: "Leaderboards",
      description: "Leaderboards: \"traders\" (Tredio accounts by realized PnL, volume and win rate, from the indexer), \"callers\" (public calls by hit rate), or \"hyperliquid\" (Hyperliquid mainnet's monthly leaders, whom accounts can copy-trade).",
      inputSchema: { board: z.enum(["traders", "callers", "hyperliquid"]).default("traders") },
      annotations: READ_ONLY,
    },
    run(async ({ board }: { board: "traders" | "callers" | "hyperliquid" }) => {
      const path = { traders: "/v1/leaderboard/traders", callers: "/v1/callers/leaderboard", hyperliquid: "/v1/hyperliquid/leaders" }[board];
      return { board, ...(await d.api.get<Record<string, unknown>>(path)) };
    }),
  );

  server.registerTool(
    "list_candidates",
    {
      title: "Radar candidates",
      description: "Topics the radar found and a reviewer approved, waiting for a live slot: their queue position, the attention measured so far per source, and how many accounts wait on each. The oracle lists them in queue order as slots free up.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    run(async () => {
      const r = await d.api.get<{ slots: unknown; candidates: Array<Record<string, unknown>> }>("/v1/candidates");
      return {
        slots: r.slots,
        candidates: r.candidates.map((x) => ({ identifier: x.identifier, name: x.displayName, summary: x.summary, assetClass: x.assetClass, source: x.source, queue: x.queue, watchers: x.watchers, pick: x.pick, readings: x.readings })),
      };
    }),
  );

  server.registerTool(
    "get_paid_api",
    {
      title: "Paid API (x402)",
      description: "Tredio's pay-per-call x402 resources: each path, what it returns and its price in USDC, the token, the payee and the relayer that pays the gas. Payment uses x402 v2's NEAR exact scheme: sign a delegate action for one ft_transfer and send it in the PAYMENT-SIGNATURE header.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    run(async () => ({ api: d.api.baseUrl, ...(await d.api.get<Record<string, unknown>>("/v1/x402")) })),
  );

  const x402 = d.x402;
  if (x402) {
    server.registerTool(
      "buy_trend_history",
      {
        title: "Buy full index history (x402)",
        description: `Pays Tredio's x402 price (at most ${usdc(x402.maxAmount)} USDC, from ${x402.signer.accountId}) for a trend's full-resolution history: every oracle checkpoint since listing and every per-source reading behind it, with metric and window. Spends USDC on each call.`,
        inputSchema: {
          identifier: identifier.describe("trend identifier"),
          from: z.number().int().min(0).optional().describe("unix seconds"),
          to: z.number().int().min(0).optional().describe("unix seconds"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      run(async ({ identifier: id, from, to }: { identifier: string; from?: number; to?: number }) => {
        const q = new URLSearchParams();
        if (from !== undefined) q.set("from", String(from));
        if (to !== undefined) q.set("to", String(to));
        const url = `${d.api.baseUrl}/v1/x402/trends/${encodeURIComponent(id)}/history${q.size ? `?${q}` : ""}`;
        const paid = await x402Fetch(url, undefined, { signer: x402.signer, rpc: x402.rpc, network: d.network, limits: { maxAmount: x402.maxAmount, assets: [c.usdc] }, fetchImpl: d.fetchImpl });
        const body = (await paid.response.json().catch(() => null)) as Record<string, unknown> | null;
        if (paid.response.status !== 200) throw new Error(`the paid request answered ${paid.response.status}: ${JSON.stringify(paid.settlement ?? body)}`);
        return { payment: paid.settlement, ...(body ?? {}) };
      }),
    );
  }

  return server;
}
