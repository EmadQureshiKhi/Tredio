"use client";
import { Bot, Check } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Avatar } from "@/components/shell/AppShell";
import { Badge, Button, cn, Skeleton, Sparkline } from "@/components/ui";
import { usdc, shortAddress } from "@/lib/format";
import { isBot, usePerformance } from "./data";

/**
 * A trader worth following: their Autopilot record (PnL, win rate, trades, followers) and an
 * equity line, with Follow. Used for the Tredio bot and for callers who linked an account.
 */
export function LeaderCard({
  account,
  name,
  subtitle,
  href,
  onFollow,
  following,
  className,
  featured,
}: {
  account: string;
  name?: string;
  subtitle?: ReactNode;
  href: string;
  onFollow?: () => void;
  following?: boolean;
  className?: string;
  featured?: boolean;
}) {
  const perf = usePerformance(account);
  const bot = isBot(account);
  const s = perf.data?.stats;
  const equity = perf.data?.equity ?? [];
  const title = name ?? (bot ? "Tredio bot" : shortAddress(account));
  return (
    <article
      data-testid={bot ? "bot-card" : "leader-card"}
      className={cn("relative flex flex-col gap-4 overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-card", className)}
    >
      {featured ? <div aria-hidden className="pointer-events-none absolute -right-20 -top-20 size-56 rounded-full bg-primary-soft blur-3xl" /> : null}
      <div className="relative flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {bot ? (
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary">
              <Bot className="size-5" aria-hidden />
            </span>
          ) : (
            <Avatar address={account} size={40} />
          )}
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <Link href={href} className="truncate font-strong text-[15px] leading-6 text-text hover:underline hover:underline-offset-4">
                {title}
              </Link>
              {bot ? <Badge tone="primary">Official</Badge> : null}
            </div>
            <p className="line-clamp-2 text-[12.5px] leading-[18px] text-text-2">{subtitle ?? (bot ? "Public Autopilot rules on asset perps" : shortAddress(account))}</p>
          </div>
        </div>
      </div>
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
      {onFollow ? (
        <Button
          tone={following ? "secondary" : "primary"}
          block
          className="relative z-10 mt-auto"
          icon={following ? <Check className="size-4" aria-hidden /> : undefined}
          onClick={onFollow}
          data-testid={bot ? "follow-bot" : "follow-leader"}
        >
          {following ? "Following: edit caps" : bot ? "Follow the Tredio bot" : "Follow"}
        </Button>
      ) : null}
    </article>
  );
}

function Fig({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-text-3">{label}</dt>
      <dd className="num mt-0.5 font-strong text-[14px] text-text">{value}</dd>
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
