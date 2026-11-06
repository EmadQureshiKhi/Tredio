"use client";
import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge, Button, ButtonLink, cn, ErrorNote, ReceiptLink, Skeleton } from "@/components/ui";
import { StatTile } from "@/features/autopilot/shared/kit";
import { type AccountHistory, type ActivityItem, history, type Trend } from "@/lib/api";
import { ago, usdc } from "@/lib/format";
import { baseIdentifier, trendName } from "@/lib/trends";
import { action, statusOf, useActivity } from "./activity";
import { portfolioKey } from "./keys";
import { SectionCard, signedUsdc } from "./parts";

/**
 * The account's track record and trade history from the indexer: what it made, how often it
 * won, and every perp, coin, outcome and Hyperliquid trade, newest first. The holdings above are
 * read live; this is the record of what already happened.
 */

const SHOWN = 10;
const KIND: Record<ActivityItem["kind"], string> = { perp: "Attention perp", coin: "Trend coin", outcome: "Up or down", assetPerp: "Hyperliquid" };

function useAccountHistory(address: string | undefined) {
  const key = portfolioKey(address);
  const account = useQuery({
    queryKey: [...key, "history", "account"],
    enabled: Boolean(address),
    refetchInterval: 30_000,
    retry: (n, e) => n < 1 && statusOf(e) !== 404 && statusOf(e) !== 503,
    queryFn: () => history.account(address!),
  });
  const activity = useActivity(address);
  return { account, activity };
}

export function TradeHistory({ address, trends }: { address: string; trends: readonly Trend[] }) {
  const { account, activity } = useAccountHistory(address);
  const [all, setAll] = useState(false);
  const names = useMemo(() => new Map(trends.map((t) => [t.identifier, trendName(t)])), [trends]);
  const stats = account.data?.account.stats ?? null;
  const items = activity.data?.items ?? [];
  const unavailable = statusOf(account.error) === 503 || statusOf(activity.error) === 503;
  const noRecord = statusOf(account.error) === 404 && items.length === 0;
  const failed = !unavailable && !noRecord && ((account.error && statusOf(account.error) !== 404 && !account.data) || (activity.error && !activity.data));
  const loading = (account.isLoading || activity.isLoading) && !account.data && !activity.data;

  return (
    <SectionCard id="history-title" testId="history-section" title="History" count={items.length > 0 ? items.length : undefined} subtitle="Your track record and every trade, from Tredio's indexer. New trades appear here within a minute.">
      <div className="flex flex-col gap-4 border-t border-line px-4 py-4 sm:px-6">
        {loading ? (
          <div className="flex flex-col gap-4" aria-hidden>
            <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-[76px] rounded-2xl" />
              ))}
            </div>
            <Skeleton className="h-[180px] rounded-2xl" />
          </div>
        ) : unavailable ? (
          <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] leading-5 text-text-2" data-testid="history-unavailable">
            Trade history is not available on this server right now. Your holdings above are read live and are unaffected.
          </p>
        ) : failed ? (
          <ErrorNote
            message="Your trade history could not load."
            onRetry={() => {
              void account.refetch();
              void activity.refetch();
            }}
          />
        ) : noRecord || (!stats && items.length === 0) ? (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center" data-testid="history-empty">
            <History className="mb-1 size-6 text-text-3" aria-hidden />
            <p className="font-strong text-[14.5px] text-text">No trades on record yet</p>
            <p className="max-w-md text-balance text-[13px] leading-5 text-text-2">Once you trade, your realized PnL, win rate and every fill show up here, usually within a minute.</p>
            <ButtonLink href="/" tone="secondary" size="sm" className="mt-2">
              Browse markets
            </ButtonLink>
          </div>
        ) : (
          <>
            {stats ? <Record stats={stats} /> : null}
            {items.length > 0 ? (
              <ul className="divide-y divide-line rounded-2xl border border-line" data-testid="history-activity">
                {(all ? items : items.slice(0, SHOWN)).map((item, i) => (
                  <ActivityRow key={`${item.receipt ?? i}-${item.kind}-${item.at}-${i}`} item={item} name={item.kind === "assetPerp" ? item.label : item.identifier ? (names.get(item.identifier) ?? baseIdentifier(item.identifier)) : item.label} />
                ))}
              </ul>
            ) : null}
            {items.length > SHOWN ? (
              <Button tone="ghost" size="sm" className="self-center" onClick={() => setAll((v) => !v)}>
                {all ? "Show fewer" : `Show all ${items.length}`}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </SectionCard>
  );
}

function Record({ stats }: { stats: NonNullable<AccountHistory["stats"]> }) {
  const tone = (v: number) => (Math.abs(v) < 0.005 ? undefined : v > 0 ? "up" : "down");
  const products = [
    { label: "Up or down", v: stats.perProduct.outcome },
    { label: "Attention perps", v: stats.perProduct.perp },
    { label: "Trend coins", v: stats.perProduct.coin },
  ];
  return (
    <div className="flex flex-col gap-3" data-testid="history-record">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="Realized PnL" value={signedUsdc(stats.realizedPnlUsdc)} tone={tone(stats.realizedPnlUsdc)} hint={`fees ${usdc(stats.feesPaidUsdc)} USDC`} />
        <StatTile label="Volume" value={usdc(stats.volumeUsdc)} hint={`${stats.tradeCount} ${stats.tradeCount === 1 ? "trade" : "trades"}`} />
        <StatTile label="Win rate" value={stats.closedTrades > 0 ? `${Math.round(stats.winRate * 100)}%` : "-"} tone={stats.closedTrades > 0 ? undefined : "muted"} hint={stats.closedTrades > 0 ? `${stats.wins} of ${stats.closedTrades} closed` : "no closed trades yet"} />
        <StatTile
          label="Best and worst"
          value={stats.bestTradeUsdc === null ? "-" : signedUsdc(stats.bestTradeUsdc)}
          tone={stats.bestTradeUsdc === null ? "muted" : tone(stats.bestTradeUsdc)}
          hint={`${stats.worstTradeUsdc === null ? "" : `worst ${signedUsdc(stats.worstTradeUsdc)}`}${stats.liquidations > 0 ? `${stats.worstTradeUsdc === null ? "" : " · "}${stats.liquidations} liquidated` : ""}` || undefined}
        />
      </div>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-text-3">
        {products.map((p) => (
          <span key={p.label}>
            {p.label} <span className={cn("num font-strong", Math.abs(p.v) < 0.005 ? "text-text-2" : p.v > 0 ? "text-up" : "text-down")}>{signedUsdc(p.v)}</span>
          </span>
        ))}
      </p>
    </div>
  );
}

function ActivityRow({ item, name }: { item: ActivityItem; name: string }) {
  const href = item.identifier && item.kind !== "assetPerp" ? `/t/${item.identifier}` : null;
  const status = item.status && item.status !== "filled" ? item.status : null;
  return (
    <li className="flex items-center gap-3 px-3.5 py-2.5" data-testid="history-item" data-kind={item.kind}>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          {href ? (
            <Link href={href} className="truncate font-strong text-[13.5px] text-text underline-offset-4 hover:underline">
              {name}
            </Link>
          ) : (
            <span className="truncate font-strong text-[13.5px] text-text">{name || KIND[item.kind]}</span>
          )}
          {/* Phones have no room for the kind; a wrapper hides it, since the badge sets its own display. */}
          <span className="hidden sm:inline-flex">
            <Badge className="h-5 px-2 text-[10.5px]">{KIND[item.kind]}</Badge>
          </span>
        </div>
        <p className="truncate text-[12px] text-text-3">
          {action(item)}
          {status ? ` · ${status}` : ""} · {ago(item.at)}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="num text-[13px] text-text">{item.amountUsdc === null ? "-" : `${usdc(item.amountUsdc)}`}</p>
        {item.pnlUsdc !== null ? <p className={cn("num font-strong text-[12px]", Math.abs(item.pnlUsdc) < 0.005 ? "text-text-3" : item.pnlUsdc > 0 ? "text-up" : "text-down")}>{signedUsdc(item.pnlUsdc)}</p> : <p className="text-[12px] text-text-3">USDC</p>}
      </div>
      {item.receipt ? (
        <ReceiptLink receipt={item.receipt} className="-mr-1.5 w-[28px] shrink-0 justify-end gap-1 rounded-lg px-1.5 py-1.5 text-[12px] hover:bg-surface-2 sm:w-[96px]" testId="history-tx">
          <span className="sr-only sm:not-sr-only">explorer</span>
        </ReceiptLink>
      ) : (
        <span className="-mr-1.5 w-[28px] shrink-0 sm:w-[96px]" />
      )}
    </li>
  );
}
