import type { Side } from "./rules";
import type { Point } from "./series";

/** Performance of closed trades: PnL, win rate and drawdown. */

export interface ClosedTrade {
  side: Side;
  /** Unix seconds. */
  openedAt: number;
  closedAt: number;
  entryPrice: number;
  exitPrice: number;
  size: number;
  marginUsdc: number;
  /** Net of fees. */
  pnlUsdc: number;
  feesUsdc: number;
  reason: string;
}

export interface Stats {
  trades: number;
  wins: number;
  losses: number;
  /** Wins over trades, 0 to 1 (0 with no trades). */
  winRate: number;
  pnlUsdc: number;
  feesUsdc: number;
  avgPnlUsdc: number;
  bestUsdc: number;
  worstUsdc: number;
  /** Largest peak-to-trough fall of cumulative PnL, in USDC (positive). */
  maxDrawdownUsdc: number;
  /** Gross profit over gross loss; null when nothing was lost. */
  profitFactor: number | null;
  /** Return on the margin committed across trades, in percent. */
  returnOnMarginPct: number;
}

export function stats(trades: readonly ClosedTrade[]): Stats {
  let pnl = 0;
  let fees = 0;
  let peak = 0;
  let maxDd = 0;
  let wins = 0;
  let gain = 0;
  let loss = 0;
  let best = 0;
  let worst = 0;
  let margin = 0;
  for (const t of [...trades].sort((a, b) => a.closedAt - b.closedAt)) {
    pnl += t.pnlUsdc;
    fees += t.feesUsdc;
    margin += t.marginUsdc;
    if (t.pnlUsdc > 0) {
      wins++;
      gain += t.pnlUsdc;
    } else {
      loss -= t.pnlUsdc;
    }
    best = Math.max(best, t.pnlUsdc);
    worst = Math.min(worst, t.pnlUsdc);
    peak = Math.max(peak, pnl);
    maxDd = Math.max(maxDd, peak - pnl);
  }
  const n = trades.length;
  return {
    trades: n,
    wins,
    losses: n - wins,
    winRate: n > 0 ? wins / n : 0,
    pnlUsdc: pnl,
    feesUsdc: fees,
    avgPnlUsdc: n > 0 ? pnl / n : 0,
    bestUsdc: best,
    worstUsdc: worst,
    maxDrawdownUsdc: maxDd,
    profitFactor: loss > 0 ? gain / loss : null,
    returnOnMarginPct: margin > 0 ? (pnl / margin) * 100 : 0,
  };
}

/** Cumulative PnL after each close, for an equity chart. */
export function equityCurve(trades: readonly ClosedTrade[]): Point[] {
  let pnl = 0;
  return [...trades]
    .sort((a, b) => a.closedAt - b.closedAt)
    .map((t) => {
      pnl += t.pnlUsdc;
      return { t: t.closedAt, v: pnl };
    });
}
