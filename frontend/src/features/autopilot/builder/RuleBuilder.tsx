"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { isAutopilotMarket } from "@tredio/autopilot";
import { AlertTriangle, CircleAlert, FlaskConical, Fingerprint, Info, Save, WandSparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, cn, Empty, ErrorNote, Field, Segmented, Skeleton } from "@/components/ui";
import { describeError, useAccount } from "@/lib/account/AccountProvider";
import { ApiError, autopilot, type BacktestResult, type StoredRule, type Trend } from "@/lib/api";
import { ago, usdc } from "@/lib/format";
import { useTrends } from "@/lib/hooks/queries";
import { notify } from "@/lib/toast";
import { baseIdentifier, newestListing, trendName } from "@/lib/trends";
import { GrantSheet } from "../grant/GrantSheet";
import { grantUsable, useGrant, useAssetPerpMarkets, useRuleDetail } from "../shared/data";
import { ChoicePill, NumberPill, PageHeader, SelectPill } from "../shared/kit";
import { EquityChart, StatsGrid, TradeList } from "../shared/Performance";
import { RiskNotes } from "../shared/RiskNotes";
import { duration, trendLabel } from "../shared/rule-text";
import { autoName, DEFAULT_DRAFT, type Draft, draftFromRule, HOLDS, keyOf, LABEL, liveDefault, loosenTrigger, type Parsed, parseDraft, readableWarning, WINDOWS } from "./rule-form";

/** Rules trade through the account's Autopilot session, whose account contract caps Hyperliquid leverage. */
const SESSION_MAX_LEVERAGE = 10;

/**
 * The rule builder: a rule written as sentences with inline controls, validated by the server's own
 * schema, replayed on real history, saved as a draft and enabled (granting Autopilot access first
 * when it has none).
 */
export default function RuleBuilder({ editId, fromId, trend }: { editId: number | null; fromId: number | null; trend: string | null }) {
  const account = useAccount();
  const sourceId = editId ?? fromId;
  const source = useRuleDetail(account.authenticated ? sourceId : null);
  const trends = useTrends();
  const markets = useAssetPerpMarkets();
  // A new rule with no trend given starts on a live trend Hyperliquid lists, so it needs both lists first.
  const pickDefault = sourceId === null && !trend;

  if (
    !account.ready ||
    (account.authenticated && sourceId !== null && (source.isLoading || (!source.data && !source.error))) ||
    (account.authenticated && pickDefault && (trends.isLoading || markets.isLoading))
  )
    return <BuilderSkeleton />;
  if (!account.authenticated) {
    return (
      <div className="flex flex-col gap-8">
        <PageHeader title="New rule" back={{ href: "/autopilot", label: "Autopilot" }} />
        <Card>
          <Empty
            icon={<Fingerprint className="size-6" />}
            title="Sign in to build a rule"
            body="Rules belong to your passkey account and trade from it. Tredio covers the gas."
            action={<Button onClick={account.login}>Sign in</Button>}
          />
        </Card>
      </div>
    );
  }
  if (sourceId !== null && !source.data && source.error) {
    return (
      <div className="flex flex-col gap-8">
        <PageHeader title="Rule not found" back={{ href: "/autopilot", label: "Autopilot" }} />
        <ErrorNote message={source.error instanceof ApiError ? source.error.message : "The rule could not load."} onRetry={() => void source.refetch()} />
      </div>
    );
  }
  const stored = source.data?.rule ?? null;
  // Stopped rules never change; editing one starts a new rule from it.
  const editing = editId !== null && stored && stored.status !== "stopped" ? stored : null;
  const initial: Draft = stored
    ? { ...draftFromRule(stored.rule), name: editing ? stored.rule.name : `${stored.rule.name} (copy)`.slice(0, 60) }
    : { ...DEFAULT_DRAFT, ...(trend ? { trend } : liveDefault(trends.data?.trends ?? [], (markets.data?.markets ?? []).map((m) => m.symbol).filter(isAutopilotMarket))) };
  // Keyed by the source only: saving or refetching the rule keeps the form and its backtest.
  return <Builder key={sourceId ?? "new"} initial={initial} editing={editing} />;
}

interface RunResult {
  key: string;
  days: number;
  at: number;
  result: BacktestResult & { resolutionSec: number };
}

/** Seconds now, for stamping a backtest when it returns (outside render). */
const nowSec = () => Math.floor(Date.now() / 1000);

const DAYS = [
  { value: "1", label: "1d" },
  { value: "3", label: "3d" },
  { value: "7", label: "7d" },
  { value: "14", label: "14d" },
  { value: "30", label: "30d" },
] as const;
type Days = (typeof DAYS)[number]["value"];

function Builder({ initial, editing }: { initial: Draft; editing: StoredRule | null }) {
  const account = useAccount();
  const router = useRouter();
  const qc = useQueryClient();
  const trends = useTrends();
  const markets = useAssetPerpMarkets();
  const grant = useGrant();
  const [d, setD] = useState<Draft>(initial);
  const [saved, setSaved] = useState<{ id: number; key: string | null; ruleHash: string } | null>(editing ? { id: editing.id, key: keyOf(editing.rule), ruleHash: editing.ruleHash } : null);
  const [days, setDays] = useState<Days>("7");
  const [run, setRun] = useState<RunResult | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setActionError(null);
    setD((x) => ({ ...x, [k]: v }));
  };

  // Autopilot trades only the markets Tredio's oracle always marks for the account's order guard.
  const marketList = useMemo(() => (markets.data?.markets ?? []).filter((m) => isAutopilotMarket(m.symbol)), [markets.data]);
  const market = marketList.find((m) => m.symbol === d.market);
  const topicName = trendLabel(d.trend, trends.data?.trends);
  const fallbackName = autoName(d, topicName);
  const limits = { maxLeverage: market?.maxLeverage ?? null, sessionMaxLeverage: SESSION_MAX_LEVERAGE, maintenanceMargin: market?.maintenanceMargin ?? null };
  // Memoized by the React Compiler, like the rest of this component.
  const parsed = parseDraft(d, fallbackName, limits);
  const backtestCard = useRef<HTMLDivElement>(null);
  const err = (k: keyof Draft) => (showErrors || touchedValue(d, initial, k) ? parsed.errors[k] : undefined);
  const backtestCurrent = run !== null && run.key === parsed.key;
  const dirty = parsed.key === null || saved?.key !== parsed.key;
  const running = editing?.status === "enabled";

  // Runs the form's rule, or the one given (a loosened trigger, before the form re-renders with it).
  const backtest = useMutation({
    mutationFn: async (given?: Parsed) => {
      const p = given ?? parsed;
      if (!p.rule || !p.key) throw new Error("Fix the highlighted fields first.");
      const key = p.key;
      const n = Number(days);
      const r = await autopilot.backtest(p.rule, n);
      return { key, days: n, at: nowSec(), result: r.result } satisfies RunResult;
    },
    onSuccess: (r) => setRun(r),
  });

  const ensureSaved = async (): Promise<{ id: number; ruleHash: string }> => {
    if (!parsed.rule) throw new Error("Fix the highlighted fields first.");
    if (saved && saved.key === parsed.key) return saved;
    const res = saved ? await autopilot.update(saved.id, parsed.rule) : await autopilot.create(parsed.rule);
    const next = { id: res.rule.id, key: keyOf(res.rule.rule), ruleHash: res.rule.ruleHash };
    setSaved(next);
    await qc.invalidateQueries({ queryKey: ["ap-rules"] });
    await qc.invalidateQueries({ queryKey: ["ap-rule"] });
    return next;
  };

  const save = useMutation({
    mutationFn: async () => (await ensureSaved()).id,
    onSuccess: (id) => {
      notify.success("Draft saved", "Backtest it, then enable it when it looks right.");
      // The address now names the draft, so a reload edits it; the form stays as it is.
      if (!editing) window.history.replaceState(null, "", `/autopilot/new?edit=${id}`);
    },
    onError: (e) => setActionError(e instanceof ApiError || e instanceof Error ? e.message : "The rule could not be saved."),
  });

  const enable = useMutation({
    mutationFn: async () => {
      const rule = await ensureSaved();
      // One passkey prompt approves exactly this saved rule.
      await autopilot.enable(rule, account.approve);
      // The detail page must not open on the cached draft.
      await Promise.all([qc.invalidateQueries({ queryKey: ["ap-rules"] }), qc.invalidateQueries({ queryKey: ["ap-rule"] })]);
      return rule.id;
    },
    onSuccess: (id) => {
      notify.success("Rule is running", "Autopilot watches its trigger around the clock.");
      router.push(`/autopilot/${id}`);
    },
    onError: (e) => {
      const m = e instanceof ApiError ? e.message : "";
      if (/grant/i.test(m)) setGrantOpen(true);
      else setActionError(describeError(e));
    },
  });

  const pause = useMutation({
    mutationFn: () => autopilot.setStatus(editing!.id, "paused"),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["ap-rule"] });
      await qc.invalidateQueries({ queryKey: ["ap-rules"] });
    },
  });

  const tryEnable = () => {
    setActionError(null);
    if (!parsed.rule) {
      setShowErrors(true);
      return;
    }
    if (!backtestCurrent) {
      setActionError("Run a backtest of this exact rule first. Any change to the rule needs a new one.");
      return;
    }
    // Backtests count for 24 hours on the server.
    if (Date.now() / 1000 - run.at > 23.5 * 3600) {
      setActionError("That backtest is almost a day old. Run it again to enable.");
      return;
    }
    if (!grantUsable(grant.data)) {
      setGrantOpen(true);
      return;
    }
    enable.mutate();
  };

  const runBacktest = () => {
    setShowErrors(true);
    if (parsed.rule) backtest.mutate(undefined);
  };
  // A rule that never fired gets one looser trigger to try, applied and replayed in one click.
  const looser = loosenTrigger(d);
  const loosen = () => {
    if (!looser) return;
    setActionError(null);
    setD(looser.draft);
    const p = parseDraft(looser.draft, autoName(looser.draft, topicName), limits);
    if (p.rule) backtest.mutate(p);
  };

  const trendOptions = useMemo(() => trendChoices(trends.data?.trends ?? [], new Set(marketList.map((m) => m.symbol)), d.trend), [trends.data, marketList, d.trend]);
  const marketOptions = marketList.map((m) => ({ value: m.symbol, label: `${m.symbol} · up to ${Math.min(m.maxLeverage, SESSION_MAX_LEVERAGE)}x` }));
  // The rule's own market stays shown (before the list loads, or a rule saved on a market Autopilot no longer trades, which the form flags).
  if (!marketOptions.some((o) => o.value === d.market)) marketOptions.unshift({ value: d.market, label: d.market });
  const lev = Number(d.leverage);
  const margin = Number(d.margin);
  const notional = Number.isFinite(lev * margin) ? lev * margin : null;
  const sl = Number(d.stopLoss);
  const tp = Number(d.takeProfit);
  const busy = save.isPending || enable.isPending;
  const sectionErrors = (keys: Array<keyof Draft>) => keys.map((k) => (err(k) ? { k, m: err(k)! } : null)).filter((x): x is { k: keyof Draft; m: string } => x !== null);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        back={{ href: editing ? `/autopilot/${editing.id}` : "/autopilot", label: editing ? editing.rule.name : "Autopilot" }}
        title={editing ? "Edit rule" : "New rule"}
        description="Write the trade as you would say it. Every control is part of the sentence; the backtest replays exactly this rule before it can run."
      />
      {running ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-[color:var(--warn-soft)] bg-warn-soft px-4 py-3 sm:flex-row sm:items-center sm:justify-between" role="status">
          <p className="text-[13.5px] leading-5 text-text">This rule is running. Pause it to change it; its open position keeps its stop and target.</p>
          <Button size="sm" tone="secondary" loading={pause.isPending} onClick={() => pause.mutate()}>
            Pause to edit
          </Button>
        </div>
      ) : null}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_400px] xl:grid-cols-[minmax(0,1fr)_440px]">
        <fieldset disabled={running || busy} className="flex min-w-0 flex-col gap-4 disabled:opacity-60" data-testid="rule-form">
          <legend className="sr-only">Rule</legend>
          <Card className="p-5">
            <Field label="Name" placeholder={fallbackName} value={d.name} onChange={(e) => set("name", e.target.value)} maxLength={60} error={err("name")} hint="Leave empty to use the suggestion." data-testid="rule-name" />
          </Card>
          <Sentence step="When" errors={sectionErrors(["trend", "change", "minIndex"])} hint={trendHint(d, trends.data?.trends ?? [], marketList.map((m) => m.symbol))}>
            When attention on <SelectPill label="Trend" value={d.trend} options={trendOptions} onChange={(v) => changeTrend(v)} invalid={Boolean(err("trend"))} testId="rule-trend" className="max-w-[min(100%,280px)]" />{" "}
            <ChoicePill
              label="Direction"
              value={d.direction}
              onChange={(v) => set("direction", v)}
              options={[
                { value: "up", label: "rises" },
                { value: "down", label: "falls" },
              ]}
            />{" "}
            by <NumberPill label="Attention change in percent" value={d.change} onChange={(v) => set("change", v)} suffix="%" width={3} invalid={Boolean(err("change"))} testId="rule-change" /> within{" "}
            <SelectPill label="Window" value={d.windowMin} onChange={(v) => set("windowMin", v)} options={WINDOWS.map((w) => ({ value: w, label: duration(w) }))} />, while the index is at least{" "}
            <NumberPill label="Minimum attention index" value={d.minIndex} onChange={(v) => set("minIndex", v)} width={2} invalid={Boolean(err("minIndex"))} /> and smart money is{" "}
            <ChoicePill
              label="Smart money"
              value={d.smartMoney}
              onChange={(v) => set("smartMoney", v)}
              options={[
                { value: "any", label: "ignored" },
                { value: "buying", label: "buying" },
                { value: "selling", label: "selling" },
              ]}
            />
            .
          </Sentence>
          <Sentence
            step="Then"
            errors={sectionErrors(["margin", "leverage", "market"])}
            hint={notional !== null && notional > 0 && lev >= 1 ? `A ${usdc(notional)} USDC position. A move of about ${liquidationMove(lev, market?.maintenanceMargin)}% against it would liquidate it.` : undefined}
          >
            Open a <NumberPill label="Leverage" value={d.leverage} onChange={(v) => set("leverage", v)} suffix="x" width={2} invalid={Boolean(err("leverage"))} testId="rule-leverage" />{" "}
            <ChoicePill
              label="Side"
              value={d.side}
              onChange={(v) => set("side", v)}
              options={[
                { value: "long", label: "long", tone: "up" },
                { value: "short", label: "short", tone: "down" },
              ]}
              testId="rule-side"
            />{" "}
            on <SelectPill label="Hyperliquid market" value={d.market} onChange={(v) => set("market", v)} options={marketOptions} invalid={Boolean(err("market"))} testId="rule-market" /> with{" "}
            <NumberPill label="Margin in USDC" value={d.margin} onChange={(v) => set("margin", v)} suffix="USDC" width={3} invalid={Boolean(err("margin"))} testId="rule-margin" /> margin.
          </Sentence>
          <Sentence
            step="Exit"
            errors={sectionErrors(["stopLoss", "takeProfit"])}
            hint={
              Number.isFinite(sl * tp * lev * margin) && lev > 0
                ? `On the margin that is about ${usdc(-(margin * sl * lev) / 100)} / ${usdc((margin * tp * lev) / 100, { sign: true })} USDC (${(-sl * lev).toFixed(0)}% / +${(tp * lev).toFixed(0)}%) before fees.`
                : undefined
            }
          >
            Close when the price moves <NumberPill label="Stop loss in percent" value={d.stopLoss} onChange={(v) => set("stopLoss", v)} suffix="%" width={2} invalid={Boolean(err("stopLoss"))} testId="rule-stop" /> against the position or{" "}
            <NumberPill label="Take profit in percent" value={d.takeProfit} onChange={(v) => set("takeProfit", v)} suffix="%" width={2} invalid={Boolean(err("takeProfit"))} testId="rule-target" /> in its favor, or after{" "}
            <SelectPill label="Time limit" value={d.maxHoldMin} onChange={(v) => set("maxHoldMin", v)} options={HOLDS.map((h) => ({ value: h, label: h === 0 ? "no time limit" : duration(h) }))} />.
          </Sentence>
          <Sentence step="Limits" errors={sectionErrors(["maxPosition", "maxDailyLoss", "cooldown"])}>
            Never hold more than <NumberPill label="Maximum position in USDC" value={d.maxPosition} onChange={(v) => set("maxPosition", v)} suffix="USDC" width={3} invalid={Boolean(err("maxPosition"))} testId="rule-max-position" /> in one position, stop for the
            day after losing <NumberPill label="Daily loss limit in USDC" value={d.maxDailyLoss} onChange={(v) => set("maxDailyLoss", v)} suffix="USDC" width={3} invalid={Boolean(err("maxDailyLoss"))} testId="rule-daily-loss" />, and wait{" "}
            <NumberPill label="Cooldown in minutes" value={d.cooldown} onChange={(v) => set("cooldown", v)} suffix="min" width={2} invalid={Boolean(err("cooldown"))} decimals={false} /> between trades.
          </Sentence>
          <Card className="p-5">
            <h2 className="font-strong text-[15px] text-text">Before you enable it</h2>
            <RiskNotes leverage={Number.isFinite(lev) ? lev : undefined} maintenanceMargin={market?.maintenanceMargin} className="mt-3" />
          </Card>
        </fieldset>

        <div ref={backtestCard} className="flex min-w-0 scroll-mt-20 flex-col gap-4 lg:sticky lg:top-24 lg:-m-1 lg:max-h-[calc(100dvh-7.5rem)] lg:overflow-y-auto lg:overscroll-contain lg:p-1">
          <BacktestCard
            days={days}
            setDays={setDays}
            run={run}
            current={backtestCurrent}
            valid={parsed.rule !== null}
            pending={backtest.isPending}
            error={backtest.error ? (backtest.error instanceof Error ? backtest.error.message : "The backtest failed.") : null}
            onRun={runBacktest}
            market={d.market}
            loosen={looser && !running ? { label: looser.changes.join(", "), run: loosen } : null}
          />
          <Card className="flex flex-col gap-4 p-5" data-testid="rule-actions">
            <ReadyLine valid={parsed.rule !== null} run={run} current={backtestCurrent} dirty={dirty} saved={saved !== null} />
            {actionError ? <ErrorNote message={actionError} /> : null}
            <div className="grid grid-cols-2 gap-2">
              <Button tone="secondary" size="lg" icon={<Save className="size-[18px]" aria-hidden />} loading={save.isPending} disabled={running || enable.isPending || (!dirty && saved !== null)} onClick={() => (parsed.rule ? save.mutate() : setShowErrors(true))} data-testid="rule-save">
                {saved && !dirty ? "Saved" : "Save draft"}
              </Button>
              <Button size="lg" icon={<Fingerprint className="size-[18px]" aria-hidden />} loading={enable.isPending} disabled={running || save.isPending || !backtestCurrent} onClick={tryEnable} data-testid="rule-enable">
                Enable
              </Button>
            </div>
            <p className="text-[12px] leading-4 text-text-3">
              {grantUsable(grant.data) ? "Your passkey approves this rule, then it starts at once." : "Your passkey grants Autopilot access, then approves this rule."}
            </p>
          </Card>
        </div>
      </div>
      {/* Phones and tablets: the two actions stay in reach above the bottom nav while the sentence scrolls. */}
      <div aria-hidden className="h-[60px] lg:hidden" />
      <div className="fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+64px)] z-30 border-t border-line bg-[color-mix(in_srgb,var(--bg)_92%,transparent)] px-4 py-2.5 backdrop-blur-xl lg:hidden" data-testid="rule-action-bar">
        <div className="mx-auto grid max-w-md grid-cols-2 gap-2">
          <Button
            tone="secondary"
            icon={<FlaskConical className="size-4" aria-hidden />}
            loading={backtest.isPending}
            disabled={running || parsed.rule === null}
            onClick={() => {
              runBacktest();
              backtestCard.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
            }}
            data-testid="bar-backtest"
          >
            {run ? "Backtest again" : "Backtest"}
          </Button>
          <Button icon={<Fingerprint className="size-4" aria-hidden />} loading={enable.isPending} disabled={running || save.isPending || !backtestCurrent} onClick={tryEnable} data-testid="bar-enable">
            Enable
          </Button>
        </div>
      </div>
      <GrantSheet
        open={grantOpen}
        onOpenChange={setGrantOpen}
        reason="To run this rule, Autopilot needs access to your account. Approve it with your passkey, then approve the rule."
        onGranted={() => {
          setGrantOpen(false);
          enable.mutate();
        }}
      />
    </div>
  );

  function changeTrend(identifier: string) {
    const t = newestListing(trends.data?.trends ?? [], identifier);
    const symbols = new Set(marketList.map((m) => m.symbol));
    setActionError(null);
    setD((x) => ({ ...x, trend: baseIdentifier(identifier), market: t?.ticker && symbols.has(t.ticker) ? t.ticker : x.market }));
  }
}

/** Price move against a position that reaches the market's maintenance margin, in percent. */
export function liquidationMove(leverage: number, maintenanceMargin = 0): string {
  const v = Math.max(0, (1 / leverage - maintenanceMargin) * 100);
  return v >= 10 ? v.toFixed(0) : v.toFixed(1);
}

/** A field counts as touched once it differs from where it started. */
function touchedValue(d: Draft, initial: Draft, k: keyof Draft) {
  return d[k] !== initial[k];
}

/** Rules name a topic by its base identifier; the backend and executor follow its newest listing. */
function trendChoices(list: Trend[], tradable: Set<string>, current: string) {
  const topics = [...new Set(list.map((t) => baseIdentifier(t.identifier)))].map((base) => newestListing(list, base)!);
  const live = topics.sort((a, b) => b.index - a.index);
  const lists = live.filter((t) => t.ticker && tradable.has(t.ticker));
  const others = live.filter((t) => !(t.ticker && tradable.has(t.ticker)));
  const options = [
    ...lists.map((t) => ({ value: baseIdentifier(t.identifier), label: trendName(t), group: "Autopilot trades its coin" })),
    ...others.map((t) => ({ value: baseIdentifier(t.identifier), label: trendName(t), group: "Other live trends" })),
  ];
  const chosen = baseIdentifier(current);
  if (!options.some((o) => o.value === chosen)) options.unshift({ value: current, label: current, group: "Autopilot trades its coin" });
  return options;
}

function trendHint(d: Draft, list: Trend[], symbols: string[]): string | undefined {
  const t = newestListing(list, d.trend);
  if (!t) return list.length ? "This trend is not live right now; the rule waits until it is." : undefined;
  const name = trendName(t);
  if (t.ticker && symbols.includes(t.ticker)) return t.ticker === d.market ? `${name} is at ${t.index.toFixed(1)} points; the rule trades its own coin on Hyperliquid.` : `${name} is at ${t.index.toFixed(1)} points. Its coin ${t.ticker} trades on Hyperliquid too.`;
  return `${name} is at ${t.index.toFixed(1)} points. Its attention drives a trade on ${d.market}.`;
}

function Sentence({ step, children, errors, hint }: { step: string; children: ReactNode; errors: Array<{ k: keyof Draft; m: string }>; hint?: string }) {
  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-card" aria-label={step}>
      <p className="font-strong text-[11.5px] uppercase tracking-[0.12em] text-primary">{step}</p>
      <p className="mt-1.5 text-[16px] leading-[46px] text-text-2 sm:text-[17px]">{children}</p>
      {errors.length ? (
        <ul className="mt-2 flex flex-col gap-1" aria-live="polite">
          {errors.map(({ k, m }) => (
            <li key={k} className="flex items-start gap-2 text-[12.5px] leading-[18px] text-down">
              <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>
                <span className="font-strong">{LABEL[k]}:</span> {m}
              </span>
            </li>
          ))}
        </ul>
      ) : hint ? (
        <p className="mt-2 flex items-start gap-2 text-[12.5px] leading-[18px] text-text-3">
          <Info className="mt-px size-3.5 shrink-0" aria-hidden />
          {hint}
        </p>
      ) : null}
    </section>
  );
}

function ReadyLine({ valid, run, current, dirty, saved }: { valid: boolean; run: RunResult | null; current: boolean; dirty: boolean; saved: boolean }) {
  const over = run ? `over ${run.days} day${run.days === 1 ? "" : "s"}` : "";
  const [tone, text]: ["up" | "warn" | "neutral", string] = !valid
    ? ["warn", "Fix the highlighted fields to backtest or save."]
    : current && run!.result.trades.length === 0
      ? ["warn", `Backtested ${ago(run!.at)} ${over}: the rule never fired. Loosen its trigger, or enable it to wait for one.`]
      : current
        ? ["up", `Backtested ${ago(run!.at)} ${over}. Ready to enable.`]
        : run
          ? ["warn", "The rule changed since the backtest. Run it again to enable."]
          : ["neutral", "Run a backtest of this exact rule to enable it."];
  return (
    <div className="flex items-start justify-between gap-3">
      <p className={cn("text-[13.5px] leading-5", tone === "up" ? "text-text" : tone === "warn" ? "text-warn" : "text-text-2")} data-testid="ready-line">
        {text}
      </p>
      <Badge tone={saved && dirty ? "warn" : "neutral"} className="shrink-0">
        {saved ? (dirty ? "Unsaved changes" : "Saved") : "Not saved"}
      </Badge>
    </div>
  );
}

function BacktestCard({
  days,
  setDays,
  run,
  current,
  valid,
  pending,
  error,
  onRun,
  market,
  loosen,
}: {
  days: Days;
  setDays: (d: Days) => void;
  run: RunResult | null;
  current: boolean;
  valid: boolean;
  pending: boolean;
  error: string | null;
  onRun: () => void;
  market: string;
  /** A looser trigger to replay when this one never fired. */
  loosen: { label: string; run: () => void } | null;
}) {
  const r = run?.result;
  const candle = r ? duration(Math.round(r.resolutionSec / 60)).replace(" min", " minutes") : null;
  return (
    <Card className="flex flex-col gap-4 p-5" data-testid="backtest-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-strong text-[15px] leading-6 text-text">Backtest</h2>
          <p className="mt-0.5 text-[13px] leading-5 text-text-2">Replays this rule on real attention and Hyperliquid prices, with fees and slippage.</p>
        </div>
        {run && !current ? <Badge tone="warn">Out of date</Badge> : null}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Segmented label="Days of history" size="sm" value={days} onChange={setDays} options={DAYS} className="sm:flex-1" />
        <Button icon={<FlaskConical className="size-4" aria-hidden />} loading={pending} disabled={!valid} onClick={onRun} data-testid="run-backtest">
          {/* Sized for the longer label, so the window selector beside it never moves. */}
          <span className="grid">
            <span aria-hidden className="invisible col-start-1 row-start-1">
              Run backtest
            </span>
            <span className="col-start-1 row-start-1">{run ? "Run again" : "Run backtest"}</span>
          </span>
        </Button>
      </div>
      {error ? <ErrorNote message={error} /> : null}
      {pending ? (
        <div className="flex flex-col gap-2.5" aria-busy aria-label="Running the backtest">
          <p className="text-[12.5px] text-text-3">
            Replaying {days} day{days === "1" ? "" : "s"} of {market} prices and attention…
          </p>
          <Skeleton className="h-[84px] rounded-2xl" />
          <div className="grid grid-cols-2 gap-2.5">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[76px] rounded-2xl" />
            ))}
          </div>
          <Skeleton className="h-[180px] rounded-2xl" />
        </div>
      ) : r ? (
        <div className={cn("flex flex-col gap-4 transition-[opacity,translate] duration-300 ease-out starting:translate-y-1 starting:opacity-0", current ? "" : "opacity-60")} data-testid="backtest-result">
          <p className="text-[12px] leading-4 text-text-3">
            {new Date(r.from * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })} to {new Date(r.to * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · {r.candles.toLocaleString("en-US")} candles of {candle}
          </p>
          <StatsGrid stats={r.stats} testId="backtest-stats" countUp />
          {r.trades.length ? <EquityChart equity={r.equity} from={r.from} height={180} drawIn /> : null}
          {r.warnings.length ? (
            <div className="flex flex-col gap-1.5 rounded-2xl bg-warn-soft px-4 py-3" role="note" data-testid="backtest-warnings">
              <p className="flex items-center gap-2 font-strong text-[12.5px] text-warn">
                <AlertTriangle className="size-3.5" aria-hidden />
                What this backtest cannot tell you
              </p>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-[12.5px] leading-[18px] text-text">
                {r.warnings.map((w) => (
                  <li key={w}>{readableWarning(w)}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {r.trades.length ? (
            <div className="flex flex-col gap-2">
              <p className="font-strong text-[13px] text-text">Trades</p>
              <TradeList trades={r.trades} />
            </div>
          ) : (
            <div className="flex flex-col gap-3 rounded-2xl border border-dashed border-line-strong px-4 py-3">
              <p className="text-[13px] leading-5 text-text-2">The rule never fired in this period. Try a longer window, a smaller attention move, or another trend.</p>
              {loosen && current ? (
                <Button tone="secondary" size="sm" className="h-auto min-h-8 self-start whitespace-normal py-1.5 text-left" icon={<WandSparkles className="size-3.5 shrink-0" aria-hidden />} onClick={loosen.run} data-testid="loosen-trigger">
                  Loosen trigger: {loosen.label}
                </Button>
              ) : null}
            </div>
          )}
        </div>
      ) : (
        <p className="rounded-2xl border border-dashed border-line-strong px-4 py-6 text-center text-[13px] leading-5 text-text-3">Results show here: PnL, win rate, drawdown, every trade and the equity curve.</p>
      )}
    </Card>
  );
}

function BuilderSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-10 w-52" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px] xl:grid-cols-[minmax(0,1fr)_440px]">
        <div className="flex flex-col gap-4">
          {["h-[88px]", "h-[150px]", "h-[110px]", "h-[110px]", "h-[110px]"].map((h, i) => (
            <Skeleton key={i} className={cn("rounded-[var(--radius-card)]", h)} />
          ))}
        </div>
        <Skeleton className="h-80 rounded-[var(--radius-card)]" />
      </div>
    </div>
  );
}
