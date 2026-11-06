"use client";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, ChevronRight, Fingerprint, History, Plus, Radar } from "lucide-react";
import { AnimatePresence, m } from "framer-motion";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { Button, cn, Empty, ErrorNote, listItem, Num, Reveal, Segmented, Skeleton, useMedia } from "@/components/ui";
import { action, useActivity } from "@/features/portfolio/activity";
import { useAccount } from "@/lib/account/AccountProvider";
import { autopilot, type Trend } from "@/lib/api";
import { USDC_DECIMALS } from "@/lib/config";
import { ago, usdc, tokenNumber } from "@/lib/format";
import { useUsdcBalance, useTrends, useUpcoming } from "@/lib/hooks/queries";
import { useSheets } from "@/lib/sheets";
import { WaitlistRow } from "@/features/waitlist/Waitlist";
import { baseIdentifier, trendName } from "@/lib/trends";
import { RadarStrip } from "@/features/radar/RadarStrip";
import { TrendCard, TrendCardSkeleton } from "./TrendCard";

type Filter = "all" | "crypto" | "person" | "topic" | "markets";
type Sort = "hot" | "rising" | "new";

const FILTERS = [
  { value: "all", label: "All" },
  { value: "crypto", label: "Crypto" },
  { value: "person", label: "People" },
  { value: "topic", label: "Topics" },
  { value: "markets", label: "Stocks & politics" },
] as const;

function matches(t: Trend, f: Filter) {
  if (f === "all") return true;
  if (f === "markets") return t.assetClass === "equity" || t.assetClass === "politics" || t.assetClass === "commodity" || t.assetClass === "fx";
  return t.assetClass === f;
}

export default function Home() {
  const trends = useTrends();
  const upcoming = useUpcoming();
  const markets = useQuery({ queryKey: ["asset-perp-markets"], queryFn: () => autopilot.markets(), staleTime: 600_000 });
  const tradable = useMemo(() => new Set((markets.data?.markets ?? []).map((m) => m.symbol)), [markets.data]);
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("hot");
  const openSheet = useSheets((s) => s.open);
  // Each trend renders twice (a pager on phones, a grid wider); only the visible copy morphs.
  const wide = useMedia("(min-width: 640px)");

  const list = useMemo(() => {
    const rows = (trends.data?.trends ?? []).filter((t) => matches(t, filter));
    return rows.sort((a, b) => (sort === "hot" ? b.index - a.index : sort === "rising" ? (b.change24h ?? -1e9) - (a.change24h ?? -1e9) : b.createdAt - a.createdAt));
  }, [trends.data, filter, sort]);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <Hero />
        <WaitlistRow />
      </div>
      <section aria-labelledby="feed-title" className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 id="feed-title" className="font-display text-[28px] leading-tight text-text sm:text-[32px]">
              What the world is watching
            </h1>
            <p className="mt-1 text-[14px] text-text-2">Every card is a live attention index you can trade, measured by the oracle from X, Telegram, Bluesky, news, Wikipedia, Hacker News and smart money.</p>
          </div>
          <Segmented label="Sort trends" size="sm" value={sort} onChange={setSort} options={[{ value: "hot", label: "Hottest" }, { value: "rising", label: "Rising" }, { value: "new", label: "New" }]} className="w-full sm:w-auto" />
        </div>
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
              className={`h-8 shrink-0 rounded-full border px-3.5 font-strong text-[13px] transition-colors ${filter === f.value ? "border-transparent bg-text text-bg" : "border-line bg-surface text-text-2 hover:text-text"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        {trends.error ? <ErrorNote message="Trends could not load." onRetry={() => void trends.refetch()} /> : null}
        <Reveal
          ready={!trends.isLoading}
          fallback={
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                <TrendCardSkeleton key={i} />
              ))}
            </div>
          }
        >
          {list.length === 0 && trends.data && trends.data.trends.length > 0 ? (
            <Empty
              title={`No ${FILTERS.find((f) => f.value === filter)?.label.toLowerCase() ?? "trends"} trending right now`}
              body="Other categories have live markets. New trends list the moment the oracle measures enough attention."
              icon={<Radar className="size-6" />}
              action={
                <Button tone="secondary" onClick={() => setFilter("all")}>
                  Show every trend
                </Button>
              }
            />
          ) : list.length === 0 ? (
            <Empty
              title="Nothing trending yet"
              body="New trends list the moment the oracle measures enough attention. Know what everyone is talking about? Propose it."
              icon={<Radar className="size-6" />}
              action={
                <Button tone="secondary" icon={<Plus className="size-4" aria-hidden />} onClick={() => openSheet("propose")}>
                  Propose a trend
                </Button>
              }
            />
          ) : (
            <>
              <MobilePager trends={list} tradable={tradable} morph={!wide} />
              {/* Sorting, filtering and a new reading glide the cards to their places. */}
              <div className="relative hidden gap-4 sm:grid sm:grid-cols-2 xl:grid-cols-3">
                <AnimatePresence initial={false} mode="popLayout">
                  {list.map((t) => (
                    <m.div key={t.id} {...listItem}>
                      <TrendCard trend={t} tradable={t.ticker !== null && tradable.has(t.ticker)} morph={wide} />
                    </m.div>
                  ))}
                </AnimatePresence>
              </div>
            </>
          )}
        </Reveal>
      </section>
      {upcoming.data && upcoming.data.candidates.length > 0 ? <RadarStrip radar={upcoming.data} /> : null}
    </div>
  );
}

function Hero() {
  const account = useAccount();
  // While the session restores, both heroes are in the page and the account hint shows one.
  const restoring = account.status === "loading";
  return (
    <>
      {!account.authenticated ? <SignedOutHero className={restoring ? "when-no-account" : undefined} /> : null}
      {account.authenticated || restoring ? <BalanceHero className={restoring ? "when-account" : undefined} /> : null}
    </>
  );
}

function SignedOutHero({ className }: { className?: string }) {
  const account = useAccount();
  const open = useSheets((s) => s.open);
  return (
    <section className={cn("relative overflow-hidden rounded-[24px] border border-line bg-surface px-5 py-6 sm:px-10 sm:py-10", className)}>
      <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-primary-soft blur-3xl" />
      <p className="font-strong text-[11.5px] uppercase tracking-[0.14em] text-primary sm:text-[12px]">Attention markets</p>
      <h2 className="mt-2.5 max-w-xl font-display text-[30px] leading-[1.08] text-text sm:mt-3 sm:text-[44px]">Trade the narrative itself.</h2>
      <p className="mt-2.5 max-w-xl text-[14px] leading-[22px] text-text-2 sm:mt-3 sm:text-[15px] sm:leading-6">
        Up or down on any trend&rsquo;s attention, attention perps up to 3x, and Hyperliquid perps on the assets behind the noise.<span className="hidden sm:inline"> One passkey, no gas, settled in USDC.</span>
      </p>
      <div className="mt-5 grid grid-cols-2 gap-2 sm:mt-6 sm:flex sm:flex-wrap">
        <Button size="lg" className="px-3 sm:px-5" icon={<Fingerprint className="size-[18px]" aria-hidden />} onClick={account.login}>
          <span className="sm:hidden">Get started</span>
          <span className="hidden sm:inline">Start with a passkey</span>
        </Button>
        <Button size="lg" tone="secondary" className="px-3 sm:px-5" icon={<Plus className="size-[18px]" aria-hidden />} onClick={() => open("propose")}>
          <span className="sm:hidden">Propose</span>
          <span className="hidden sm:inline">Propose a trend</span>
        </Button>
      </div>
    </section>
  );
}

function BalanceHero({ className }: { className?: string }) {
  return (
    <>
      <WideBalanceHero className={cn("hidden sm:flex", className)} />
      <AccountHero className={cn("sm:hidden", className)} />
    </>
  );
}

function WideBalanceHero({ className }: { className?: string }) {
  const account = useAccount();
  const balance = useUsdcBalance(account.address);
  const open = useSheets((s) => s.open);
  return (
    <section className={cn("flex-row items-end justify-between gap-5 rounded-[24px] border border-line bg-surface px-8 py-7", className)}>
      <div>
        <p className="text-[13px] text-text-2">Your balance</p>
        <p className="num-display mt-1 font-display text-[52px] leading-none text-text">
          {balance.data ? <Num value={tokenNumber(balance.data.raw, USDC_DECIMALS)} /> : <span aria-label="Loading" className="skeleton inline-block h-[0.74em] w-[2.4em]" />} <span className="font-sans text-[17px] text-text-3">USDC</span>
        </p>
        <p className="mt-2 text-[13px] text-text-3">Gas-free trading from your passkey account</p>
      </div>
      <div className="flex gap-2">
        <Button size="lg" icon={<ArrowDownToLine className="size-[18px]" aria-hidden />} onClick={() => open("deposit")}>
          Add funds
        </Button>
        <Button size="lg" tone="secondary" icon={<Plus className="size-[18px]" aria-hidden />} onClick={() => open("propose")}>
          Propose
        </Button>
      </div>
    </section>
  );
}

/** Rows of recent activity the phone hero always makes room for, so it never changes height. */
const RECENT = 2;

/**
 * Phones: the top bar already shows the balance, so the hero shows what the account did last and
 * the two things to do next, at a fixed height from the first paint.
 */
function AccountHero({ className }: { className?: string }) {
  const account = useAccount();
  const open = useSheets((s) => s.open);
  // Only phones show it, so only phones ask for it.
  const phone = useMedia("(max-width: 639px)");
  const activity = useActivity(account.address, phone);
  const trends = useTrends();
  const names = useMemo(() => new Map((trends.data?.trends ?? []).map((t) => [t.identifier, trendName(t)])), [trends.data]);
  const items = (activity.data?.items ?? []).slice(0, RECENT);
  const loading = !account.address || (activity.isPending && !activity.isError);
  return (
    <section className={cn("flex-col gap-4 rounded-[24px] border border-line bg-surface px-5 py-5", className)} data-testid="account-hero">
      <div className="grid grid-cols-2 gap-2">
        <Button size="lg" className="px-3" icon={<ArrowDownToLine className="size-[18px]" aria-hidden />} onClick={() => open("deposit")}>
          Add funds
        </Button>
        <Button size="lg" tone="secondary" className="px-3" icon={<Plus className="size-[18px]" aria-hidden />} onClick={() => open("propose")}>
          Propose
        </Button>
      </div>
      <div className="flex flex-col gap-1.5 border-t border-line pt-3.5">
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-1.5 text-[12.5px] text-text-2">
            <History className="size-3.5 text-text-3" aria-hidden />
            Recent activity
          </p>
          <Link href="/portfolio" className="flex items-center text-[12.5px] text-text-3 transition-colors hover:text-text">
            Portfolio
            <ChevronRight className="size-3.5" aria-hidden />
          </Link>
        </div>
        <ul className="flex flex-col" style={{ height: RECENT * 40 }}>
          {loading ? (
            Array.from({ length: RECENT }, (_, i) => (
              <li key={i} className="flex h-10 items-center justify-between gap-3">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-14" />
              </li>
            ))
          ) : items.length === 0 ? (
            <li className="flex h-full items-center text-[13px] leading-5 text-text-3">Your trades show here. Pick a trend below to make the first.</li>
          ) : (
            items.map((item, i) => {
              const name = item.kind === "assetPerp" ? item.label : item.identifier ? (names.get(item.identifier) ?? baseIdentifier(item.identifier)) : item.label;
              return (
                <li key={`${item.receipt ?? i}-${item.at}`} className="flex h-10 items-center justify-between gap-3 text-[13px]">
                  <span className="min-w-0 truncate">
                    <span className="text-text-2">{action(item)}</span> <span className="font-strong text-text">{name}</span>
                  </span>
                  <span className="num shrink-0 text-text-3">
                    {item.amountUsdc === null ? "" : `${usdc(item.amountUsdc)} · `}
                    {ago(item.at)}
                  </span>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </section>
  );
}

/** Phones: swipe sideways through full-width cards, one trend at a time. */
function MobilePager({ trends, tradable, morph }: { trends: Trend[]; tradable: Set<string>; morph: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  return (
    <div className="sm:hidden">
      <div
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          setPage(Math.round(el.scrollLeft / (el.clientWidth * 0.86)));
        }}
        className="no-scrollbar -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2"
        aria-roledescription="carousel"
        aria-label="Trends"
      >
        {trends.map((t, i) => (
          <div key={t.id} className="w-[86%] shrink-0 snap-center" aria-roledescription="slide" aria-label={`${i + 1} of ${trends.length}`}>
            <TrendCard trend={t} tradable={t.ticker !== null && tradable.has(t.ticker)} className="min-h-[260px]" morph={morph} />
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-center gap-1.5" aria-hidden>
        {trends.slice(0, 12).map((t, i) => (
          <span key={t.id} className={`h-1.5 rounded-full transition-all ${i === Math.min(page, 11) ? "w-4 bg-text" : "w-1.5 bg-line-strong"}`} />
        ))}
      </div>
    </div>
  );
}
