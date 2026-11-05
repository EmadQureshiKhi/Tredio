import type { Rule, Side } from "./rules";
import { changePct, type Point, valueAt } from "./series";

/**
 * The decision engine. Pure: given a rule, its state and what the market shows now, it says
 * whether to open, close or wait, and why. Live trading and the backtester both call it, so a
 * backtest reproduces live behavior.
 */

export interface OpenPosition {
  side: Side;
  entryPrice: number;
  /** Size in the market's unit (for example BTC). */
  size: number;
  marginUsdc: number;
  leverage: number;
  /** Unix seconds. */
  openedAt: number;
}

export interface RuleState {
  position: OpenPosition | null;
  /** Realized PnL in USDC during the UTC day of `now`. */
  realizedTodayUsdc: number;
  /** Unix seconds of the last close, or null. */
  lastExitAt: number | null;
  /** Global kill switch or the owner's pause: close and open nothing. */
  killed: boolean;
}

export interface Inputs {
  /** Unix seconds. */
  now: number;
  /** Mark price of the asset perp market. */
  price: number;
  /** The trend's attention index observations (points), sorted by time. */
  attention: readonly Point[];
  /** Latest Nansen smart-money net flow (USD, 24 h), or null when unknown. */
  netflowUsd: number | null;
}

export type CloseReason = "stop" | "take_profit" | "max_hold" | "kill";

export type Decision =
  | {
      action: "open";
      side: Side;
      marginUsdc: number;
      leverage: number;
      notionalUsdc: number;
      /** Size in the market's unit at `price`. */
      size: number;
      reason: string;
      signal: { attentionChangePct: number; index: number; netflowUsd: number | null };
    }
  | { action: "close"; reason: CloseReason; movePct: number }
  | { action: "hold"; reason: string; movePct: number }
  | { action: "wait"; reason: string };

/** Price move in the position's favor, in percent of the entry price. */
export function favorableMovePct(side: Side, entry: number, price: number): number {
  const move = ((price - entry) / entry) * 100;
  return side === "long" ? move : -move;
}

const fmt = (n: number) => (Math.abs(n) >= 10 ? n.toFixed(0) : n.toFixed(1));

export function evaluate(rule: Rule, state: RuleState, m: Inputs): Decision {
  const p = state.position;
  if (p) {
    const movePct = favorableMovePct(p.side, p.entryPrice, m.price);
    if (state.killed) return { action: "close", reason: "kill", movePct };
    if (movePct <= -rule.exits.stopLossPct) return { action: "close", reason: "stop", movePct };
    if (movePct >= rule.exits.takeProfitPct) return { action: "close", reason: "take_profit", movePct };
    if (rule.exits.maxHoldMin > 0 && m.now - p.openedAt >= rule.exits.maxHoldMin * 60) return { action: "close", reason: "max_hold", movePct };
    return { action: "hold", reason: `price ${movePct >= 0 ? "+" : ""}${fmt(movePct)}% from entry`, movePct };
  }

  if (state.killed) return { action: "wait", reason: "paused" };
  if (state.realizedTodayUsdc <= -rule.limits.maxDailyLossUsdc) return { action: "wait", reason: "daily loss limit reached" };
  if (state.lastExitAt !== null && m.now - state.lastExitAt < rule.limits.cooldownMin * 60) return { action: "wait", reason: "cooling down after the last trade" };

  const change = changePct(m.attention, m.now, rule.entry.windowMin * 60);
  const index = valueAt(m.attention, m.now);
  if (change === null || index === null) return { action: "wait", reason: "not enough attention history yet" };
  if (index < rule.entry.minIndex) return { action: "wait", reason: `index ${fmt(index)} is below ${rule.entry.minIndex}` };
  const target = rule.entry.attentionChangePct;
  const fired = target > 0 ? change >= target : change <= target;
  if (!fired) return { action: "wait", reason: `attention ${change >= 0 ? "+" : ""}${fmt(change)}% vs ${target > 0 ? "+" : ""}${target}% needed` };
  if (rule.entry.smartMoney !== "any") {
    if (m.netflowUsd === null) return { action: "wait", reason: "no smart-money reading" };
    const agrees = rule.entry.smartMoney === "buying" ? m.netflowUsd > 0 : m.netflowUsd < 0;
    if (!agrees) return { action: "wait", reason: `smart money is not ${rule.entry.smartMoney}` };
  }
  if (!(m.price > 0)) return { action: "wait", reason: "no price" };

  const notionalUsdc = Math.min(rule.size.marginUsdc * rule.size.leverage, rule.limits.maxPositionUsdc);
  return {
    action: "open",
    side: rule.entry.side,
    marginUsdc: notionalUsdc / rule.size.leverage,
    leverage: rule.size.leverage,
    notionalUsdc,
    size: notionalUsdc / m.price,
    reason: `attention ${change >= 0 ? "+" : ""}${fmt(change)}% in ${rule.entry.windowMin} min`,
    signal: { attentionChangePct: change, index, netflowUsd: m.netflowUsd },
  };
}

/** Realized PnL in USDC of closing `p` at `exitPrice`, before fees. */
export function grossPnlUsdc(p: Pick<OpenPosition, "side" | "entryPrice" | "size">, exitPrice: number): number {
  const diff = exitPrice - p.entryPrice;
  return (p.side === "long" ? diff : -diff) * p.size;
}
