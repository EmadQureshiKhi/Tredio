"use client";
import { ArrowDownToLine, Fingerprint, Radar, Wallet } from "lucide-react";
import { useMemo } from "react";
import { Button, ButtonLink, Card, cn, ErrorNote, Num, Reveal, Skeleton } from "@/components/ui";
import { tokenNumber } from "@/lib/format";
import { useSheets } from "@/lib/sheets";
import { CoinSection } from "./CoinSection";
import { CurationCard } from "./CurationCard";
import { AutopilotSection } from "./AutopilotSection";
import { TradeHistory } from "./TradeHistory";
import { usePortfolioData } from "./hooks";
import { toUsdc } from "./math";
import { OutcomeSection } from "./OutcomeSection";
import { SignedUsdc, SkeletonRows, toneOf } from "./parts";
import { AssetPerpSection, type AssetPerpTag } from "./AssetPerpSection";
import { PerpSection } from "./PerpSection";

/** Everything the signed-in account holds, valued live. */
export default function Portfolio() {
  const data = usePortfolioData();
  const { account } = data;

  return (
    <div className="flex flex-col gap-6 lg:gap-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="font-display text-[30px] leading-[1.1] text-text sm:text-[36px]">Portfolio</h1>
          <p className="mt-2 max-w-2xl text-[14px] leading-[22px] text-text-2">Everything your account holds, valued live.</p>
        </div>
        {account.authenticated ? <LivePill stale={[data.outcomes, data.perps, data.assetPerps].some((q) => q.isError && q.data !== undefined)} /> : null}
      </header>
      {!account.ready ? <SummarySkeleton /> : !account.authenticated ? <SignedOut status={account.status} login={account.login} /> : <Holdings data={data} />}
    </div>
  );
}

function LivePill({ stale }: { stale: boolean }) {
  return (
    <p className="flex h-8 items-center gap-2 self-start rounded-full border border-line bg-surface px-3 text-[12.5px] text-text-2 sm:self-auto" data-testid="live-block">
      <span className={cn("size-2 rounded-full", stale ? "bg-warn" : "live-dot bg-up")} aria-hidden />
      {stale ? "Refresh failed; showing the last values" : "Live, refreshing every few seconds"}
    </p>
  );
}

function SignedOut({ status, login }: { status: string; login: () => void }) {
  const expired = status === "session-expired";
  return (
    <Card className="flex flex-col items-center gap-3 px-6 py-14 text-center sm:py-20">
      <div className="mb-1 flex size-12 items-center justify-center rounded-full bg-primary-soft text-primary">
        <Wallet className="size-6" aria-hidden />
      </div>
      <p className="font-strong text-[16px] text-text">{expired ? "Renew your session to see your portfolio" : "Sign in to see your portfolio"}</p>
      <p className="max-w-md text-[14px] leading-[22px] text-text-2">Your UP and DOWN tokens, attention perps, Hyperliquid perps, trend coins and curation earnings, valued live, in one place.</p>
      <Button size="lg" className="mt-3" icon={<Fingerprint className="size-[18px]" aria-hidden />} onClick={login}>
        {expired ? "Renew with passkey" : "Sign in"}
      </Button>
    </Card>
  );
}

function SummarySkeleton() {
  return (
    <>
      <div className="flex flex-col gap-6 rounded-[24px] border border-line bg-surface px-5 py-6 sm:px-8 sm:py-7" aria-hidden>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-12 w-64 max-w-full" />
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="grid grid-cols-2 gap-4 border-t border-line pt-5 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex flex-col gap-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-5 w-20" />
            </div>
          ))}
        </div>
      </div>
      <Card aria-hidden>
        <div className="flex flex-col gap-2 px-4 pb-4 pt-5 sm:px-6">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <SkeletonRows />
      </Card>
    </>
  );
}

type Data = ReturnType<typeof usePortfolioData>;

function Holdings({ data }: { data: Data }) {
  const { trends, cash, outcomes, perps, coins, assetPerps, assetPerpMarkets, curation, performance, automation } = data;
  const open = useSheets((s) => s.open);

  const totals = useMemo(() => {
    const holdings = outcomes.data?.holdings ?? [];
    const outcomeTotal = holdings.reduce((a, h) => a + (h.value ?? 0), 0);
    const outcomePriced = holdings.every((h) => h.value !== null);
    const perpEquity = (perps.data ?? []).reduce((a, p) => a + Math.max(0, toUsdc(p.equity)), 0);
    const coinTotal = (coins.data ?? []).reduce((a, c) => a + (c.value ?? 0), 0);
    const assetPerpTotal = (assetPerps.data?.balance ?? 0) + (assetPerps.data?.positions ?? []).reduce((a, p) => a + p.marginUsdc + p.pnl, 0);
    const claimable = curation.data ? toUsdc(curation.data.claimable) : 0;
    // Cash from the same read as the outcome tokens when there is one, so totals match.
    const cashValue = outcomes.data ? toUsdc(outcomes.data.cash) : (cash.data?.value ?? 0);
    // Attention perps: equity over margin, funding included.
    const unrealized = (perps.data ?? []).reduce((a, p) => a + toUsdc(p.equity - p.margin), 0) + (assetPerps.data?.positions ?? []).reduce((a, p) => a + p.pnl, 0);
    const openPerps = (perps.data?.length ?? 0) + (assetPerps.data?.positions.length ?? 0);
    return { outcomeTotal, outcomePriced, perpEquity, coinTotal, assetPerpTotal, claimable, cashValue, unrealized, openPerps, total: cashValue + outcomeTotal + perpEquity + coinTotal + assetPerpTotal + claimable };
  }, [outcomes.data, perps.data, coins.data, assetPerps.data, curation.data, cash.data]);

  const labels = useMemo(() => {
    const out = new Map<number, AssetPerpTag>();
    const a = automation.data;
    for (const p of assetPerps.data?.positions ?? []) {
      const ruled = a?.details.some((d) => d.rule.status !== "stopped" && d.positions.some((x) => x.market === p.market.symbol && (x.status === "open" || x.status === "opening" || x.status === "closing")));
      out.set(p.market.id, ruled ? "autopilot" : a?.following ? "copy" : null);
    }
    return out;
  }, [automation.data, assetPerps.data]);

  const loading = trends.isLoading || cash.isLoading || outcomes.isLoading || perps.isLoading;
  const ready = !(loading && !outcomes.data && !perps.data);

  const errors: Array<{ message: string; retry: () => void }> = [
    // A failed refresh keeps the last good numbers (the live pill says so); only missing data is an error.
    trends.error && !trends.data ? { message: "Trends could not load from Tredio.", retry: () => void trends.refetch() } : null,
    outcomes.error && !outcomes.data ? { message: "Outcome tokens could not be read.", retry: () => void outcomes.refetch() } : null,
    perps.error && !perps.data ? { message: "Attention perps could not be read.", retry: () => void perps.refetch() } : null,
    coins.error && !coins.data ? { message: "Trend coins could not be read.", retry: () => void coins.refetch() } : null,
    (assetPerps.error && !assetPerps.data) || (assetPerpMarkets.error && !assetPerpMarkets.data) ? { message: "Hyperliquid positions could not be read.", retry: () => void (assetPerpMarkets.error ? assetPerpMarkets.refetch() : assetPerps.refetch()) } : null,
  ].filter((e) => e !== null);

  const outcomeRows = outcomes.data?.holdings ?? [];
  const perpRows = perps.data ?? [];
  const coinRows = coins.data ?? [];
  const assetPerpRows = assetPerps.data?.positions ?? [];
  const assetPerpBalance = assetPerps.data?.balance ?? 0;
  const nothing = outcomeRows.length === 0 && perpRows.length === 0 && coinRows.length === 0 && assetPerpRows.length === 0 && assetPerpBalance < 0.005;
  const autopilotRecord = performance.data && performance.data.stats.trades > 0 ? performance.data : null;

  return (
    <Reveal ready={ready} fallback={<SummarySkeleton />} className="flex flex-col gap-6 lg:gap-8">
      <section aria-label="Totals" className="relative overflow-hidden rounded-[24px] border border-line bg-surface px-5 py-6 sm:px-8 sm:py-7" data-testid="portfolio-summary">
        <div aria-hidden className="pointer-events-none absolute -right-24 -top-28 size-72 rounded-full bg-primary-soft blur-3xl" />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <p className="text-[13px] text-text-2">Portfolio value</p>
            <p className="num-display mt-1 font-display text-[44px] leading-none text-text sm:text-[52px]">
              <Num value={totals.total} testId="portfolio-total" /> <span className="font-sans text-[17px] text-text-3">USDC</span>
            </p>
            <p className="mt-2.5 text-[13px] text-text-2">
              {totals.openPerps > 0 ? (
                <>
                  Unrealized PnL{" "}
                  <span className={cn("num font-strong", toneOf(totals.unrealized))}>
                    <SignedUsdc value={totals.unrealized} testId="portfolio-unrealized" />
                  </span>{" "}
                  on {totals.openPerps} open {totals.openPerps === 1 ? "perp" : "perps"}
                </>
              ) : (
                "No open perps, so nothing unrealized"
              )}
              {!totals.outcomePriced ? <span className="text-text-3"> · some tokens have no price yet</span> : null}
            </p>
          </div>
          <Button size="lg" icon={<ArrowDownToLine className="size-[18px]" aria-hidden />} onClick={() => open("deposit")} className="self-start sm:self-auto">
            Add funds
          </Button>
        </div>
        <dl className="relative mt-6 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-5 sm:grid-cols-3 lg:grid-cols-6">
          <Total label="Cash" value={outcomes.data ? tokenNumber(outcomes.data.cash, 6) : cash.data ? tokenNumber(cash.data.raw, 6) : null} testId="total-cash" />
          <Total label="Up or down" value={totals.outcomeTotal} testId="total-outcomes" />
          <Total label="Attention perps" value={totals.perpEquity} testId="total-perps" />
          <Total label="Hyperliquid" value={totals.assetPerpTotal} />
          <Total label="Trend coins" value={totals.coinTotal} />
          <Total label="Curation" value={totals.claimable} hint="to claim" />
        </dl>
      </section>

      {errors.map((e) => (
        <ErrorNote key={e.message} message={e.message} onRetry={e.retry} />
      ))}

      {nothing && errors.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 px-6 py-12 text-center" data-testid="portfolio-empty">
          <Radar className="mb-1 size-6 text-text-3" aria-hidden />
          <p className="font-strong text-[15px] text-text">No positions yet</p>
          <p className="max-w-md text-[13.5px] leading-5 text-text-2">Buy UP or DOWN on a trend&rsquo;s attention, go long or short it with an attention perp, or let Autopilot trade Hyperliquid perps for you. Every position shows up here.</p>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <ButtonLink href="/">Explore markets</ButtonLink>
            {totals.cashValue < 1 ? (
              <Button tone="secondary" onClick={() => open("deposit")}>
                Add funds
              </Button>
            ) : null}
          </div>
        </Card>
      ) : null}

      {/* Always mounted (each renders its card only when it has rows) so open sheets survive the last row closing. */}
      <OutcomeSection holdings={outcomeRows} total={totals.outcomePriced ? totals.outcomeTotal : null} />
      <PerpSection positions={perpRows} total={totals.perpEquity} />
      <AssetPerpSection positions={assetPerpRows} balance={assetPerpBalance} labels={labels} total={totals.assetPerpTotal} />
      <CoinSection coins={coinRows} total={totals.coinTotal} />
      {curation.data ? <CurationCard claimable={curation.data.claimable} earned={curation.data.earned} trends={trends.data?.trends ?? []} /> : null}
      {data.address ? <TradeHistory address={data.address} trends={trends.data?.trends ?? []} /> : null}
      {autopilotRecord ? <AutopilotSection stats={autopilotRecord.stats} equity={autopilotRecord.equity} details={automation.data?.details ?? []} /> : null}
    </Reveal>
  );
}

function Total({ label, value, hint, testId }: { label: string; value: number | null; hint?: string; testId?: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11.5px] uppercase tracking-[0.08em] text-text-3">{label}</dt>
      <dd className="num mt-1 truncate font-strong text-[16px] leading-6 text-text">
        <Num value={value} testId={testId} />
        {hint ? <span className="ml-1 font-sans text-[12px] text-text-3">{hint}</span> : null}
      </dd>
    </div>
  );
}
