"use client";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ChevronLeft, Radar, RotateCcw, ShieldCheck, Snowflake, TrendingDown, TrendingUp } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Avatar } from "@/components/shell/AppShell";
import { BACK } from "@/components/shell/PageTransition";
import { Badge, Button, ButtonLink, Card, CardHeader, cn, Delta, Empty, ErrorNote, ExplorerLink, Num, Reveal, Segmented, Sparkline } from "@/components/ui";
import { Chart } from "@/components/ui/Chart";
import { ApiError, history, type SourceName, type Trend, type TrendDetail } from "@/lib/api";
import { Morph, morphName } from "@/features/home/TrendCard";
import { ShareMenu } from "@/features/share/ShareActions";
import { DEPLOYMENT, explorerAddress } from "@/lib/config";
import { ago, assetClassLabel, usdc, compact, integer, points, shortAddress } from "@/lib/format";
import { useTrend, useTrends } from "@/lib/hooks/queries";
import { useSheets } from "@/lib/sheets";
import { baseIdentifier, listingNumber, trendName } from "@/lib/trends";
import { AlertButton } from "@/features/alerts/AlertSheet";
import { useRegistryIndex, useSeries } from "./data";
import OnChain from "./OnChain";
import Thread from "./Thread";
import TradeBar from "./TradeBar";
import TradePanel from "./TradePanel";

/** Smart money netflow (USD, 24 hours) at which it confirms or contradicts the attention. */
const CONFIRM_NETFLOW_USD = 100_000;

export default function TrendView({ identifier }: { identifier: string }) {
  const q = useTrend(identifier);
  // The listing as Home showed it: the header renders from it in the navigation's first frame,
  // so the card's name and index morph into it even before the trend's own data arrives.
  const listed = useTrends().data?.trends.find((t) => t.identifier === identifier);
  // A failed refetch keeps the page (and any ticket in progress); only a first load can fail here.
  if (!q.data && !q.isLoading) {
    if (q.error instanceof ApiError && q.error.status === 404) {
      return (
        <Empty
          className="py-24"
          icon={<Radar className="size-7" />}
          title="This trend is not listed"
          body="It may have retired, or the radar has not picked it up yet. Propose it and it lists once the oracle measures enough attention."
          action={
            <ButtonLink href="/" transitionTypes={BACK}>
              Back to markets
            </ButtonLink>
          }
        />
      );
    }
    return <ErrorNote message="This trend could not load." onRetry={() => void q.refetch()} />;
  }
  const trend = q.data?.trend ?? listed;
  return (
    <div className="flex flex-col gap-6">
      <Reveal ready={trend !== undefined} fallback={<HeaderSkeleton />}>
        {trend ? <Header trend={trend} history={q.data?.index ?? null} /> : null}
      </Reveal>
      <Reveal ready={q.data !== undefined} fallback={<BodySkeleton />}>
        {q.data ? <Loaded detail={q.data} /> : null}
      </Reveal>
    </div>
  );
}

function Loaded({ detail }: { detail: TrendDetail }) {
  const { trend } = detail;
  const relisted = trend.status === "retired" ? (detail.relistedAs ?? null) : null;
  return (
    <div className="flex flex-col gap-6">
      {relisted ? <Relisted identifier={relisted} /> : null}
      {!relisted && trend.rotatingOut && trend.status !== "retired" ? <RotatingOut /> : null}
      <div className="grid gap-6 [grid-template-areas:'chart'_'trade'_'sources'_'thread'] lg:grid-cols-[minmax(0,1fr)_380px] lg:grid-rows-[auto_auto_1fr] lg:[grid-template-areas:'chart_trade'_'sources_trade'_'thread_trade']">
        <div className="flex min-w-0 flex-col gap-4 [grid-area:chart]">
          <IndexCard detail={detail} />
          <StatsStrip identifier={trend.identifier} />
        </div>
        <div className="min-w-0 [grid-area:trade] lg:sticky lg:top-[88px] lg:self-start" data-trade-anchor>
          <TradePanel trend={trend} className="lg:max-h-[calc(100dvh-112px)]" />
        </div>
        <div className="flex min-w-0 flex-col gap-6 [grid-area:sources]">
          <SourcesCard detail={detail} relisted={relisted} />
          <CurationCard trend={trend} />
          <OnChain trend={trend} />
        </div>
        <div className="min-w-0 [grid-area:thread]">
          <Thread trend={trend} />
        </div>
      </div>
      {!relisted && trend.status !== "retired" ? <TradeBar trend={trend} /> : null}
    </div>
  );
}

/** Change over the last day, or since listing for a younger trend, from the index history. */
function changeOf(history: TrendDetail["index"] | null, index: number, fallback: number | null): { pct: number; label: string } | null {
  // Until the trend's history arrives, the listing's own 24 hour change.
  if (history === null) return fallback === null ? null : { pct: fallback, label: "24h" };
  const first = history[0];
  const newest = history[history.length - 1];
  if (!first || !newest) return null;
  const dayAgo = newest.t - 86_400;
  const base = [...history].reverse().find((p) => p.t <= dayAgo) ?? null;
  const from = base ?? first;
  if (from.v <= 0) return null;
  return { pct: ((index - from.v) / from.v) * 100, label: base ? "24h" : "since listing" };
}

const TWO = { minimumFractionDigits: 2, maximumFractionDigits: 2 };

function Header({ trend, history }: { trend: Trend; history: TrendDetail["index"] | null }) {
  const live = useRegistryIndex(trend.id);
  const index = live.data?.index ?? trend.index;
  const change = changeOf(history, index, trend.change24h ?? null);
  const name = trendName(trend);
  const listing = listingNumber(trend.identifier);
  const retired = trend.status === "retired";
  const stale = live.data !== undefined && !live.data.fresh && !retired;
  const shareText = `Attention on ${name} is at ${index.toFixed(1)}${change ? ` (${change.pct >= 0 ? "+" : ""}${change.pct.toFixed(1)}% ${change.label === "24h" ? "in 24h" : "since listing"})` : ""}. Trade it on Tredio.`;
  return (
    <header className="flex flex-col gap-3">
      <Link href="/" transitionTypes={BACK} className="-ml-1 inline-flex w-fit items-center gap-0.5 rounded-lg px-1 py-0.5 text-[13px] text-text-3 transition-colors hover:text-text">
        <ChevronLeft className="size-4" aria-hidden />
        Markets
      </Link>
      <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge>{assetClassLabel(trend.assetClass)}</Badge>
            {trend.status === "cooling" ? (
              <Badge tone="warn" icon={<Snowflake className="size-3" aria-hidden />}>
                Cooling
              </Badge>
            ) : trend.status === "retired" ? (
              <Badge tone="down">Retired</Badge>
            ) : null}
            {trend.ticker ? <Badge tone="primary">{trend.ticker}</Badge> : null}
            <span className="font-mono text-[12px] text-text-3">{baseIdentifier(trend.identifier)}</span>
            {listing > 1 ? <span className="text-[12px] text-text-3">· Listing {listing}</span> : null}
          </div>
          <Morph name={morphName("title", trend)}>
            <h1 className="mt-2.5 w-fit font-display text-[34px] leading-[1.08] text-text sm:text-[42px]">{name}</h1>
          </Morph>
          {trend.summary ? <p className="mt-2 max-w-2xl text-[14.5px] leading-6 text-text-2">{trend.summary}</p> : null}
        </div>
        <div className="flex shrink-0 items-end justify-between gap-6 md:justify-end">
          <div>
            <p className="text-[11.5px] uppercase tracking-[0.08em] text-text-3">Attention index</p>
            <div className="mt-1 flex items-baseline gap-2.5">
              <Morph name={morphName("index", trend)}>
                <span className="num-display font-display text-[46px] leading-none text-text">
                  <Num value={index} format={TWO} testId="trend-index" />
                </span>
              </Morph>
              {change ? (
                <span className="flex items-baseline gap-1">
                  <Delta value={change.pct} className="text-[14px]" />
                  <span className="text-[12px] text-text-3">{change.label}</span>
                </span>
              ) : null}
            </div>
            <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-text-3">
              <span className={cn("size-1.5 rounded-full", retired ? "bg-text-3" : stale ? "bg-warn" : "live-dot bg-up")} aria-hidden />
              {retired
                ? `Final reading ${ago(live.data?.updatedAt ?? trend.updatedAt)}, peak ${points(trend.peakIndex)}`
                : stale
                  ? "Index updating: trading resumes on the next report"
                  : `Updated ${ago(live.data?.updatedAt ?? trend.updatedAt)}, peak ${points(trend.peakIndex)}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {retired ? null : <AlertButton trend={trend} index={index} />}
            <ShareMenu text={shareText} path={`/t/${trend.identifier}`} />
          </div>
        </div>
      </div>
    </header>
  );
}

/** Volume, open interest and holders from the indexer; hidden until it has them. */
function StatsStrip({ identifier }: { identifier: string }) {
  const q = useQuery({ queryKey: ["trend-stats", identifier], queryFn: () => history.trend(identifier), refetchInterval: 30_000, retry: false });
  const s = q.data?.stats;
  if (!s) return null;
  const tiles = [
    { label: "24h volume", value: `${usdc(s.volume24hUsdc)}`, unit: "USDC" },
    { label: "Open interest", value: `${usdc(s.perpLongOpenInterestUsdc + s.perpShortOpenInterestUsdc)}`, unit: "USDC" },
    { label: "Holders", value: integer(s.holderCount), unit: null },
    { label: "Traders", value: integer(s.traderCount), unit: null },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2 2xl:grid-cols-4" data-testid="trend-stats">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-2xl border border-line bg-surface px-4 py-3">
          <p className="text-[11.5px] uppercase tracking-[0.06em] text-text-3">{t.label}</p>
          <p className="num mt-1 truncate font-strong text-[16px] text-text">
            {t.value}
            {t.unit ? <span className="ml-1 font-sans text-[12px] text-text-3">{t.unit}</span> : null}
          </p>
        </div>
      ))}
    </div>
  );
}

type Range = "24h" | "7d";

/** The chart's axis labels: one decimal. A module constant, so readings never re-format the chart. */
const indexLabel = (v: number) => v.toFixed(1);

function IndexCard({ detail }: { detail: TrendDetail }) {
  const [range, setRange] = useState<Range>("24h");
  const series = useSeries(detail.trend.id);
  const live = useRegistryIndex(detail.trend.id);
  const day = series.data?.find((s) => s.window === 86_400 && s.outcome === 0);
  const pts = useMemo(() => {
    // The window ends at the newest reading, so the chart never depends on the render clock.
    const newest = Math.max(live.data?.updatedAt ?? 0, detail.index[detail.index.length - 1]?.t ?? 0);
    const since = newest - (range === "24h" ? 86_400 : 7 * 86_400);
    const rows = detail.index.filter((p) => p.t >= since);
    const last = rows[rows.length - 1];
    if (live.data && (!last || live.data.updatedAt > last.t)) rows.push({ t: live.data.updatedAt, v: live.data.index });
    return rows;
  }, [detail.index, range, live.data]);
  const reference = useMemo(() => (day ? { value: day.openingIndex, label: "24h open" } : undefined), [day]);
  return (
    <Card>
      <CardHeader
        title="Attention over time"
        subtitle="0 to 100, recorded every few minutes"
        action={<Segmented label="Chart range" size="sm" value={range} onChange={setRange} options={[{ value: "24h", label: "24H" }, { value: "7d", label: "7D" }]} />}
      />
      <Morph name={morphName("chart", detail.trend)}>
        <div className="px-2 pb-3 pt-2 sm:px-3">
          {pts.length >= 2 ? (
            <Chart points={pts} height={260} reference={reference} valueFormat={indexLabel} minRange={4} />
          ) : (
            <div className="flex h-[260px] items-center justify-center text-center text-[13px] text-text-3">The chart fills in as the oracle reports. New trends show history within minutes.</div>
          )}
        </div>
      </Morph>
    </Card>
  );
}

const SOURCES: Record<SourceName, { label: string; unit: string; note: string }> = {
  elfa: { label: "X and Telegram", unit: "posts", note: "24h, Elfa" },
  bluesky: { label: "Bluesky", unit: "posts", note: "24h public posts" },
  wikipedia: { label: "Wikipedia", unit: "readers", note: "24h page views" },
  gdelt: { label: "News", unit: "articles", note: "24h, GDELT" },
  nansen: { label: "Smart money", unit: "net flow", note: "24h net buying, Nansen" },
  hn: { label: "Hacker News", unit: "mentions", note: "24h stories and comments" },
};

/** The backend is rotating this trend out for a fresher one: no new rounds, open ones settle soon. */
function RotatingOut() {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-[color:var(--warn-soft)] bg-warn-soft px-4 py-3.5 text-[13.5px] leading-5 text-text" data-testid="rotating-out">
      <RotateCcw className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
      <span>
        <span className="font-strong">Rotating out.</span>{" "}
        <span className="text-text-2">Attention here has faded, so this trend is making room for a newer one. No new rounds open, and open rounds settle at its last index within about two hours.</span>
      </span>
    </div>
  );
}

/** A retired listing whose topic is live again under a new listing. */
function Relisted({ identifier }: { identifier: string }) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-[color:var(--primary-soft)] bg-primary-soft px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between" data-testid="relisted">
      <p className="flex items-start gap-3 text-[13.5px] leading-5 text-text">
        <RotateCcw className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <span>
          <span className="font-strong">This topic is live again.</span> <span className="text-text-2">This listing retired; its attention now trades on a new listing.</span>
        </span>
      </p>
      <ButtonLink href={`/t/${identifier}`} size="sm" className="shrink-0 self-start sm:self-auto">
        View {identifier}
        <ArrowRight className="size-3.5" aria-hidden />
      </ButtonLink>
    </div>
  );
}

function SourcesCard({ detail, relisted }: { detail: TrendDetail; relisted: string | null }) {
  const { trend, history } = detail;
  const crypto = trend.assetClass === "crypto";
  const order: SourceName[] = crypto ? ["elfa", "bluesky", "nansen", "wikipedia", "gdelt", "hn"] : ["elfa", "bluesky", "wikipedia", "gdelt", "hn"];
  // A news count of zero usually means GDELT did not answer, and most topics never reach Hacker
  // News, so both show only when positive.
  const rows = order.filter((s) => (s === "gdelt" || s === "hn" ? (trend.readings[s]?.value ?? 0) > 0 : trend.readings[s] !== null || s === "elfa"));
  const flow = trend.readings.nansen?.value ?? null;
  const verdict = flow === null ? null : flow >= CONFIRM_NETFLOW_USD ? "confirms" : flow <= -CONFIRM_NETFLOW_USD ? "contradicts" : "neutral";
  return (
    <Card>
      <CardHeader title="Where the attention comes from" subtitle="The index blends these readings, weighted and smoothed" />
      {crypto && verdict && !relisted ? (
        <div
          className={cn(
            "mx-5 mt-4 flex items-start gap-3 rounded-xl px-3.5 py-3 text-[13px] leading-5",
            verdict === "confirms" ? "bg-up-soft" : verdict === "contradicts" ? "bg-down-soft" : "bg-surface-2",
          )}
          data-testid="smart-money"
        >
          {verdict === "confirms" ? <ShieldCheck className="mt-0.5 size-4 shrink-0 text-up" aria-hidden /> : verdict === "contradicts" ? <TrendingDown className="mt-0.5 size-4 shrink-0 text-down" aria-hidden /> : <TrendingUp className="mt-0.5 size-4 shrink-0 text-text-3" aria-hidden />}
          <p className="text-text">
            <span className="font-strong">{verdict === "confirms" ? "Smart money confirms." : verdict === "contradicts" ? "Smart money is selling." : "Smart money is on the sidelines."}</span>{" "}
            <span className="text-text-2">
              Labelled funds and traders {flow! >= 0 ? "bought" : "sold"} a net ${compact(Math.abs(flow!))} of {trend.ticker ?? "it"} in 24 hours.
            </span>
          </p>
        </div>
      ) : null}
      {relisted ? (
        <p className="mx-5 mb-4 mt-4 rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] leading-5 text-text-2">
          The topic&rsquo;s readings now feed its live listing,{" "}
          <Link href={`/t/${relisted}`} className="font-strong text-text underline-offset-4 hover:underline">
            {relisted}
          </Link>
          . This listing&rsquo;s index stopped when it retired.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-line px-5 pb-2">
          {rows.map((s) => {
            const r = trend.readings[s];
            const spark = history.filter((h) => h.source === s).map((h) => h.value);
            const value = r === null ? "-" : s === "nansen" ? `${r.value >= 0 ? "+" : "-"}$${compact(Math.abs(r.value))}` : compact(r.value);
            return (
              <li key={s} className="flex items-center gap-4 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="font-strong text-[14px] text-text">{SOURCES[s].label}</p>
                  <p className="mt-0.5 truncate text-[12.5px] text-text-3">{r ? `${SOURCES[s].note}, ${ago(r.observedAt)}` : "Not measured yet"}</p>
                </div>
                <Sparkline values={spark} width={72} height={28} className="hidden shrink-0 sm:block" />
                <div className="w-[92px] shrink-0 text-right">
                  <p className={cn("num font-strong text-[15px]", s === "nansen" && r ? (r.value >= 0 ? "text-up" : "text-down") : "text-text")}>{value}</p>
                  <p className="text-[11.5px] text-text-3">{SOURCES[s].unit}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="border-t border-line px-5 py-3.5 text-[12px] leading-5 text-text-3">
        Measured by the Tredio oracle and recorded in the{" "}
        <ExplorerLink href={explorerAddress(DEPLOYMENT.registry)} className="gap-1 whitespace-nowrap text-text-2">
          registry contract
        </ExplorerLink>
      </p>
    </Card>
  );
}

/** The surfacer the registry records for trends the radar found itself. */
const RADAR_SURFACER = "radar";

function CurationCard({ trend }: { trend: Trend }) {
  const open = useSheets((s) => s.open);
  const radar = trend.surfacer === RADAR_SURFACER;
  return (
    <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        {radar ? (
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
            <Radar className="size-[18px]" aria-hidden />
          </span>
        ) : (
          <Avatar address={trend.surfacer} size={36} />
        )}
        <div className="min-w-0">
          <p className="font-strong text-[14px] text-text">
            {radar ? "Found by the Tredio radar" : (
              <>
                Surfaced by{" "}
                <Link href={`/c/${trend.surfacer}`} className="num font-mono text-[13px] text-primary hover:underline">
                  {shortAddress(trend.surfacer)}
                </Link>
              </>
            )}
          </p>
          <p className="mt-0.5 text-[12.5px] leading-[18px] text-text-2">Whoever surfaces a trend first earns 15% of its perp fees and 10% of its coin fees.</p>
        </div>
      </div>
      <Button tone="secondary" size="sm" className="shrink-0" onClick={() => open("propose")}>
        Propose a trend
      </Button>
    </Card>
  );
}

function HeaderSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy>
      <div className="skeleton h-4 w-20" />
      <div className="skeleton h-6 w-28" />
      <div className="skeleton h-10 w-2/3 max-w-md" />
      <div className="skeleton h-4 w-full max-w-xl" />
    </div>
  );
}

function BodySkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]" aria-busy>
      <div className="skeleton h-[340px]" />
      <div className="skeleton h-[420px]" />
    </div>
  );
}
