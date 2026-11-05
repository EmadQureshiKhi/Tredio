"use client";
import Link from "next/link";
import { Badge, cn } from "@/components/ui";
import { StatTile } from "@/features/autopilot/shared/kit";
import { EquityChart } from "@/features/autopilot/shared/Performance";
import { closeReason } from "@/features/autopilot/shared/rule-text";
import type { RuleDetail, Stats } from "@/lib/api";
import { usdc, price } from "@/lib/format";
import { SectionCard } from "./parts";

interface ClosedRow {
  key: string;
  market: string;
  side: "long" | "short";
  entry: number | null;
  exit: number | null;
  pnl: number;
  closedAt: number;
  reason: string | null;
  rule: string;
}

const when = (sec: number) => new Date(sec * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const LIMIT = 12;

/** Closed Autopilot (and copy) trades: the public track record, the equity curve and the latest exits. */
export function AutopilotSection({ stats, equity, details }: { stats: Stats; equity: ReadonlyArray<{ t: number; v: number }>; details: RuleDetail[] }) {
  const rows: ClosedRow[] = details
    .flatMap((d) =>
      d.positions
        .filter((p) => p.status === "closed" && p.closed_at !== null)
        .map((p) => ({
          key: `${d.rule.id}-${p.id}`,
          market: p.market,
          side: p.side,
          entry: p.entry_price,
          exit: p.exit_price,
          pnl: p.pnl_usdc ?? 0,
          closedAt: Math.floor(new Date(p.closed_at!).getTime() / 1000),
          reason: p.close_reason,
          rule: d.rule.rule.name,
        })),
    )
    .sort((a, b) => b.closedAt - a.closedAt);
  const pnlTone = Math.abs(stats.pnlUsdc) < 0.005 ? undefined : stats.pnlUsdc > 0 ? "up" : "down";
  return (
    <SectionCard
      id="autopilot-title"
      testId="autopilot-section"
      title="Autopilot"
      count={stats.trades}
      subtitle={
        <>
          Trades your rules and copy trading closed, after fees.{" "}
          <Link href="/autopilot" className="text-text underline-offset-4 hover:underline">
            Manage Autopilot
          </Link>
        </>
      }
    >
      <div className="flex flex-col gap-4 border-t border-line px-4 py-4 sm:px-6">
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <StatTile label="PnL after fees" value={usdc(stats.pnlUsdc, { sign: true })} tone={pnlTone} hint={`${stats.returnOnMarginPct >= 0 ? "+" : ""}${stats.returnOnMarginPct.toFixed(1)}% on margin`} />
          <StatTile label="Win rate" value={`${Math.round(stats.winRate * 100)}%`} hint={`${stats.wins} of ${stats.trades}`} />
          <StatTile label="Best and worst" value={`${usdc(stats.bestUsdc, { sign: true })}`} hint={`worst ${usdc(stats.worstUsdc, { sign: true })}`} />
          <StatTile label="Max drawdown" value={usdc(-stats.maxDrawdownUsdc)} tone={stats.maxDrawdownUsdc > 0 ? "down" : undefined} hint="USDC, peak to trough" />
        </div>
        <EquityChart equity={equity} height={180} />
        {rows.length > 0 ? (
          <ul className="divide-y divide-line rounded-2xl border border-line" data-testid="autopilot-trades">
            {rows.slice(0, LIMIT).map((t) => (
              <li key={t.key} className="flex items-center gap-3 px-3.5 py-2.5">
                <Badge tone={t.side === "long" ? "up" : "down"} className="w-[52px] justify-center">
                  {t.side === "long" ? "Long" : "Short"}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="num truncate text-[13px] text-text">
                    <span className="font-strong">{t.market}</span> <span className="text-text-3">·</span> {t.entry === null ? "-" : price(t.entry)} <span className="text-text-3">to</span> {t.exit === null ? "-" : price(t.exit)}
                  </p>
                  <p className="truncate text-[11.5px] text-text-3">
                    {when(t.closedAt)} · {closeReason(t.reason)} · {t.rule}
                  </p>
                </div>
                <span className={cn("num shrink-0 font-strong text-[13.5px]", t.pnl > 0.005 ? "text-up" : t.pnl < -0.005 ? "text-down" : "text-text-2")}>{usdc(t.pnl, { sign: true })}</span>
              </li>
            ))}
            {rows.length > LIMIT ? <li className="px-3.5 py-2.5 text-center text-[12px] text-text-3">{rows.length - LIMIT} earlier trades on the Autopilot page</li> : null}
          </ul>
        ) : null}
      </div>
    </SectionCard>
  );
}
