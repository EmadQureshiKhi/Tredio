"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, CirclePause, Copy, FlaskConical, Fingerprint, PenLine } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge, Button, ButtonLink, Card, cn, Empty, ErrorNote, ExplorerLink, Row, Skeleton } from "@/components/ui";
import { describeError, useAccount } from "@/lib/account/AccountProvider";
import { ApiError, autopilot, type RuleDetail as Detail } from "@/lib/api";
import { explorerTx } from "@/lib/config";
import { ago, usdc, price } from "@/lib/format";
import { useTrends } from "@/lib/hooks/queries";
import { useSheets } from "@/lib/sheets";
import { notify } from "@/lib/toast";
import { newestListing } from "@/lib/trends";
import { GrantSheet } from "../grant/GrantSheet";
import { grantUsable, useAssetPerpMarkets, useAssetPerpTicker, useGrant, useRuleDetail } from "../shared/data";
import { PageHeader, SectionTitle, StaleNote, useConfirm } from "../shared/kit";
import { EquityChart, StatsGrid } from "../shared/Performance";
import { closeReason, describeEvent, type EventTone, humanReason, ruleSentence, STATUS_LABEL, STATUS_TONE, trendLabel } from "../shared/rule-text";

type Position = Detail["positions"][number];
const LIVE = new Set(["opening", "open", "closing"]);
const at = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** /autopilot/[id]: one rule's status, open position, performance, history and audit log, with its controls. */
export default function RuleDetail({ id }: { id: number | null }) {
  const account = useAccount();
  const detail = useRuleDetail(account.authenticated ? id : null);

  if (!account.ready || (account.authenticated && id !== null && detail.isLoading) || (account.authenticated && !account.backendReady && id !== null)) return <DetailSkeleton />;
  if (!account.authenticated) {
    return (
      <div className="flex flex-col gap-8">
        <PageHeader title="Autopilot rule" back={{ href: "/autopilot", label: "Autopilot" }} />
        <Card>
          <Empty icon={<Fingerprint className="size-6" />} title="Sign in to see this rule" body="Rules are private to the account that made them." action={<Button onClick={account.login}>Sign in</Button>} />
        </Card>
      </div>
    );
  }
  if (id === null || (!detail.data && detail.error instanceof ApiError && detail.error.status === 404)) {
    return (
      <div className="flex flex-col gap-8">
        <PageHeader title="No such rule" back={{ href: "/autopilot", label: "Autopilot" }} description="It may belong to another account, or the link is wrong." />
        <Card>
          <Empty
            icon={<Bot className="size-6" />}
            title="This rule is not in your account"
            body="Your rules are listed on Autopilot. Or start a new one: write the trade as a sentence and backtest it first."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <ButtonLink href="/autopilot" tone="secondary">
                  Back to Autopilot
                </ButtonLink>
                <ButtonLink href="/autopilot/new">New rule</ButtonLink>
              </div>
            }
          />
        </Card>
      </div>
    );
  }
  if (!detail.data) {
    return (
      <div className="flex flex-col gap-8">
        <PageHeader title="Autopilot rule" back={{ href: "/autopilot", label: "Autopilot" }} />
        {detail.error ? <ErrorNote message={detail.error instanceof Error ? detail.error.message : "The rule could not load."} onRetry={() => void detail.refetch()} /> : <DetailSkeleton />}
      </div>
    );
  }
  return <Loaded d={detail.data} stale={detail.isRefetchError ? () => void detail.refetch() : null} />;
}

function Loaded({ d, stale }: { d: Detail; stale: (() => void) | null }) {
  const account = useAccount();
  const r = d.rule;
  const trends = useTrends();
  const qc = useQueryClient();
  const grant = useGrant();
  const confirm = useConfirm();
  const openSheet = useSheets((x) => x.open);
  const [grantOpen, setGrantOpen] = useState(false);
  const [needsBacktest, setNeedsBacktest] = useState(false);
  const trendName = trendLabel(r.rule.trend, trends.data?.trends);
  const live = d.positions.filter((p) => LIVE.has(p.status));
  const history = d.positions.filter((p) => !LIVE.has(p.status));
  const set = useMutation({
    // Resuming asks the passkey to approve this rule; pausing and stopping never prompt.
    mutationFn: (status: "enabled" | "paused" | "stopped") => (status === "enabled" ? autopilot.enable(r, account.approve) : autopilot.setStatus(r.id, status)),
    onSuccess: (_x, status) => {
      setNeedsBacktest(false);
      notify.success(status === "enabled" ? "Rule is running" : status === "paused" ? "Rule is paused" : "Rule is stopped");
    },
    onError: (e, status) => {
      const m = e instanceof ApiError ? e.message : "";
      if (/backtest/i.test(m)) setNeedsBacktest(true);
      else if (/grant/i.test(m)) setGrantOpen(true);
      else notify.error(`Could not ${status === "enabled" ? "resume" : status === "paused" ? "pause" : "stop"} the rule`, describeError(e));
    },
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: ["ap-rule"] }), qc.invalidateQueries({ queryKey: ["ap-rules"] })]),
  });
  const resume = () => (grantUsable(grant.data) ? set.mutate("enabled") : setGrantOpen(true));
  const s = r.status;
  const reason = r.statusReason;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        back={{ href: "/autopilot", label: "Autopilot" }}
        title={<span data-testid="rule-title">{r.rule.name}</span>}
        description={ruleSentence(r.rule, trendName)}
        action={
          <div className="flex flex-wrap gap-2" data-testid="rule-controls">
            {s === "enabled" ? (
              <Button size="lg" tone="secondary" icon={<CirclePause className="size-[18px]" aria-hidden />} loading={set.isPending && set.variables === "paused"} disabled={set.isPending} onClick={() => set.mutate("paused")} data-testid="rule-pause">
                Pause
              </Button>
            ) : s === "paused" ? (
              <>
                <Button size="lg" icon={<Fingerprint className="size-[18px]" aria-hidden />} loading={set.isPending && set.variables === "enabled"} disabled={set.isPending} onClick={resume} data-testid="rule-resume">
                  Resume
                </Button>
                <ButtonLink size="lg" tone="secondary" href={`/autopilot/new?edit=${r.id}`}>
                  <PenLine className="size-[18px]" aria-hidden />
                  Edit
                </ButtonLink>
              </>
            ) : s === "draft" ? (
              <ButtonLink size="lg" href={`/autopilot/new?edit=${r.id}`}>
                <FlaskConical className="size-[18px]" aria-hidden />
                Backtest and enable
              </ButtonLink>
            ) : (
              <ButtonLink size="lg" tone="secondary" href={`/autopilot/new?from=${r.id}`}>
                <Copy className="size-[18px]" aria-hidden />
                New rule from this
              </ButtonLink>
            )}
            {s !== "stopped" ? (
              <Button
                size="lg"
                tone={confirm.armed === "stop" ? "danger" : "ghost"}
                loading={set.isPending && set.variables === "stopped"}
                disabled={set.isPending}
                onBlur={confirm.disarm}
                onClick={() => confirm.confirm("stop") && set.mutate("stopped")}
                data-testid="rule-stop"
              >
                {confirm.armed === "stop" ? (live.length ? "Stop and close position" : s === "draft" ? "Discard draft" : "Stop for good") : s === "draft" ? "Discard" : "Stop"}
              </Button>
            ) : null}
          </div>
        }
      />

      {stale ? <StaleNote onRetry={stale} what="this rule" /> : null}
      <Card className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between" data-testid="rule-status" data-status={s}>
        <div className="flex min-w-0 flex-col items-start gap-3 sm:flex-row sm:items-center">
          <Badge tone={STATUS_TONE[s]} className="h-7 shrink-0 px-3 text-[12.5px]" icon={s === "enabled" ? <span className="live-dot size-1.5 rounded-full bg-up" aria-hidden /> : undefined}>
            {STATUS_LABEL[s]}
          </Badge>
          <p className="min-w-0 text-[13.5px] leading-5 text-text-2 [overflow-wrap:anywhere]">
            {s === "enabled"
              ? "Watching attention every minute. It opens a position when the entry fires and manages its exit."
              : s === "paused"
                ? `${reason && !/by owner$/.test(reason) ? `${humanReason(reason).text} ` : ""}Opens nothing new; an open position still exits on its stop or target.`
                : s === "draft"
                  ? "Not running. Backtest it, then enable it."
                  : "Stopped for good. Any open position was closed at the market price."}
          </p>
        </div>
        {s === "paused" && reason && humanReason(reason).needsFunds ? (
          <Button size="sm" className="shrink-0 self-start sm:self-auto" onClick={() => openSheet("deposit")}>
            Add funds
          </Button>
        ) : null}
        <dl className="flex shrink-0 gap-5 text-[12.5px]">
          <div>
            <dt className="text-text-3">Trend</dt>
            <dd>
              <Link href={`/t/${newestListing(trends.data?.trends ?? [], r.rule.trend)?.identifier ?? r.rule.trend}`} className="font-strong text-text hover:underline hover:underline-offset-4">
                {trendName}
              </Link>
            </dd>
          </div>
          <div>
            <dt className="text-text-3">Market</dt>
            <dd className="font-strong text-text">{r.rule.market} perp</dd>
          </div>
          <div>
            <dt className="text-text-3">Since</dt>
            <dd className="font-strong text-text">{new Date(r.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</dd>
          </div>
        </dl>
      </Card>
      {needsBacktest ? (
        <div className="flex flex-col gap-3 rounded-2xl bg-warn-soft px-4 py-3 sm:flex-row sm:items-center sm:justify-between" role="alert">
          <p className="text-[13.5px] leading-5 text-text">Backtests count for 24 hours. Run this rule&rsquo;s backtest again to resume it.</p>
          <ButtonLink size="sm" tone="secondary" href={`/autopilot/new?edit=${r.id}`}>
            Backtest again
          </ButtonLink>
        </div>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-6">
          <section aria-labelledby="pos-title" className="flex flex-col gap-3">
            <SectionTitle id="pos-title" title="Position now" />
            {live.length ? live.map((p) => <LivePosition key={p.id} p={p} stopPct={r.rule.exits.stopLossPct} targetPct={r.rule.exits.takeProfitPct} />) : <Card className="px-5 py-4 text-[13.5px] text-text-2">No open position{s === "enabled" ? ": waiting for the entry to fire." : "."}</Card>}
          </section>
          <section aria-labelledby="perf-title" className="flex flex-col gap-3">
            <SectionTitle id="perf-title" title="Performance" subtitle="Closed trades, after trading fees" />
            <Card className="flex flex-col gap-4 p-5">
              <StatsGrid stats={d.stats} wide />
              <EquityChart equity={d.equity} height={220} />
            </Card>
          </section>
          <section aria-labelledby="hist-title" className="flex flex-col gap-3">
            <SectionTitle id="hist-title" title="Positions" subtitle={history.length ? `${history.length} finished` : undefined} />
            {history.length ? (
              <ul className="divide-y divide-line overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface" data-testid="positions">
                {history.map((p) => (
                  <PositionRow key={p.id} p={p} />
                ))}
              </ul>
            ) : (
              <Card className="px-5 py-4 text-[13.5px] text-text-2">No finished positions yet.</Card>
            )}
          </section>
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <section aria-labelledby="log-title" className="flex flex-col gap-3">
            <SectionTitle id="log-title" title="Activity" subtitle="Every decision Autopilot made, newest first" />
            <Card className="p-5">
              <Timeline audit={d.audit} />
            </Card>
          </section>
          {d.backtest ? (
            <section aria-labelledby="bt-title" className="flex flex-col gap-3">
              <SectionTitle id="bt-title" title="Backtest it was enabled on" subtitle={new Date(d.backtest.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} />
              <Card className="flex flex-col gap-3 p-5">
                <StatsGrid stats={d.backtest.stats} />
                {d.backtest.warnings.length ? (
                  <ul className="flex list-disc flex-col gap-1 rounded-2xl bg-warn-soft py-3 pl-8 pr-4 text-[12.5px] leading-[18px] text-text">
                    {d.backtest.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                ) : null}
              </Card>
            </section>
          ) : null}
        </div>
      </div>
      <GrantSheet
        open={grantOpen}
        onOpenChange={setGrantOpen}
        reason="To resume this rule, Autopilot needs access to your account first."
        onGranted={() => {
          setGrantOpen(false);
          set.mutate("enabled");
        }}
      />
    </div>
  );
}

function LivePosition({ p, stopPct, targetPct }: { p: Position; stopPct: number; targetPct: number }) {
  const markets = useAssetPerpMarkets();
  const market = markets.data?.markets.find((m) => m.symbol === p.market);
  const ticker = useAssetPerpTicker(market?.id);
  const mark = ticker.data?.ticker.mark ?? null;
  const entry = p.entry_price;
  const long = p.side === "long";
  const upnl = mark !== null && entry !== null ? (long ? mark - entry : entry - mark) * p.size : null;
  const stop = entry !== null ? entry * (1 + ((long ? -1 : 1) * stopPct) / 100) : null;
  const target = entry !== null ? entry * (1 + ((long ? 1 : -1) * targetPct) / 100) : null;
  return (
    <Card className="flex flex-col gap-4 p-5" data-testid="live-position">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge tone={long ? "up" : "down"}>{long ? "Long" : "Short"}</Badge>
          <span className="font-strong text-[15px] text-text">
            {p.market} {p.leverage}x
          </span>
          {p.status !== "open" ? <Badge tone="warn">{p.status === "opening" ? "Opening" : "Closing"}</Badge> : null}
        </div>
        <div className="text-right">
          <p className="text-[11.5px] uppercase tracking-[0.08em] text-text-3">Unrealized</p>
          <p className={cn("num font-strong text-[18px]", upnl === null || Math.abs(upnl) < 0.005 ? "text-text" : upnl > 0 ? "text-up" : "text-down")}>{upnl === null ? "-" : `${usdc(upnl, { sign: true })}`}</p>
        </div>
      </div>
      <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <Row label="Entry" value={price(entry)} />
        <Row label="Mark" value={price(mark)} />
        <Row label="Size" value={`${p.size} ${p.market}`} />
        <Row label="Margin" value={`${usdc(p.margin_usdc)} USDC`} />
        <Row label="Stop" value={price(stop)} tone="down" />
        <Row label="Target" value={price(target)} tone="up" />
      </div>
      <p className="text-[12px] text-text-3">{p.opened_at ? `Opened ${ago(Date.parse(p.opened_at) / 1000)}` : "Order in flight"} · fees so far {usdc(p.fees_usdc)} USDC · before funding</p>
    </Card>
  );
}

function PositionRow({ p }: { p: Position }) {
  const pnl = p.pnl_usdc;
  const failed = p.status !== "closed";
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <Badge tone={p.side === "long" ? "up" : "down"} className="w-[52px] justify-center">
        {p.side === "long" ? "Long" : "Short"}
      </Badge>
      <div className="min-w-0 flex-1">
        <p className="num truncate text-[13.5px] text-text">
          {p.market} {p.leverage}x · {price(p.entry_price)} <span className="text-text-3">→</span> {price(p.exit_price)}
        </p>
        <p className="truncate text-[12px] text-text-3">
          {p.opened_at ? at(p.opened_at) : "Never opened"} · {failed ? p.status : closeReason(p.close_reason)}
        </p>
      </div>
      <span className={cn("num shrink-0 font-strong text-[14px]", pnl === null ? "text-text-3" : pnl > 0 ? "text-up" : pnl < 0 ? "text-down" : "text-text-2")}>{pnl === null ? "-" : usdc(pnl, { sign: true })}</span>
    </li>
  );
}

const DOT: Record<EventTone, string> = { neutral: "bg-line-strong", primary: "bg-primary", up: "bg-up", down: "bg-down", warn: "bg-warn" };

function Timeline({ audit }: { audit: Detail["audit"] }) {
  if (audit.length === 0) return <p className="text-[13.5px] text-text-2">Nothing yet.</p>;
  return (
    <ol className="relative flex flex-col" data-testid="audit-log">
      {audit.map((a, i) => {
        const e = describeEvent(a.event, a.detail);
        const last = i === audit.length - 1;
        return (
          <li key={a.id} className="relative flex gap-3 pb-4 last:pb-0" data-event={a.event}>
            {!last ? <span aria-hidden className="absolute bottom-0 left-[4.5px] top-4 w-px bg-line" /> : null}
            <span aria-hidden className={cn("relative mt-[6px] size-2.5 shrink-0 rounded-full ring-4 ring-[color:var(--surface)]", DOT[e.tone])} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <p className={cn("font-strong text-[13.5px] leading-5", e.tone === "down" ? "text-down" : e.tone === "warn" ? "text-warn" : "text-text")}>{e.title}</p>
                <time dateTime={a.at} title={new Date(a.at).toLocaleString()} className="shrink-0 text-[11.5px] text-text-3">
                  {ago(Date.parse(a.at) / 1000)}
                </time>
              </div>
              {e.body ? <p className="mt-0.5 text-[12.5px] leading-[18px] text-text-2 [overflow-wrap:anywhere]">{e.body}</p> : null}
              {e.tx ? (
                <ExplorerLink href={explorerTx(e.tx)} className="mt-1 text-[12px]" />
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-4 w-full max-w-2xl" />
      </div>
      <Skeleton className="h-[72px] rounded-[var(--radius-card)]" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-24 rounded-[var(--radius-card)]" />
          <Skeleton className="h-80 rounded-[var(--radius-card)]" />
        </div>
        <Skeleton className="h-96 rounded-[var(--radius-card)]" />
      </div>
    </div>
  );
}

