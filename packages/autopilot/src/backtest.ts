import { evaluate, grossPnlUsdc, type OpenPosition, type RuleState } from "./engine";
import type { Rule } from "./rules";
import { type Point, valueAt } from "./series";
import { type ClosedTrade, equityCurve, type Stats, stats } from "./stats";

/**
 * Replays a rule over history: the trend's attention index (registry checkpoints), smart-money
 * readings and the asset perp market's candles. Decisions come from the live engine at each candle's
 * close; stops and take-profits also trigger inside a candle from its high and low (the stop first
 * when both were touched, the cautious assumption). Fills pay a taker fee and slippage.
 */

export interface Candle {
  /** Open time, unix seconds. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface BacktestInput {
  rule: Rule;
  candles: readonly Candle[];
  resolutionSec: number;
  attention: readonly Point[];
  netflow: readonly Point[];
  /** Taker fee per fill, basis points of notional. */
  feeBps: number;
  /** Price concession per fill, basis points. */
  slippageBps: number;
}

export interface BacktestResult {
  trades: ClosedTrade[];
  stats: Stats;
  equity: Point[];
  from: number;
  to: number;
  candles: number;
  /** Data gaps that limit what the result can say. */
  warnings: string[];
}

const utcDay = (t: number) => Math.floor(t / 86_400);

export function backtest(input: BacktestInput): BacktestResult {
  const { rule, candles, resolutionSec, attention, netflow } = input;
  const sorted = [...candles].sort((a, b) => a.t - b.t);
  const warnings: string[] = [];
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return { trades: [], stats: stats([]), equity: [], from: 0, to: 0, candles: 0, warnings: ["no price history for this market"] };
  const from = first.t;
  const to = last.t + resolutionSec;
  const attentionStart = attention[0]?.t;
  if (attentionStart === undefined) warnings.push("the trend has no attention history in this period");
  else if (attentionStart + rule.entry.windowMin * 60 > from) {
    warnings.push(`attention history starts ${new Date(attentionStart * 1000).toISOString()}; earlier candles cannot trigger`);
  }
  if (rule.entry.smartMoney !== "any" && netflow.length === 0) warnings.push("no smart-money history, so the rule never fires in the backtest");

  const fee = input.feeBps / 10_000;
  const slip = input.slippageBps / 10_000;
  const trades: ClosedTrade[] = [];
  let position: (OpenPosition & { entryFee: number }) | null = null;
  let lastExitAt: number | null = null;
  let day = -1;
  let realizedToday = 0;

  const exit = (at: number, rawPrice: number, reason: string) => {
    if (!position) return;
    const p = position;
    // Selling out of a long fills below the price; buying back a short fills above it.
    const price = p.side === "long" ? rawPrice * (1 - slip) : rawPrice * (1 + slip);
    const exitFee = price * p.size * fee;
    const pnl = grossPnlUsdc(p, price) - p.entryFee - exitFee;
    trades.push({
      side: p.side,
      openedAt: p.openedAt,
      closedAt: at,
      entryPrice: p.entryPrice,
      exitPrice: price,
      size: p.size,
      marginUsdc: p.marginUsdc,
      pnlUsdc: pnl,
      feesUsdc: p.entryFee + exitFee,
      reason,
    });
    if (utcDay(at) !== day) {
      day = utcDay(at);
      realizedToday = 0;
    }
    realizedToday += pnl;
    lastExitAt = at;
    position = null;
  };

  for (const c of sorted) {
    const close = c.t + resolutionSec;
    if (utcDay(close) !== day) {
      day = utcDay(close);
      realizedToday = 0;
    }
    if (position) {
      const p: OpenPosition = position;
      const stop = p.side === "long" ? p.entryPrice * (1 - rule.exits.stopLossPct / 100) : p.entryPrice * (1 + rule.exits.stopLossPct / 100);
      const target = p.side === "long" ? p.entryPrice * (1 + rule.exits.takeProfitPct / 100) : p.entryPrice * (1 - rule.exits.takeProfitPct / 100);
      const stopHit = p.side === "long" ? c.l <= stop : c.h >= stop;
      const targetHit = p.side === "long" ? c.h >= target : c.l <= target;
      if (stopHit) exit(close, stop, "stop");
      else if (targetHit) exit(close, target, "take_profit");
    }
    const state: RuleState = { position, realizedTodayUsdc: realizedToday, lastExitAt, killed: false };
    const d = evaluate(rule, state, { now: close, price: c.c, attention, netflowUsd: valueAt(netflow, close) });
    if (d.action === "close") exit(close, c.c, d.reason);
    else if (d.action === "open") {
      const price = d.side === "long" ? c.c * (1 + slip) : c.c * (1 - slip);
      const size = d.notionalUsdc / price;
      position = { side: d.side, entryPrice: price, size, marginUsdc: d.marginUsdc, leverage: d.leverage, openedAt: close, entryFee: price * size * fee };
    }
  }
  if (position) {
    exit(to, last.c, "end_of_data");
    warnings.push("a position was still open at the end and is closed at the last price");
  }
  return { trades, stats: stats(trades), equity: equityCurve(trades), from, to, candles: sorted.length, warnings };
}
