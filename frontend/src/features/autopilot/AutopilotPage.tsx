"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Bot, CirclePause, FlaskConical, Fingerprint, PenLine, Plus, ShieldCheck, Sparkles } from "lucide-react";
import { AnimatePresence, m } from "framer-motion";
import Link from "next/link";
import { useState } from "react";
import { FORWARD } from "@/components/shell/PageTransition";
import { Badge, Button, ButtonLink, Card, cn, Empty, ErrorNote, listItem, Skeleton } from "@/components/ui";
import { describeError, useAccount } from "@/lib/account/AccountProvider";
import { ApiError, autopilot, type RuleDetail, type StoredRule } from "@/lib/api";
import { ago, usdc } from "@/lib/format";
import { useTrends } from "@/lib/hooks/queries";
import { GrantCard } from "./grant/GrantCard";
import { GrantSheet } from "./grant/GrantSheet";
import { FollowSheet } from "@/features/copy/FollowSheet";
import { BOT_ADDRESS, grantUsable, useFollows, useGrant, useRuleDetails, useRules } from "./shared/data";
import { PageHeader, SectionTitle, StaleNote, useConfirm } from "./shared/kit";
import { LeaderCard } from "./shared/LeaderCard";
import { RiskNotes } from "./shared/RiskNotes";
import { useSheets } from "@/lib/sheets";
import { notify } from "@/lib/toast";
import { describeEvent, humanReason, ruleHeadline, STATUS_LABEL, STATUS_TONE, trendLabel } from "./shared/rule-text";

/** /autopilot: the account's rules with their kill switches, Autopilot's access, and the Tredio bot. */
export default function AutopilotPage() {
  const account = useAccount();
  if (!account.ready) return <PageSkeleton />;
  if (!account.authenticated) return <SignedOut />;
  return <SignedIn />;
}

function SignedIn() {
  const rules = useRules();
  const list = rules.data?.rules ?? [];
  const details = useRuleDetails(list.map((r) => r.id));
  const detailOf = new Map(details.map((d, i) => [list[i]?.id, d.data]));
  const running = list.filter((r) => r.status === "enabled");
  const follows = useFollows();
  const [followBot, setFollowBot] = useState(false);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const pauseAll = useMutation({
    mutationFn: () => Promise.all(running.map((r) => autopilot.setStatus(r.id, "paused"))),
    onSuccess: () => notify.success("Every rule is paused", "Open positions still exit on their stops and targets."),
    onError: (e) => notify.error("Some rules could not be paused", e instanceof ApiError ? e.message : "Try again."),
    onSettled: () => qc.invalidateQueries({ queryKey: ["ap-rules"] }).then(() => qc.invalidateQueries({ queryKey: ["ap-rule"] })),
  });

  return (
    <div className="flex flex-col gap-8 [font-feature-settings:'calt'_0]">
      <PageHeader
        title="Autopilot"
        description="Rules that trade asset perps when attention moves. Each one is backtested before it runs, trades inside your caps, and stops the moment you say so."
        action={
          <ButtonLink href="/autopilot/new" size="lg" data-testid="new-rule">
            <Plus className="size-[18px]" aria-hidden />
            New rule
          </ButtonLink>
        }
      />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section aria-labelledby="rules-title" className="flex min-w-0 flex-col gap-4">
          <SectionTitle
            id="rules-title"
            title="Your rules"
            subtitle={list.length ? `${running.length} running of ${list.length}` : undefined}
            action={
              running.length > 0 ? (
                <Button
                  size="sm"
                  tone={confirm.armed === "all" ? "danger" : "secondary"}
                  icon={<CirclePause className="size-4" aria-hidden />}
                  loading={pauseAll.isPending}
                  onBlur={confirm.disarm}
                  onClick={() => confirm.confirm("all") && pauseAll.mutate()}
                  data-testid="pause-all"
                >
                  {confirm.armed === "all" ? `Pause ${running.length} now` : "Pause all"}
                </Button>
              ) : null
            }
          />
          {rules.error ? rules.data ? <StaleNote onRetry={() => void rules.refetch()} what="your rules" /> : <ErrorNote message="Your rules could not load." onRetry={() => void rules.refetch()} /> : null}
          {rules.isLoading || (!rules.data && !rules.error) ? (
            <div className="flex flex-col gap-3">
              {[0, 1].map((i) => (
                <RuleRowSkeleton key={i} />
              ))}
            </div>
          ) : list.length === 0 ? (
            <Card>
              <Empty
                icon={<Sparkles className="size-6" />}
                title="No rules yet"
                body="Describe a trade in plain words, replay it on real history, then switch it on. Try: when attention on Ethereum rises 30% in an hour, go 2x long ETH."
                action={
                  <ButtonLink href="/autopilot/new">
                    Build your first rule
                  </ButtonLink>
                }
              />
            </Card>
          ) : (
            // Pausing, resuming or stopping a rule reshapes its row; the rows below glide, never jump.
            <ul className="relative flex flex-col gap-3" data-testid="rule-list">
              <AnimatePresence initial={false} mode="popLayout">
                {list.map((r) => (
                  <m.li key={r.id} {...listItem}>
                    <RuleRow rule={r} detail={detailOf.get(r.id)} />
                  </m.li>
                ))}
              </AnimatePresence>
            </ul>
          )}
        </section>
        <aside className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-24 lg:-m-1 lg:max-h-[calc(100dvh-7.5rem)] lg:overflow-y-auto lg:overscroll-contain lg:p-1">
          <GrantCard />
          <LeaderCard
            account={BOT_ADDRESS}
            href={`/c/${BOT_ADDRESS}`}
            featured
            subtitle="Public Autopilot rules on asset perps"
            following={(follows.data?.follows ?? []).some((f) => f.leader === BOT_ADDRESS)}
            onFollow={() => setFollowBot(true)}
          />
          <FollowSheet leader={BOT_ADDRESS} open={followBot} onOpenChange={setFollowBot} />
          <Link href="/copy" className="group flex items-center justify-between gap-3 rounded-2xl border border-line px-4 py-3 text-[13.5px] text-text-2 transition-colors hover:border-line-strong hover:text-text">
            Rather follow a trader than write rules?
            <span className="flex items-center gap-1 font-strong text-text">
              Copy
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
            </span>
          </Link>
        </aside>
      </div>
    </div>
  );
}

const positionOpen = (d: RuleDetail | undefined) => d?.positions.find((p) => p.status === "open" || p.status === "opening" || p.status === "closing");

function RuleRow({ rule, detail }: { rule: StoredRule; detail: RuleDetail | undefined }) {
  const account = useAccount();
  const trends = useTrends();
  const qc = useQueryClient();
  const grant = useGrant();
  const confirm = useConfirm();
  const openSheet = useSheets((x) => x.open);
  const [needs, setNeeds] = useState<"backtest" | "grant" | null>(null);
  const [grantOpen, setGrantOpen] = useState(false);
  const set = useMutation({
    // Resuming asks the passkey to approve this rule; pausing and stopping never prompt.
    mutationFn: (status: "enabled" | "paused" | "stopped") => (status === "enabled" ? autopilot.enable(rule, account.approve) : autopilot.setStatus(rule.id, status)),
    onSuccess: (_r, status) => {
      setNeeds(null);
      notify.success(status === "enabled" ? `${rule.rule.name} is running` : status === "paused" ? `${rule.rule.name} is paused` : `${rule.rule.name} is stopped`);
    },
    onError: (e, status) => {
      const m = e instanceof ApiError ? e.message : "";
      if (/backtest/i.test(m)) setNeeds("backtest");
      else if (/grant/i.test(m)) setNeeds("grant");
      else notify.error(`Could not ${status === "enabled" ? "resume" : status === "paused" ? "pause" : "stop"} ${rule.rule.name}`, describeError(e));
    },
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: ["ap-rules"] }), qc.invalidateQueries({ queryKey: ["ap-rule"] })]),
  });
  const resume = () => {
    if (!grantUsable(grant.data)) {
      setGrantOpen(true);
      return;
    }
    set.mutate("enabled");
  };
  const pos = positionOpen(detail);
  const last = detail?.audit[0];
  const lastEvent = last ? describeEvent(last.event, last.detail) : null;
  const pnl = detail?.stats.pnlUsdc;
  const s = rule.status;
  const ownReason = rule.statusReason && !/by owner$/.test(rule.statusReason) ? rule.statusReason : null;

  return (
    <article className="rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-card sm:p-5" data-testid="rule-row" data-rule-id={rule.id} data-status={s}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/autopilot/${rule.id}`} transitionTypes={FORWARD} className="truncate font-strong text-[15.5px] leading-6 text-text hover:underline hover:underline-offset-4">
              {rule.rule.name}
            </Link>
            <Badge tone={STATUS_TONE[s]} icon={s === "enabled" ? <span className="live-dot size-1.5 rounded-full bg-up" aria-hidden /> : undefined}>
              {STATUS_LABEL[s]}
            </Badge>
          </div>
          <p className="mt-1 text-[13px] leading-5 text-text-2">
            {ruleHeadline(rule.rule)}
            <span className="text-text-3"> · {trendLabel(rule.rule.trend, trends.data?.trends)}</span>
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[11.5px] uppercase tracking-[0.08em] text-text-3">PnL</p>
          {s === "draft" ? (
            <p className="num mt-0.5 font-strong text-[16px] text-text-3">-</p>
          ) : detail ? (
            <p className={cn("num mt-0.5 font-strong text-[16px]", !pnl ? "text-text" : pnl > 0 ? "text-up" : "text-down")}>{usdc(pnl, { sign: true })}</p>
          ) : (
            <Skeleton className="ml-auto mt-1 h-5 w-14" />
          )}
        </div>
      </div>
      <div className="mt-3 flex min-h-5 items-center gap-2 text-[12.5px] leading-5 text-text-3">
        {pos ? (
          <>
            <span className={cn("size-1.5 shrink-0 rounded-full", pos.side === "long" ? "bg-up" : "bg-down")} aria-hidden />
            <span className="min-w-0 truncate text-text-2">
              In a {pos.leverage}x {pos.side} on {pos.market}
              {pos.opened_at ? ` since ${ago(Date.parse(pos.opened_at) / 1000)}` : pos.status === "opening" ? ", opening" : ""}
            </span>
          </>
        ) : ownReason ? (
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-warn">
            <span className="min-w-0">{humanReason(ownReason).text}</span>
            {humanReason(ownReason).needsFunds ? (
              <button type="button" onClick={() => openSheet("deposit")} className="font-strong text-primary underline-offset-2 hover:underline">
                Add funds
              </button>
            ) : null}
          </span>
        ) : lastEvent && last ? (
          <span className="min-w-0 truncate">
            <span className="text-text-2">{lastEvent.title}</span>
            {lastEvent.body ? `: ${lastEvent.body}` : ""} · {ago(Date.parse(last.at) / 1000)}
          </span>
        ) : detail ? (
          <span>{s === "draft" ? "Not running yet" : "No activity yet"}</span>
        ) : (
          <Skeleton className="h-4 w-48" />
        )}
      </div>
      {needs ? (
        <p className="mt-3 rounded-xl bg-warn-soft px-3 py-2 text-[12.5px] leading-5 text-text" role="alert">
          {needs === "backtest" ? (
            <>
              Backtests count for 24 hours. <Link href={`/autopilot/new?edit=${rule.id}`} className="font-strong underline underline-offset-2">Backtest this rule again</Link> to resume it.
            </>
          ) : (
            "Autopilot needs access to your account first."
          )}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-3">
        {s === "enabled" ? (
          <Button size="sm" tone="secondary" icon={<CirclePause className="size-4" aria-hidden />} loading={set.isPending && set.variables === "paused"} disabled={set.isPending} onClick={() => set.mutate("paused")} data-testid="rule-pause">
            Pause
          </Button>
        ) : s === "paused" ? (
          <>
            <Button size="sm" tone="secondary" icon={<Fingerprint className="size-4" aria-hidden />} loading={set.isPending && set.variables === "enabled"} disabled={set.isPending} onClick={resume} data-testid="rule-resume">
              Resume
            </Button>
            <ButtonLink size="sm" tone="ghost" href={`/autopilot/new?edit=${rule.id}`}>
              <PenLine className="size-4" aria-hidden />
              Edit
            </ButtonLink>
          </>
        ) : s === "draft" ? (
          <ButtonLink size="sm" tone="secondary" href={`/autopilot/new?edit=${rule.id}`}>
            <FlaskConical className="size-4" aria-hidden />
            Backtest and enable
          </ButtonLink>
        ) : null}
        {s !== "stopped" ? (
          <Button
            size="sm"
            tone={confirm.armed === "stop" ? "danger" : "ghost"}
            className="ml-auto"
            loading={set.isPending && set.variables === "stopped"}
            disabled={set.isPending}
            onBlur={confirm.disarm}
            onClick={() => confirm.confirm("stop") && set.mutate("stopped")}
            data-testid="rule-stop"
          >
            {confirm.armed === "stop" ? (s === "draft" ? "Discard draft" : pos ? "Stop and close position" : "Stop for good") : s === "draft" ? "Discard" : "Stop"}
          </Button>
        ) : null}
        <Link href={`/autopilot/${rule.id}`} className={cn("hidden h-8 items-center gap-1 rounded-[10px] px-2 font-strong text-[13px] text-text-2 transition-colors hover:text-text sm:flex", s === "stopped" ? "ml-auto" : "")}>
          Details
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
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
    </article>
  );
}

function RuleRowSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-5">
      <Skeleton className="h-5 w-44" />
      <Skeleton className="h-4 w-72 max-w-full" />
      <Skeleton className="h-4 w-56 max-w-full" />
      <div className="flex gap-2 border-t border-line pt-3">
        <Skeleton className="h-8 w-20" />
        <Skeleton className="h-8 w-16" />
      </div>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-busy>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-3">
          <RuleRowSkeleton />
          <RuleRowSkeleton />
        </div>
        <Skeleton className="h-64 rounded-[var(--radius-card)]" />
      </div>
    </div>
  );
}

const STEPS = [
  {
    icon: PenLine,
    title: "Write it in plain words",
    body: "When attention on Ethereum rises 30% within an hour and smart money is buying, open a 2x long on ETH with 20 USDC.",
  },
  {
    icon: FlaskConical,
    title: "Replay it on real history",
    body: "Up to 30 days of the trend's attention and asset perp prices, with fees and slippage, before it can run.",
  },
  {
    icon: ShieldCheck,
    title: "Switch it on, inside caps",
    body: "Asset-perps-only access with a daily cap, a stop on every trade and a daily loss limit. Pause or stop it any time.",
  },
] as const;

function SignedOut() {
  const account = useAccount();
  return (
    <div className="flex flex-col gap-8">
      <section className="relative overflow-hidden rounded-[24px] border border-line bg-surface px-6 py-8 sm:px-10 sm:py-10">
        <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-primary-soft blur-3xl" />
        <p className="flex items-center gap-2 font-strong text-[12px] uppercase tracking-[0.14em] text-primary">
          <Bot className="size-4" aria-hidden />
          Autopilot
        </p>
        <h1 className="mt-3 max-w-xl font-display text-[34px] leading-[1.08] text-text sm:text-[44px]">Let attention trade for you.</h1>
        <p className="mt-3 max-w-xl text-[15px] leading-6 text-text-2">
          Turn a hunch about the narrative into a rule that trades asset perps on its own: when a trend&rsquo;s attention moves, Autopilot opens the position and manages its exit.
        </p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button size="lg" icon={<Fingerprint className="size-[18px]" aria-hidden />} onClick={account.login}>
            Sign in to build a rule
          </Button>
          <ButtonLink size="lg" tone="secondary" href={`/c/${BOT_ADDRESS}`}>
            See the Tredio bot
          </ButtonLink>
        </div>
      </section>
      <ol className="grid gap-4 md:grid-cols-3">
        {STEPS.map(({ icon: Icon, title, body }, i) => (
          <li key={title} className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-5">
            <div className="flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-xl bg-primary-soft text-primary">
                <Icon className="size-[18px]" aria-hidden />
              </span>
              <span className="num font-strong text-[12px] text-text-3">Step {i + 1}</span>
            </div>
            <h2 className="font-strong text-[15px] text-text">{title}</h2>
            <p className="text-[13.5px] leading-5 text-text-2">{body}</p>
          </li>
        ))}
      </ol>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="order-2 p-5 lg:order-1">
          <SectionTitle title="Before you switch anything on" />
          <RiskNotes className="mt-3" />
        </Card>
        <LeaderCard account={BOT_ADDRESS} href={`/c/${BOT_ADDRESS}`} featured subtitle="Public Autopilot rules on asset perps" className="order-1 lg:order-2" />
      </div>
    </div>
  );
}
