"use client";
import { LineChart } from "lucide-react";
import { useMemo } from "react";
import { Badge, cn, Num } from "@/components/ui";
import { Chart } from "@/components/ui/Chart";
import type { ClosedTrade, Stats } from "@/lib/api";
import { usdc, price } from "@/lib/format";
import { StatTile } from "./kit";
import { closeReason } from "./rule-text";

/** Performance figures, the equity curve and the trade list: shared by backtests and live rules. */

const pnlTone = (v: number) => (Math.abs(v) < 0.005 ? undefined : v > 0 ? "up" : "down");

const TWO = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
const SIGNED = { ...TWO, signDisplay: "exceptZero" } as const;

/**
 * The headline figures. `countUp` rolls each one up from zero as it appears (a fresh backtest);
 * otherwise they show as they are and roll only when they change.
 */
export function StatsGrid({ stats, className, testId, wide, countUp }: { stats: Stats; className?: string; testId?: string; wide?: boolean; countUp?: boolean }) {
  const none = stats.trades === 0;
  const from = countUp ? 0 : undefined;
  return (
    <div className={cn("grid grid-cols-2 gap-2.5", wide && "sm:grid-cols-4", className)} data-testid={testId}>
      <StatTile
        size="lg"
        className={cn("col-span-2", wide && "sm:col-span-4")}
        label="PnL after fees"
        value={
          <>
            <Num value={stats.pnlUsdc} format={SIGNED} from={from} flash={false} />
            <span className="ml-1.5 font-sans text-[14px] text-text-3">USDC</span>
          </>
        }
        tone={pnlTone(stats.pnlUsdc)}
        hint={none ? "No closed trades" : `${stats.returnOnMarginPct >= 0 ? "+" : ""}${stats.returnOnMarginPct.toFixed(1)}% on margin · fees ${usdc(stats.feesUsdc)}`}
      />
      <StatTile label="Win rate" value={none ? "-" : <Num value={Math.round(stats.winRate * 100)} format={{ maximumFractionDigits: 0 }} suffix="%" from={from} flash={false} />} hint={none ? undefined : `${stats.wins} of ${stats.trades}`} tone={none ? "muted" : undefined} />
      <StatTile label="Trades" value={<Num value={stats.trades} format={{ maximumFractionDigits: 0 }} from={from} flash={false} />} hint={none ? undefined : `avg ${usdc(stats.avgPnlUsdc, { sign: true })}`} />
      <StatTile label="Max drawdown" value={none ? "-" : <Num value={-stats.maxDrawdownUsdc} from={from} flash={false} />} tone={none ? "muted" : stats.maxDrawdownUsdc > 0 ? "down" : undefined} hint={none ? undefined : "peak to trough"} />
      <StatTile
        label="Profit factor"
        value={none ? "-" : stats.profitFactor === null ? "No losses" : <Num value={stats.profitFactor} from={from} flash={false} />}
        tone={none ? "muted" : undefined}
        hint={none ? undefined : "gains over losses"}
      />
    </div>
  );
}

/** Cumulative PnL from zero at `from` (unix seconds). `drawIn` reveals the curve left to right as it appears. */
export function EquityChart({ equity, from, height = 200, drawIn }: { equity: ReadonlyArray<{ t: number; v: number }>; from?: number; height?: number; drawIn?: boolean }) {
  const points = useMemo(() => {
    const start = from ?? (equity[0] ? equity[0].t - 1 : 0);
    return [{ t: start, v: 0 }, ...equity];
  }, [equity, from]);
  const fmt = useMemo(() => (v: number) => usdc(v, { sign: true }), []);
  const reference = useMemo(() => ({ value: 0, label: "" }), []);
  if (equity.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line-strong px-4 text-center" style={{ height: Math.min(height, 120) }}>
        <LineChart className="size-5 text-text-3" aria-hidden />
        <p className="text-[13px] text-text-2">The equity curve starts with the first closed trade.</p>
      </div>
    );
  }
  return (
    <div role="img" aria-label={`Equity curve: ${usdc(equity[equity.length - 1]!.v, { sign: true })} USDC after ${equity.length} trades`} className={drawIn ? "wipe-in" : undefined}>
      <Chart points={points} height={height} valueFormat={fmt} reference={reference} minRange={1} />
    </div>
  );
}

const when = (sec: number) => new Date(sec * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Closed trades, newest first, as compact rows that read on a phone. */
export function TradeList({ trades, limit = 40 }: { trades: readonly ClosedTrade[]; limit?: number }) {
  const rows = [...trades].sort((a, b) => b.closedAt - a.closedAt).slice(0, limit);
  return (
    <ul className="divide-y divide-line rounded-2xl border border-line" data-testid="trade-list">
      {rows.map((t, i) => (
        <li key={`${t.openedAt}-${i}`} className="flex items-center gap-3 px-3.5 py-2.5">
          <Badge tone={t.side === "long" ? "up" : "down"} className="w-[52px] justify-center">
            {t.side === "long" ? "Long" : "Short"}
          </Badge>
          <div className="min-w-0 flex-1">
            <p className="num truncate text-[13px] text-text">
              {price(t.entryPrice)} <span className="text-text-3">→</span> {price(t.exitPrice)}
            </p>
            <p className="truncate text-[11.5px] text-text-3">
              {when(t.openedAt)} · {closeReason(t.reason)}
            </p>
          </div>
          <span className={cn("num shrink-0 font-strong text-[13.5px]", t.pnlUsdc > 0 ? "text-up" : t.pnlUsdc < 0 ? "text-down" : "text-text-2")}>{usdc(t.pnlUsdc, { sign: true })}</span>
        </li>
      ))}
      {trades.length > limit ? <li className="px-3.5 py-2.5 text-center text-[12px] text-text-3">{trades.length - limit} earlier trades not shown</li> : null}
    </ul>
  );
}
