"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Database, Gauge, Newspaper, Play, Radio, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Badge, StatusDot, type Tone } from "@/src/components/ui/Badge";
import { Button } from "@/src/components/ui/Button";
import { Notice } from "@/src/components/ui/Notice";
import { useToast } from "@/src/components/ui/Toasts";
import { api, ApiError } from "@/src/lib/api";
import { formatAge, formatDate, formatNumber, useNow } from "@/src/lib/format";
import { JOB_NAMES, type Health, type JobHealth, type JobName, type KeyBudget, type OracleHealth } from "@/src/types/admin";
import { Ago, Card, Row, Rows } from "./parts";
import { reportRows } from "./report";

/** Under ["admin"]: the detail is admin-only and is dropped on sign-out. */
const HEALTH_KEY = ["admin", "health"] as const;
const POLL_MS = 2000;
/** The radar can take minutes; past this the panel stops waiting and says so. */
const RUN_TIMEOUT_MS = 10 * 60_000;
/** The oracle reports every minute; a run older than this means it has stopped. */
const ORACLE_STALE_SEC = 10 * 60;

const JOBS: Record<JobName, { title: string; description: string; cost: string }> = {
  radar: {
    title: "Radar",
    description: "Finds new trends in Elfa and Wikipedia and has the AI assess them.",
    cost: "Spends Elfa credits and AI calls.",
  },
  collector: {
    title: "Collector",
    description: "Measures live trends and approved candidates, and marks listed ones live.",
    cost: "Measures only what is due.",
  },
  history: {
    title: "History",
    description: "Copies new index checkpoints into the database for charts and backtests.",
    cost: "Spends no credits.",
  },
};

const isJobName = (name: string): name is JobName => (JOB_NAMES as readonly string[]).includes(name);
const jobMeta = (name: string) => (isJobName(name) ? JOBS[name] : { title: name.charAt(0).toUpperCase() + name.slice(1), description: "", cost: "" });

type RunState =
  | { phase: "starting" }
  | { phase: "running"; alreadyRunning: boolean; startedAt: number }
  | { phase: "done"; at: number }
  | { phase: "failed"; message: string }
  | { phase: "timeout" };

/** "0:07", "2:15": how long a run has been going. */
function elapsed(sinceMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - sinceMs) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const jobOf = (health: Health | undefined, job: string): JobHealth | undefined => health?.jobs.find((j) => j.job === job);
const time = (iso: string | null) => (iso ? Date.parse(iso) : NaN);

interface RunDeps {
  fetchHealth: () => Promise<Health>;
  update: (run: RunState) => void;
  alive: () => boolean;
}

type RunOutcome = { phase: "done"; wasRunning: boolean } | { phase: "failed"; started: boolean; message: string } | { phase: "timeout" };

/** Starts a job, then polls /health until its last success or last error moves past what it was. */
async function runAndWatch(job: JobName, { fetchHealth, update, alive }: RunDeps): Promise<RunOutcome | null> {
  update({ phase: "starting" });
  let started: boolean;
  let before: JobHealth | undefined;
  try {
    before = jobOf(await fetchHealth(), job);
    started = await api.runJob(job);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null; // The sign-in screen takes over.
    const message = err instanceof Error ? err.message : String(err);
    update({ phase: "failed", message });
    return { phase: "failed", started: false, message };
  }
  update({ phase: "running", alreadyRunning: !started, startedAt: Date.now() });
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (alive() && Date.now() < deadline) {
    await sleep(POLL_MS);
    const after = jobOf(await fetchHealth().catch(() => undefined), job);
    if (!after) continue;
    if (after.lastOkAt && after.lastOkAt !== before?.lastOkAt) {
      update({ phase: "done", at: Date.now() });
      return { phase: "done", wasRunning: !started };
    }
    if (after.lastErrorAt && after.lastErrorAt !== before?.lastErrorAt) {
      const message = after.lastError ?? "unknown error";
      update({ phase: "failed", message });
      return { phase: "failed", started: true, message };
    }
  }
  if (!alive()) return null;
  update({ phase: "timeout" });
  return { phase: "timeout" };
}

function jobTone(job: JobHealth | undefined): { tone: Tone; label: string } {
  if (!job || (!job.lastOkAt && !job.lastErrorAt)) return { tone: "neutral", label: "Never run" };
  if (job.lastErrorAt && (!job.lastOkAt || time(job.lastErrorAt) > time(job.lastOkAt))) return { tone: "bad", label: "Last run failed" };
  return { tone: "ok", label: "Healthy" };
}

function RunStatus({ run, now }: { run: RunState | undefined; now: number }) {
  if (!run) return null;
  switch (run.phase) {
    case "starting":
      return <span className="text-muted">Starting…</span>;
    case "running":
      return (
        <span className="text-muted">
          {run.alreadyRunning ? "Already running; waiting for that run to finish" : "Running"}
          <span className="animate-pulse">…</span>
          <span className="ml-1.5 tabular-nums text-subtle">{elapsed(run.startedAt, now)}</span>
        </span>
      );
    case "done":
      return <span className="text-ok">Finished {formatAge(run.at, now)}</span>;
    case "failed":
      return <span className="text-bad">Failed: {run.message}</span>;
    case "timeout":
      return <span className="text-warn">Still running after 10 minutes. Check back later.</span>;
  }
}

/** A job's health and last report; jobs the admin API can start get a run button. */
function JobCard({ name, job, run, now, onRun }: { name: string; job: JobHealth | undefined; run: RunState | undefined; now: number; onRun: (() => void) | null }) {
  const meta = jobMeta(name);
  const { tone, label } = jobTone(job);
  const rows = reportRows(job?.lastReport);
  const busy = run?.phase === "starting" || run?.phase === "running";
  const errorIsLatest = tone === "bad";

  return (
    <section aria-labelledby={`job-${name}`} data-job={name} className="flex flex-col rounded-xl border border-line bg-surface shadow-card">
      <div className="flex-1 p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 id={`job-${name}`} className="text-[15px] font-semibold text-fg">
              {meta.title}
            </h3>
            {meta.description && <p className="mt-0.5 text-[13px] leading-5 text-muted">{meta.description}</p>}
          </div>
          <Badge tone={tone}>{label}</Badge>
        </div>

        <div className="mt-4 text-[13px]">
          <Rows>
            <Row label="Last success">
              <Ago iso={job?.lastOkAt ?? null} now={now} />
            </Row>
            <Row label="Last error">
              {job?.lastErrorAt ? (
                <span className={errorIsLatest ? "text-bad" : "text-muted"}>
                  <Ago iso={job.lastErrorAt} now={now} />
                </span>
              ) : (
                <span className="text-subtle">none</span>
              )}
            </Row>
          </Rows>
          {job?.lastError && (
            <p className={`mt-2 [overflow-wrap:anywhere] rounded-lg px-3 py-2 font-mono text-xs leading-5 ${errorIsLatest ? "bg-bad-soft text-bad" : "bg-raised text-muted"}`}>
              {job.lastError}
            </p>
          )}
        </div>

        {rows.length > 0 && (
          <div className="mt-4 border-t border-line pt-4">
            <h4 className="text-xs font-medium uppercase tracking-wide text-subtle">Last report</h4>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
              {rows.map((r) => (
                <div key={r.key} className="contents">
                  <dt className="text-subtle">{r.label}</dt>
                  <dd className="min-w-0 [overflow-wrap:anywhere] text-fg tabular-nums">
                    {r.lines ? (
                      <ul className="space-y-1">
                        {r.lines.map((line, i) => (
                          <li key={i} className="text-muted">
                            {line}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      r.value
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>

      {onRun && (
        <div className="flex flex-col gap-2 border-t border-line px-4 py-3 sm:flex-row sm:items-center sm:gap-3 sm:px-5">
          <Button variant="secondary" size="sm" icon={<Play size={14} aria-hidden />} loading={busy} onClick={onRun} className="sm:w-auto">
            Run {meta.title.toLowerCase()} now
          </Button>
          <p className="min-h-5 text-[13px] leading-5" aria-live="polite" data-testid="run-status">
            {run ? <RunStatus run={run} now={now} /> : <span className="text-subtle">{meta.cost}</span>}
          </p>
        </div>
      )}
    </section>
  );
}

function budgetCell(budget: KeyBudget | null) {
  if (!budget) return <span className="text-subtle">not configured</span>;
  return (
    <span className={budget.leftToday === 0 ? "text-bad" : ""}>
      {formatNumber(budget.leftToday)} credits left · {budget.keys} {budget.keys === 1 ? "key" : "keys"}
    </span>
  );
}

function SystemCards({ health, now }: { health: Health; now: number }) {
  const oracle: OracleHealth | null = typeof health.oracle === "object" && health.oracle !== null ? health.oracle : null;
  const oracleError = typeof health.oracle === "string" ? health.oracle : null;
  const lastRunAge = oracle && oracle.lastRunId > 0 ? Math.floor(now / 1000) - oracle.lastRunId : null;
  const oracleStale = lastRunAge !== null && lastRunAge > ORACLE_STALE_SEC;
  const budgetsOut = [health.budgets.elfa, health.budgets.nansen, health.budgets.ai].some((b) => b && b.leftToday === 0);

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Card icon={<Database size={16} aria-hidden />} title="Database" status={<Badge tone={health.db === "ok" ? "ok" : "bad"}>{health.db === "ok" ? "Connected" : "Down"}</Badge>}>
        {health.db === "ok" ? <p className="text-muted">Postgres answers queries.</p> : <p className="[overflow-wrap:anywhere] font-mono text-xs text-bad">{health.db}</p>}
      </Card>

      <Card
        icon={<Radio size={16} aria-hidden />}
        title="Oracle"
        status={<Badge tone={oracleError ? "bad" : oracleStale ? "warn" : "ok"}>{oracleError ? "Unreachable" : oracleStale ? "Stale" : "Reporting"}</Badge>}
      >
        {oracle ? (
          <Rows>
            <Row label="Live trends">
              {formatNumber(oracle.live)} <span className="text-subtle">of {formatNumber(oracle.trends)}</span>
            </Row>
            <Row label="Last oracle run" title={oracle.lastRunId > 0 ? formatDate(oracle.lastRunId * 1000) : undefined}>
              {oracle.lastRunId > 0 ? <span className={oracleStale ? "text-warn" : ""}>{formatAge(oracle.lastRunId * 1000, now)}</span> : <span className="text-subtle">never</span>}
            </Row>
          </Rows>
        ) : (
          <p className="[overflow-wrap:anywhere] font-mono text-xs text-bad">{oracleError}</p>
        )}
      </Card>

      <Card icon={<Gauge size={16} aria-hidden />} title="Data budgets" status={budgetsOut ? <Badge tone="warn">Spent</Badge> : null}>
        <Rows>
          <Row label="Elfa">{budgetCell(health.budgets.elfa)}</Row>
          <Row label="Nansen">{budgetCell(health.budgets.nansen)}</Row>
          {health.budgets.ai !== undefined ? (
            <Row label="AI calls">
              {health.budgets.ai ? <span className={health.budgets.ai.leftToday === 0 ? "text-bad" : ""}>{formatNumber(health.budgets.ai.leftToday)} left today</span> : <span className="text-subtle">unlimited</span>}
            </Row>
          ) : null}
        </Rows>
      </Card>

      <Card icon={<Bot size={16} aria-hidden />} title="AI providers" status={health.ai.length === 0 ? <Badge tone="bad">None</Badge> : null}>
        {health.ai.length === 0 ? (
          <p className="text-bad">No AI provider is configured, so the radar cannot assess signals.</p>
        ) : (
          <ol className="space-y-1.5">
            {health.ai.map((p, i) => (
              <li key={`${p}-${i}`} className="flex items-center gap-2.5">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-raised text-[11px] font-medium tabular-nums text-muted">{i + 1}</span>
                <span className="min-w-0 truncate font-mono text-xs text-fg" title={p}>
                  {p}
                </span>
                {i === 0 && <span className="text-xs text-subtle">primary</span>}
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card icon={<Newspaper size={16} aria-hidden />} title="GDELT" status={<Badge tone={health.gdelt === "ok" ? "ok" : "warn"}>{health.gdelt === "ok" ? "Available" : "Resting"}</Badge>}>
        <p className="text-muted">
          {health.gdelt === "ok" ? "News article counts are being collected." : "Paused after GDELT rate limited the collector; it resumes on its own."}
        </p>
      </Card>
    </div>
  );
}

function LiveTrends({ now }: { now: number }) {
  const trends = useQuery({ queryKey: ["trends"], queryFn: api.trends, refetchInterval: 60_000 });
  const rows = [...(trends.data?.trends ?? [])].sort((a, b) => b.index - a.index);

  if (trends.isPending) return <div className="h-40 animate-pulse rounded-xl border border-line bg-surface" aria-hidden />;
  if (!trends.data) return <Notice tone="bad" title="Could not load live trends">{trends.error?.message}</Notice>;
  if (rows.length === 0) return <p className="rounded-xl border border-dashed border-line-strong px-4 py-8 text-center text-sm text-muted">No trends are live.</p>;

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-card">
      <div className="hidden grid-cols-[minmax(0,1fr)_6rem_6rem_6rem] gap-4 border-b border-line px-5 py-2.5 text-xs font-medium text-subtle sm:grid">
        <span>Trend</span>
        <span className="text-right">Index</span>
        <span className="text-right">Peak</span>
        <span className="text-right">Updated</span>
      </div>
      <ul className="divide-y divide-line">
        {rows.map((t) => (
          <li key={t.id} data-testid="live-trend" className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_6rem_6rem_6rem] sm:px-5">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-medium text-fg">
                <span className="truncate">{t.displayName ?? t.identifier}</span>
                {t.status !== "active" && <Badge tone="warn">{t.status}</Badge>}
              </p>
              <p className="truncate font-mono text-xs text-muted">{t.identifier}</p>
            </div>
            <p className="text-right text-sm font-semibold tabular-nums text-fg">
              {t.index.toFixed(2)}
              <span className="block text-xs font-normal text-subtle sm:hidden">peak {t.peakIndex.toFixed(2)}</span>
            </p>
            <p className="hidden text-right text-sm tabular-nums text-muted sm:block">{t.peakIndex.toFixed(2)}</p>
            <p className="hidden text-right text-[13px] text-muted sm:block" title={formatDate(t.updatedAt * 1000)}>
              {formatAge(t.updatedAt * 1000, now)}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Banner({ health }: { health: Health }) {
  const problems = [
    health.db !== "ok" && "the database is down",
    typeof health.oracle === "string" && "the oracle cannot be read",
    health.jobs.some((j) => jobTone(j).tone === "bad") && "a job's last run failed",
  ].filter(Boolean) as string[];
  const ok = health.ok && problems.length === 0;
  return (
    <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${ok ? "border-ok/25 bg-ok-soft" : "border-bad/25 bg-bad-soft"}`} role="status" data-testid="health-banner">
      <StatusDot tone={ok ? "ok" : "bad"} />
      <p className="text-sm text-fg">
        <span className="font-medium">{ok ? "All systems normal" : "Needs attention"}</span>
        {!ok && problems.length > 0 && <span className="text-muted">: {problems.join(", ")}.</span>}
      </p>
      <Link href="/system" className="ml-auto shrink-0 text-[13px] font-medium text-muted underline-offset-2 transition-colors hover:text-fg hover:underline">
        Full report
      </Link>
    </div>
  );
}

export default function OperationsPage() {
  const queryClient = useQueryClient();
  const notify = useToast();
  const now = useNow(1000);
  const [runs, setRuns] = useState<Partial<Record<JobName, RunState>>>({});
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const health = useQuery({ queryKey: HEALTH_KEY, queryFn: api.health, refetchInterval: 15_000 });
  const freshHealth = () => queryClient.fetchQuery({ queryKey: HEALTH_KEY, queryFn: api.health, staleTime: 0 });
  const setRun = (job: JobName, run: RunState) => {
    if (alive.current) setRuns((all) => ({ ...all, [job]: run }));
  };

  const runJob = async (job: JobName) => {
    const title = JOBS[job].title;
    const final = await runAndWatch(job, { fetchHealth: freshHealth, update: (run) => setRun(job, run), alive: () => alive.current });
    if (!final || !alive.current) return;
    if (final.phase === "done") {
      notify({ tone: "ok", title: `${title} run finished`, description: final.wasRunning ? "It was already running when you asked." : undefined });
    } else if (final.phase === "failed") {
      notify({ tone: "bad", title: final.started ? `${title} run failed` : `Could not start the ${title.toLowerCase()}`, description: final.message });
    }
  };

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">Operations</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">Backend health, refreshed every 15 seconds, and the background jobs you can start by hand.</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {health.dataUpdatedAt > 0 && <span className="text-xs text-subtle">Updated {formatAge(health.dataUpdatedAt, now)}</span>}
          <Button
            size="sm"
            icon={<RefreshCw size={14} className={health.isFetching ? "animate-spin" : ""} aria-hidden />}
            onClick={() => void health.refetch()}
            disabled={health.isFetching}
          >
            Refresh
          </Button>
        </div>
      </div>

      {health.isPending ? (
        <div className="mt-6 space-y-4" aria-busy aria-label="Loading health">
          <div className="h-12 animate-pulse rounded-xl border border-line bg-surface" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="h-72 animate-pulse rounded-xl border border-line bg-surface" />
            <div className="h-72 animate-pulse rounded-xl border border-line bg-surface" />
          </div>
        </div>
      ) : !health.data ? (
        <div className="mt-6">
          <Notice
            tone="bad"
            title="Backend unreachable"
            action={
              <Button size="sm" onClick={() => void health.refetch()} loading={health.isFetching}>
                Try again
              </Button>
            }
          >
            {health.error?.message}
          </Notice>
        </div>
      ) : (
        <>
          <div className="mt-6 space-y-3">
            {health.isError && (
              <Notice tone="warn" title="Showing the last reading">
                Refreshing failed: {health.error.message}
              </Notice>
            )}
            <Banner health={health.data} />
          </div>

          <h2 className="mt-8 text-sm font-semibold text-fg">Jobs</h2>
          <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {[...JOB_NAMES, ...health.data.jobs.map((j) => j.job).filter((n) => !isJobName(n))].map((name) => (
              <JobCard
                key={name}
                name={name}
                job={jobOf(health.data, name)}
                run={isJobName(name) ? runs[name] : undefined}
                now={now}
                onRun={isJobName(name) ? () => void runJob(name) : null}
              />
            ))}
          </div>

          <h2 className="mt-8 text-sm font-semibold text-fg">System</h2>
          <div className="mt-3">
            <SystemCards health={health.data} now={now} />
          </div>
        </>
      )}

      <h2 className="mt-8 text-sm font-semibold text-fg">Live trends</h2>
      <div className="mt-3">
        <LiveTrends now={now} />
      </div>
    </div>
  );
}
