import type { Sql } from "./db";

/**
 * Reads Tredio's indexer (apps/indexer, its own Postgres schema): track records, the trader
 * leaderboard, an account's trade history across products, each series' average-cost book, and
 * per-trend volume, open interest and holders. Live balances come from the chain; this is the
 * history.
 */

const USDC = 1e6;
const POINTS = 1e6;
const WAD = 1e18;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const usdc = (raw: unknown) => num(raw) / USDC;
const points = (raw: unknown) => (raw === null || raw === undefined ? null : Number(raw) / POINTS);
const secs = (d: Date | string | null | undefined) => (d ? Math.floor(new Date(d).getTime() / 1000) : null);

export interface AccountSummary {
  account: string;
  isPasskey: boolean;
  createdAt: number | null;
  firstSeenAt: number;
  lastActiveAt: number | null;
  outcomeHoldingCount: number;
  coinHoldingCount: number;
  perpOpenPositionCount: number;
  openOrderCount: number;
  /** USDC credited to the account as a surfacer and not yet claimed. */
  curationClaimableUsdc: number;
  stats: {
    volumeUsdc: number;
    realizedPnlUsdc: number;
    perProduct: { outcome: number; perp: number; coin: number };
    feesPaidUsdc: number;
    tradeCount: number;
    closedTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    bestTradeUsdc: number | null;
    worstTradeUsdc: number | null;
    liquidations: number;
  };
}

export interface Activity {
  kind: "perp" | "coin" | "outcome";
  identifier: string | null;
  label: string;
  side: string;
  status: string;
  amountUsdc: number | null;
  pnlUsdc: number | null;
  /** Attention perps only: entry and exit index points. */
  entry: number | null;
  exit: number | null;
  at: number;
  receipt: string | null;
}

/** A series the account holds UP or DOWN of, with the indexer's average-cost book of each side (raw, 6 decimals). */
export interface OutcomeHoldingRow {
  series: number;
  trend: string;
  window: number;
  openedAt: number;
  expiry: number;
  /** Points. */
  openingIndex: number;
  outcome: "open" | "up" | "down" | "void";
  settlementIndex: number | null;
  upBalance: string;
  downBalance: string;
  upPosition: string;
  downPosition: string;
  upCostBasis: string;
  downCostBasis: string;
  upRealizedPnl: string;
  downRealizedPnl: string;
  /** Block time (seconds) of the last flow applied to each side. */
  upUpdatedAt: number;
  downUpdatedAt: number;
}

export interface TraderRow {
  account: string;
  realizedPnlUsdc: number;
  volumeUsdc: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
}

export interface TrendStats {
  volumeUsdc: number;
  volume24hUsdc: number;
  tradeCount: number;
  traderCount: number;
  holderCount: number;
  perpLongOpenInterestUsdc: number;
  perpShortOpenInterestUsdc: number;
  perpOpenPositionCount: number;
  curationEarnedUsdc: number;
  coin: { stage: string; spotUsdc: number; reserveUsdc: number; graduatedAt: number | null } | null;
}

export interface IndexerProgress {
  progressBlock: number;
  /** The processed block's time (ms). */
  progressBlockAt: number | null;
  eventsProcessed: number;
}

export interface IndexedOracle {
  lastRun: { runId: number; created: number; updated: number; marks: number; rejected: number; at: number } | null;
  /** Unix seconds of the newest series settlement. */
  lastSettlementAt: number | null;
  settlements24h: number;
}

interface Flow {
  side: "up" | "down" | "set";
  tokens: string;
  usdc: string;
  at: Date;
}

/**
 * The average-cost book of one side from its flows, oldest first: buys add their USDC to the
 * cost, sells take out the cost of what they sold at the average and realize the difference. A
 * complete set splits its USDC evenly between its UP and DOWN.
 */
export function averageCost(flows: readonly Flow[], side: "up" | "down"): { position: bigint; cost: bigint; realized: bigint; updatedAt: number } {
  let position = 0n;
  let cost = 0n;
  let realized = 0n;
  let updatedAt = 0;
  for (const f of flows) {
    if (f.side !== side && f.side !== "set") continue;
    const tokens = BigInt(f.tokens);
    // A set's USDC covers both sides.
    const value = f.side === "set" ? BigInt(f.usdc) / 2n : BigInt(f.usdc);
    if (tokens > 0n) {
      position += tokens;
      cost += -value;
    } else if (tokens < 0n) {
      const sold = -tokens > position ? position : -tokens;
      const removed = position > 0n ? (cost * sold) / position : 0n;
      position -= sold;
      cost -= removed;
      realized += value - removed;
    } else realized += value;
    updatedAt = Math.max(updatedAt, Math.floor(f.at.getTime() / 1000));
  }
  return { position, cost, realized, updatedAt };
}

export class IndexerReader {
  constructor(
    private readonly sql: Sql,
    private readonly schema = "indexer",
  ) {}

  private t(name: string) {
    return this.sql(`${this.schema}.${name}`);
  }

  async progress(network: string): Promise<IndexerProgress | null> {
    const [row] = await this.sql<{ height: string; block_time: Date | null }[]>`SELECT height, block_time FROM ${this.t("cursor")} WHERE id = ${network}`;
    if (!row) return null;
    const [n] = await this.sql<{ n: string }[]>`SELECT count(*) AS n FROM ${this.t("events")}`;
    return { progressBlock: Number(row.height), progressBlockAt: row.block_time ? row.block_time.getTime() : null, eventsProcessed: num(n?.n) };
  }

  async oracle(nowSec = Math.floor(Date.now() / 1000)): Promise<IndexedOracle> {
    const [run] = await this.sql<{ run_id: string; created: number; updated: number; marks: number; rejected: number; observed_at: Date }[]>`
      SELECT run_id, created, updated, marks, rejected, observed_at FROM ${this.t("oracle_runs")} ORDER BY run_id DESC LIMIT 1`;
    const [s] = await this.sql<{ last: Date | null; n: number }[]>`
      SELECT max(settled_at) AS last, count(*) FILTER (WHERE settled_at > to_timestamp(${nowSec - 86_400}))::int AS n FROM ${this.t("series")} WHERE settled_at IS NOT NULL`;
    return {
      lastRun: run ? { runId: Number(run.run_id), created: run.created, updated: run.updated, marks: run.marks, rejected: run.rejected, at: secs(run.observed_at)! } : null,
      lastSettlementAt: secs(s?.last ?? null),
      settlements24h: s?.n ?? 0,
    };
  }

  async account(account: string): Promise<AccountSummary | null> {
    const [a] = await this.sql<{ account: string; created_at: Date | null; first_seen: Date; owner_key: string | null }[]>`
      SELECT account, created_at, first_seen, owner_key FROM ${this.t("accounts")} WHERE account = ${account}`;
    const [counts] = await this.sql<{ outcomes: number; coins: number; perps: number; orders: number; liquidations: number; earned: string | null; claimed: string | null; last: Date | null }[]>`
      SELECT
        (SELECT count(DISTINCT series)::int FROM ${this.t("outcome_balances")} WHERE account = ${account}) AS outcomes,
        (SELECT count(*)::int FROM ${this.t("coin_balances")} WHERE account = ${account}) AS coins,
        (SELECT count(*)::int FROM ${this.t("perp_positions")} WHERE owner = ${account} AND status = 'open') AS perps,
        (SELECT count(*)::int FROM ${this.t("book_orders")} WHERE owner = ${account} AND status = 'open') AS orders,
        (SELECT count(*)::int FROM ${this.t("perp_positions")} WHERE owner = ${account} AND status = 'liquidated') AS liquidations,
        (SELECT sum(amount) FROM ${this.t("curation")} WHERE surfacer = ${account}) AS earned,
        (SELECT sum(amount) FROM ${this.t("curation_claims")} WHERE account = ${account}) AS claimed,
        (SELECT max(block_time) FROM ${this.t("events")} WHERE executor = ${account} OR data->>'owner' = ${account} OR data->>'trader' = ${account} OR data->>'account' = ${account}) AS last`;
    const trades = await this.closedTrades(account);
    if (!a && trades.length === 0 && (counts?.outcomes ?? 0) === 0 && (counts?.perps ?? 0) === 0) return null;
    const [vol] = await this.sql<{ outcome: string | null; perp: string | null; coin: string | null; fees: string | null; n: number }[]>`
      SELECT
        (SELECT sum(abs(usdc)) FROM ${this.t("outcome_flows")} WHERE account = ${account} AND kind IN ('swap', 'fill')) AS outcome,
        (SELECT sum(margin) FROM ${this.t("perp_positions")} WHERE owner = ${account}) AS perp,
        (SELECT sum(usdc) FROM ${this.t("coin_trades")} WHERE trader = ${account}) AS coin,
        (SELECT coalesce(sum(fee_open), 0) + coalesce(sum(fee_close), 0) FROM ${this.t("perp_positions")} WHERE owner = ${account}) AS fees,
        ((SELECT count(*) FROM ${this.t("outcome_flows")} WHERE account = ${account} AND kind IN ('swap', 'fill')) +
         (SELECT count(*) FROM ${this.t("perp_positions")} WHERE owner = ${account}) +
         (SELECT count(*) FROM ${this.t("coin_trades")} WHERE trader = ${account}))::int AS n`;
    const pnl = trades.map((t) => t.pnl);
    const wins = pnl.filter((p) => p > 0).length;
    const losses = pnl.filter((p) => p < 0).length;
    const per = { outcome: 0, perp: 0, coin: 0 };
    for (const t of trades) per[t.kind] += t.pnl;
    return {
      account,
      isPasskey: Boolean(a?.owner_key),
      createdAt: secs(a?.created_at ?? null),
      firstSeenAt: secs(a?.first_seen ?? null) ?? 0,
      lastActiveAt: secs(counts?.last ?? null),
      outcomeHoldingCount: counts?.outcomes ?? 0,
      coinHoldingCount: counts?.coins ?? 0,
      perpOpenPositionCount: counts?.perps ?? 0,
      openOrderCount: counts?.orders ?? 0,
      curationClaimableUsdc: Math.max(0, usdc(counts?.earned) - usdc(counts?.claimed)),
      stats: {
        volumeUsdc: usdc(vol?.outcome) + usdc(vol?.perp) + usdc(vol?.coin),
        realizedPnlUsdc: pnl.reduce((x, y) => x + y, 0),
        perProduct: per,
        feesPaidUsdc: usdc(vol?.fees),
        tradeCount: vol?.n ?? 0,
        closedTrades: trades.length,
        wins,
        losses,
        winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
        bestTradeUsdc: pnl.length > 0 ? Math.max(...pnl) : null,
        worstTradeUsdc: pnl.length > 0 ? Math.min(...pnl) : null,
        liquidations: counts?.liquidations ?? 0,
      },
    };
  }

  /** Closed trades with realized PnL (USDC): perps closed, liquidated or settled, and outcome series settled. */
  private async closedTrades(account: string): Promise<Array<{ kind: "perp" | "outcome" | "coin"; pnl: number }>> {
    const perps = await this.sql<{ margin: string; payout: string | null; fee_open: string }[]>`
      SELECT margin, payout, fee_open FROM ${this.t("perp_positions")} WHERE owner = ${account} AND status <> 'open'`;
    const outcomes = await this.sql<{ net: string }[]>`
      SELECT sum(f.usdc) AS net FROM ${this.t("outcome_flows")} f JOIN ${this.t("series")} s ON s.id = f.series
       WHERE f.account = ${account} AND s.outcome <> 'open' GROUP BY f.series`;
    return [
      ...perps.map((p) => ({ kind: "perp" as const, pnl: usdc(p.payout) - usdc(p.margin) - usdc(p.fee_open) })),
      ...outcomes.map((o) => ({ kind: "outcome" as const, pnl: usdc(o.net) })),
    ];
  }

  async activity(account: string, limit: number): Promise<Activity[]> {
    const [perps, coins, flows] = await Promise.all([
      this.sql<{ id: string; trend: string; is_long: boolean; status: string; margin: string; payout: string | null; fee_open: string; entry_index: string; exit_index: string | null; opened_at: Date; closed_at: Date | null; close_receipt: string | null }[]>`
        SELECT id, trend, is_long, status, margin, payout, fee_open, entry_index, exit_index, opened_at, closed_at, close_receipt
          FROM ${this.t("perp_positions")} WHERE owner = ${account} ORDER BY opened_at DESC LIMIT ${limit}`,
      this.sql<{ trend: string; is_buy: boolean; usdc: string; coins: string; at: Date; receipt_id: string }[]>`
        SELECT trend, is_buy, usdc, coins, at, receipt_id FROM ${this.t("coin_trades")} WHERE trader = ${account} ORDER BY block_height DESC LIMIT ${limit}`,
      this.sql<{ series: string; trend: string; side: string; kind: string; tokens: string; usdc: string; at: Date; receipt_id: string; outcome: string }[]>`
        SELECT f.series, s.trend, f.side, f.kind, f.tokens, f.usdc, f.at, f.receipt_id, s.outcome
          FROM ${this.t("outcome_flows")} f JOIN ${this.t("series")} s ON s.id = f.series
         WHERE f.account = ${account} ORDER BY f.block_height DESC, f.log_index DESC LIMIT ${limit}`,
    ]);
    const out: Activity[] = [
      ...perps.map((p): Activity => ({
        kind: "perp",
        identifier: p.trend,
        label: `${p.is_long ? "Long" : "Short"} attention perp`,
        side: p.is_long ? "long" : "short",
        status: p.status,
        amountUsdc: usdc(p.margin),
        pnlUsdc: p.status === "open" ? null : usdc(p.payout) - usdc(p.margin) - usdc(p.fee_open),
        entry: points(p.entry_index),
        exit: points(p.exit_index),
        at: secs(p.closed_at ?? p.opened_at)!,
        receipt: p.close_receipt,
      })),
      ...coins.map((t): Activity => ({
        kind: "coin",
        identifier: t.trend,
        label: `${t.is_buy ? "Bought" : "Sold"} ${(num(t.coins) / WAD).toLocaleString("en-US", { maximumFractionDigits: 2 })} coins`,
        side: t.is_buy ? "buy" : "sell",
        status: "filled",
        amountUsdc: usdc(t.usdc),
        pnlUsdc: null,
        entry: null,
        exit: null,
        at: secs(t.at)!,
        receipt: t.receipt_id,
      })),
      ...flows.map((f): Activity => {
        const tokens = num(f.tokens) / USDC;
        const labels: Record<string, string> = {
          mint: "Minted complete sets",
          redeem: "Redeemed complete sets",
          winnings: "Redeemed winnings",
          payout_failed: "Payout returned",
          swap: tokens > 0 ? `Bought ${f.side.toUpperCase()}` : `Sold ${f.side.toUpperCase()}`,
          fill: tokens > 0 ? `Limit buy filled, ${f.side.toUpperCase()}` : `Limit sell filled, ${f.side.toUpperCase()}`,
        };
        return {
          kind: "outcome",
          identifier: f.trend,
          label: labels[f.kind] ?? f.kind,
          side: f.side,
          status: f.outcome === "open" ? "open" : "settled",
          amountUsdc: Math.abs(usdc(f.usdc)),
          pnlUsdc: null,
          entry: null,
          exit: null,
          at: secs(f.at)!,
          receipt: f.receipt_id,
        };
      }),
    ];
    return out.sort((a, b) => b.at - a.at).slice(0, limit);
  }

  async outcomeHoldings(account: string): Promise<OutcomeHoldingRow[]> {
    const series = await this.sql<{ id: string; trend: string; window_sec: number; opened_at: Date; expiry: Date; opening_index: string; outcome: OutcomeHoldingRow["outcome"]; settlement_index: string | null }[]>`
      SELECT s.id, s.trend, s.window_sec, s.opened_at, s.expiry, s.opening_index, s.outcome, s.settlement_index FROM ${this.t("series")} s
       WHERE s.id IN (SELECT series FROM ${this.t("outcome_balances")} WHERE account = ${account} UNION SELECT series FROM ${this.t("outcome_flows")} WHERE account = ${account})
       ORDER BY s.expiry DESC LIMIT 200`;
    if (series.length === 0) return [];
    const ids = series.map((s) => s.id);
    const [balances, flows] = await Promise.all([
      this.sql<{ series: string; side: "up" | "down"; balance: string }[]>`SELECT series, side, balance FROM ${this.t("outcome_balances")} WHERE account = ${account} AND series = ANY(${this.sql.array(ids)}::bigint[])`,
      this.sql<(Flow & { series: string })[]>`
        SELECT series, side, tokens, usdc, at FROM ${this.t("outcome_flows")} WHERE account = ${account} AND series = ANY(${this.sql.array(ids)}::bigint[]) ORDER BY block_height, log_index, leg`,
    ]);
    return series.map((s) => {
      const bal = (side: string) => balances.find((b) => b.series === s.id && b.side === side)?.balance ?? "0";
      const mine = flows.filter((f) => f.series === s.id);
      const up = averageCost(mine, "up");
      const down = averageCost(mine, "down");
      return {
        series: Number(s.id),
        trend: s.trend,
        window: s.window_sec,
        openedAt: secs(s.opened_at)!,
        expiry: secs(s.expiry)!,
        openingIndex: points(s.opening_index)!,
        outcome: s.outcome,
        settlementIndex: points(s.settlement_index),
        upBalance: bal("up"),
        downBalance: bal("down"),
        upPosition: up.position.toString(),
        downPosition: down.position.toString(),
        upCostBasis: up.cost.toString(),
        downCostBasis: down.cost.toString(),
        upRealizedPnl: up.realized.toString(),
        downRealizedPnl: down.realized.toString(),
        upUpdatedAt: up.updatedAt,
        downUpdatedAt: down.updatedAt,
      };
    });
  }

  /** Accounts by realized PnL (perps closed and outcome series settled). */
  async traders(limit: number): Promise<TraderRow[]> {
    const rows = await this.sql<{ account: string; pnl: string; volume: string; closed: number; wins: number; losses: number }[]>`
      WITH trades AS (
        SELECT owner AS account, coalesce(payout, 0) - margin - fee_open AS pnl, margin AS volume FROM ${this.t("perp_positions")} WHERE status <> 'open'
        UNION ALL
        SELECT f.account, sum(f.usdc), sum(abs(f.usdc)) FILTER (WHERE f.kind IN ('swap', 'fill')) FROM ${this.t("outcome_flows")} f
          JOIN ${this.t("series")} s ON s.id = f.series WHERE s.outcome <> 'open' GROUP BY f.account, f.series
      )
      SELECT account, sum(pnl) AS pnl, coalesce(sum(volume), 0) AS volume, count(*)::int AS closed,
             count(*) FILTER (WHERE pnl > 0)::int AS wins, count(*) FILTER (WHERE pnl < 0)::int AS losses
        FROM trades GROUP BY account ORDER BY sum(pnl) DESC LIMIT ${limit}`;
    return rows.map((r) => ({
      account: r.account,
      realizedPnlUsdc: usdc(r.pnl),
      volumeUsdc: usdc(r.volume),
      closedTrades: r.closed,
      wins: r.wins,
      losses: r.losses,
      winRate: r.wins + r.losses > 0 ? r.wins / (r.wins + r.losses) : 0,
    }));
  }

  async trend(identifier: string, nowSec: number): Promise<TrendStats | null> {
    const since = nowSec - 86_400;
    const [r] = await this.sql<{
      book: string | null;
      book24: string | null;
      coin: string | null;
      coin24: string | null;
      perp: string | null;
      perp24: string | null;
      n: number;
      traders: number;
      holders: number;
      long_oi: string | null;
      short_oi: string | null;
      open_perps: number;
      curation: string | null;
    }[]>`
      WITH s AS (SELECT id FROM ${this.t("series")} WHERE trend = ${identifier})
      SELECT
        (SELECT sum(usdc) FROM ${this.t("book_trades")} WHERE series IN (SELECT id FROM s)) AS book,
        (SELECT sum(usdc) FROM ${this.t("book_trades")} WHERE series IN (SELECT id FROM s) AND at > to_timestamp(${since})) AS book24,
        (SELECT sum(usdc) FROM ${this.t("coin_trades")} WHERE trend = ${identifier}) AS coin,
        (SELECT sum(usdc) FROM ${this.t("coin_trades")} WHERE trend = ${identifier} AND at > to_timestamp(${since})) AS coin24,
        (SELECT sum(margin) FROM ${this.t("perp_positions")} WHERE trend = ${identifier}) AS perp,
        (SELECT sum(margin) FROM ${this.t("perp_positions")} WHERE trend = ${identifier} AND opened_at > to_timestamp(${since})) AS perp24,
        -- book_trades holds every fill, the ones swaps took included, so swaps are not added again.
        ((SELECT count(*) FROM ${this.t("book_trades")} WHERE series IN (SELECT id FROM s)) +
         (SELECT count(*) FROM ${this.t("coin_trades")} WHERE trend = ${identifier}) +
         (SELECT count(*) FROM ${this.t("perp_positions")} WHERE trend = ${identifier}))::int AS n,
        (SELECT count(DISTINCT a)::int FROM (
           SELECT taker AS a FROM ${this.t("book_trades")} WHERE series IN (SELECT id FROM s)
           UNION SELECT account FROM ${this.t("book_swaps")} WHERE series IN (SELECT id FROM s)
           UNION SELECT trader FROM ${this.t("coin_trades")} WHERE trend = ${identifier}
           UNION SELECT owner FROM ${this.t("perp_positions")} WHERE trend = ${identifier}) x) AS traders,
        (SELECT count(DISTINCT account)::int FROM ${this.t("outcome_balances")} WHERE series IN (SELECT id FROM s)) AS holders,
        (SELECT sum(qty * entry_index / 1e18) FROM ${this.t("perp_positions")} WHERE trend = ${identifier} AND status = 'open' AND is_long) AS long_oi,
        (SELECT sum(qty * entry_index / 1e18) FROM ${this.t("perp_positions")} WHERE trend = ${identifier} AND status = 'open' AND NOT is_long) AS short_oi,
        (SELECT count(*)::int FROM ${this.t("perp_positions")} WHERE trend = ${identifier} AND status = 'open') AS open_perps,
        (SELECT sum(amount) FROM ${this.t("curation")} WHERE trend = ${identifier}) AS curation`;
    if (!r || r.n === 0) return null;
    const [curve] = await this.sql<{ stage: string; spot: string; reserve: string; graduated_at: Date | null }[]>`
      SELECT stage, spot, reserve, graduated_at FROM ${this.t("curves")} WHERE trend = ${identifier}`;
    return {
      volumeUsdc: usdc(r.book) + usdc(r.coin) + usdc(r.perp),
      volume24hUsdc: usdc(r.book24) + usdc(r.coin24) + usdc(r.perp24),
      tradeCount: r.n,
      traderCount: r.traders,
      holderCount: r.holders,
      perpLongOpenInterestUsdc: usdc(r.long_oi),
      perpShortOpenInterestUsdc: usdc(r.short_oi),
      perpOpenPositionCount: r.open_perps,
      curationEarnedUsdc: usdc(r.curation),
      coin: curve ? { stage: curve.stage, spotUsdc: num(curve.spot) / WAD / USDC, reserveUsdc: usdc(curve.reserve), graduatedAt: secs(curve.graduated_at) } : null,
    };
  }
}
