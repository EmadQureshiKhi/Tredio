"use client";
import { Bot, Check } from "lucide-react";
import type { ReactNode } from "react";
import { Avatar } from "@/components/shell/AppShell";
import { Badge, Button, cn, Skeleton, Sparkline } from "@/components/ui";
import type { DirectoryLeader } from "@/features/copy/leaders";
import { compact, shortAddress, usdc } from "@/lib/format";
import { BOT_ACCOUNT, usePerformance } from "./data";

/**
 * A trader worth following, with Follow. The Tredio bot shows its Autopilot record (PnL, win rate,
 * trades, followers, equity); a Hyperliquid leaderboard trader shows the leaderboard's month
 * (profit, return, account value) and how many Tredio accounts copy them.
 */
export function LeaderCard({
  address,
  leader,
  bot,
  name,
  subtitle,
  href,
  onFollow,
  following,
  className,
}: {
  /** The Hyperliquid address a copy follows. */
  address: string;
  leader?: DirectoryLeader | null;
  bot?: boolean;
  name?: string;
  subtitle?: ReactNode;
  href: string;
  onFollow?: () => void;
  following?: boolean;
  className?: string;
}) {
  const title = name ?? (bot ? "Tredio bot" : (leader?.displayName ?? shortAddress(address)));
  return (
    <article data-testid={bot ? "bot-card" : "leader-card"} className={cn("relative flex flex-col gap-4 overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-card", className)}>
      {bot ? <div aria-hidden className="pointer-events-none absolute -right-20 -top-20 size-56 rounded-full bg-primary-soft blur-3xl" /> : null}
      <div className="relative flex min-w-0 items-center gap-3">
        {bot ? (
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary">
            <Bot className="size-5" aria-hidden />
          </span>
        ) : (
          <Avatar address={address} size={40} />
        )}
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <a href={href} target="_blank" rel="noreferrer" className="truncate font-strong text-[15px] leading-6 text-text hover:underline hover:underline-offset-4">
              {title}
            </a>
            {bot ? <Badge tone="primary">Official</Badge> : null}
          </div>
          <p className="line-clamp-2 text-[12.5px] leading-[18px] text-text-2">{subtitle ?? (bot ? "Public Autopilot rules on Hyperliquid" : `${shortAddress(address)} · Hyperliquid mainnet`)}</p>
        </div>
      </div>
      {bot ? <BotRecord /> : <LeaderboardRecord leader={leader ?? null} />}
      {onFollow ? (
        <Button tone={following ? "secondary" : "primary"} block className="relative z-10 mt-auto" icon={following ? <Check className="size-4" aria-hidden /> : undefined} onClick={onFollow} data-testid={bot ? "follow-bot" : "follow-leader"}>
          {following ? "Following: edit caps" : bot ? "Follow the Tredio bot" : "Follow"}
        </Button>
      ) : null}
    </article>
  );
}

function BotRecord() {
  const perf = usePerformance(BOT_ACCOUNT);
  const s = perf.data?.stats;
  const equity = perf.data?.equity ?? [];
  return (
    <>
      <div className="relative flex items-end justify-between gap-3">
        <div>
          <p className="text-[11.5px] uppercase tracking-[0.08em] text-text-3">Realized PnL</p>
          {perf.isLoading ? (
            <Skeleton className="mt-1.5 h-8 w-28" />
          ) : (
            <p className={cn("num-display mt-1 font-display text-[30px] leading-none", !s || s.pnlUsdc === 0 ? "text-text" : s.pnlUsdc > 0 ? "text-up" : "text-down")}>
              {s ? usdc(s.pnlUsdc, { sign: true }) : "-"}
              <span className="ml-1 font-sans text-[13px] text-text-3">USDC</span>
            </p>
          )}
        </div>
        <Sparkline values={equity.length > 1 ? [0, ...equity.map((p) => p.v)] : []} width={104} height={38} />
      </div>
      <dl className="relative grid grid-cols-3 gap-2 border-t border-line pt-3 text-[12.5px]">
        <Fig label="Win rate" value={s && s.trades > 0 ? `${Math.round(s.winRate * 100)}%` : "-"} />
        <Fig label="Trades" value={s ? String(s.trades) : "-"} />
        <Fig label="Followers" value={perf.data ? String(perf.data.followers) : "-"} />
      </dl>
      {s && s.trades === 0 ? <p className="relative -mt-1 text-[12px] leading-4 text-text-3">No closed trades yet; the record starts with its first exit.</p> : null}
    </>
  );
}

function LeaderboardRecord({ leader }: { leader: DirectoryLeader | null }) {
  return (
    <>
      <div className="relative">
        <p className="text-[11.5px] uppercase tracking-[0.08em] text-text-3">30-day PnL</p>
        <p className={cn("num-display mt-1 font-display text-[30px] leading-none", !leader || leader.pnl === 0 ? "text-text" : leader.pnl > 0 ? "text-up" : "text-down")}>
          {leader ? `${leader.pnl >= 0 ? "+" : "-"}$${compact(Math.abs(leader.pnl))}` : "-"}
        </p>
      </div>
      <dl className="relative grid grid-cols-3 gap-2 border-t border-line pt-3 text-[12.5px]">
        <Fig label="Return" value={leader ? `${(leader.roi * 100).toFixed(1)}%` : "-"} />
        <Fig label="Account" value={leader ? `$${compact(leader.accountValue)}` : "-"} />
        <Fig label="Followers" value={leader ? String(leader.followers) : "-"} />
      </dl>
    </>
  );
}

function Fig({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-text-3">{label}</dt>
      <dd className="num mt-0.5 truncate font-strong text-[14px] text-text">{value}</dd>
    </div>
  );
}

export function LeaderCardSkeleton() {
  return (
    <div className="flex h-[248px] flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-5">
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-full" />
        <Skeleton className="h-5 w-32" />
      </div>
      <Skeleton className="h-8 w-28" />
      <Skeleton className="mt-auto h-10 w-full" />
    </div>
  );
}
