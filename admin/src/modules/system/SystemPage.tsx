"use client";
import { useQuery } from "@tanstack/react-query";
import { Radio, RefreshCw } from "lucide-react";
import { Badge } from "@/src/components/ui/Badge";
import { Button } from "@/src/components/ui/Button";
import { Notice } from "@/src/components/ui/Notice";
import { api } from "@/src/lib/api";
import { formatAge, formatNumber, useNow } from "@/src/lib/format";
import { Card, Row, Rows } from "@/src/modules/operations/parts";
import type { Problem, SystemReport } from "@/src/types/admin";
import { ElfaAction, ElfaSection, SYSTEM_KEY, Tile } from "./ElfaSection";
import { Age, Chip, SEVERITY, Section, StateChip } from "./parts";
import { ServicesTable } from "./ServicesTable";
import { SourcesSection } from "./SourcesSection";

/** The page refreshes this often; the backend builds a report at most every 5 seconds. */
const REFRESH_MS = 20_000;

/** "45s", "12m", "3.2h", "2d". */
function duration(sec: number): string {
  if (sec < 90) return `${Math.round(sec)}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  if (sec < 172_800) return `${(sec / 3600).toFixed(1)}h`;
  return `${Math.round(sec / 86_400)}d`;
}

const HEADLINE = {
  ok: { tone: "ok", title: "All systems normal", box: "border-ok/25 bg-ok-soft" },
  degraded: { tone: "warn", title: "Degraded", box: "border-warn/30 bg-warn-soft" },
  critical: { tone: "bad", title: "Critical", box: "border-bad/25 bg-bad-soft" },
} as const;

function ProblemRow({ p }: { p: Problem }) {
  const s = SEVERITY[p.severity];
  const area = (className: string) => (
    <a href={`#${AREA_SECTION[p.area]}`} className={`shrink-0 text-xs text-subtle underline-offset-2 transition-colors hover:text-fg hover:underline ${className}`}>
      {AREA_LABEL[p.area]}
    </a>
  );
  return (
    <li className="px-4 py-3 sm:flex sm:items-start sm:gap-3 sm:px-5" data-testid="problem" data-severity={p.severity}>
      <div className="flex items-center justify-between gap-3 sm:w-[5.5rem] sm:shrink-0">
        <Chip tone={s.tone}>{s.label}</Chip>
        {area("sm:hidden")}
      </div>
      <div className="mt-1.5 min-w-0 flex-1 sm:mt-0">
        <p className="text-sm font-medium text-fg [overflow-wrap:anywhere]">{p.title}</p>
        {p.detail ? <p className="mt-0.5 text-[13px] leading-5 text-muted [overflow-wrap:anywhere]">{p.detail}</p> : null}
      </div>
      {area("hidden self-start sm:block")}
    </li>
  );
}

const AREA_SECTION: Record<Problem["area"], string> = {
  database: "services",
  services: "services",
  oracle: "oracle",
  elfa: "elfa",
  ai: "sources",
  sources: "sources",
  jobs: "freshness",
  freshness: "freshness",
};
const AREA_LABEL: Record<Problem["area"], string> = {
  database: "Database",
  services: "Services",
  oracle: "Oracle",
  elfa: "Elfa",
  ai: "AI",
  sources: "Sources",
  jobs: "Jobs",
  freshness: "Freshness",
};

/** The top of the page: the overall state and everything wrong, worst first. */
function Overall({ r }: { r: SystemReport }) {
  const h = HEADLINE[r.status];
  const critical = r.problems.filter((p) => p.severity === "critical").length;
  const warnings = r.problems.filter((p) => p.severity === "warning").length;
  const notes = r.problems.length - critical - warnings;
  const counts = [critical && `${critical} critical`, warnings && `${warnings} ${warnings === 1 ? "warning" : "warnings"}`, notes && `${notes} ${notes === 1 ? "note" : "notes"}`].filter(Boolean).join(", ");
  return (
    <section aria-labelledby="overall-title" data-testid="overall" data-status={r.status} className={`overflow-hidden rounded-xl border ${h.box}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3.5 sm:px-5">
        <Chip tone={h.tone}>{h.title}</Chip>
        <h2 id="overall-title" className="text-[15px] font-semibold text-fg">
          {r.status === "ok" ? (r.problems.length === 0 ? "Every service and source checks out." : "Nothing needs attention.") : `${counts}.`}
        </h2>
        {r.status === "ok" && notes > 0 ? <span className="text-[13px] text-muted">{counts} below.</span> : null}
      </div>
      {r.problems.length > 0 ? (
        <ol className="divide-y divide-line border-t border-line bg-surface" aria-label="Problems, most severe first">
          {r.problems.map((p, i) => (
            <ProblemRow key={`${p.area}-${p.title}-${i}`} p={p} />
          ))}
        </ol>
      ) : null}
    </section>
  );
}

/** Headline numbers, each linking to its section. */
function Summary({ r }: { r: SystemReport }) {
  const services = r.services.filter((s) => !s.derived || s.name === "backend");
  const up = services.filter((s) => s.state === "up").length;
  const keysOk = r.elfa.keys.filter((k) => k.state === "ok" || k.state === "idle").length;
  const sourcesOk = r.sources.filter((s) => s.state === "ok" || s.state === "idle").length;
  const aiOk = r.ai.providers.filter((p) => p.state === "ok" || p.state === "idle").length;
  const tiles = [
    { href: "#services", label: "Services up", value: `${up} of ${services.length}`, tone: up === services.length ? "ok" : r.services.some((s) => s.state === "down" && s.core) ? "bad" : "warn" },
    { href: "#services", label: "Database", value: r.database.ok ? `${r.database.latencyMs} ms` : "down", tone: r.database.ok ? undefined : "bad" },
    { href: "#oracle", label: "Oracle report", value: r.oracle.lastRunAgeSec !== null ? `${duration(r.oracle.lastRunAgeSec)} ago` : "never", hint: r.oracle.liveTrends !== null ? `${r.oracle.liveTrends} live trends` : undefined, tone: r.oracle.ok ? undefined : "bad" },
    { href: "#elfa", label: "Elfa keys working", value: r.elfa.configured ? `${keysOk} of ${r.elfa.keys.length}` : "off", tone: !r.elfa.configured || keysOk === r.elfa.keys.length ? undefined : keysOk === 0 ? "bad" : "warn" },
    { href: "#sources", label: "Sources working", value: `${sourcesOk} of ${r.sources.length}`, tone: sourcesOk === r.sources.length ? undefined : sourcesOk === 0 ? "bad" : "warn" },
    { href: "#sources", label: "AI providers working", value: r.ai.providers.length > 0 ? `${aiOk} of ${r.ai.providers.length}` : "none", tone: r.ai.providers.length === 0 || aiOk === 0 ? "bad" : aiOk < r.ai.providers.length ? "warn" : undefined },
    { href: "#freshness", label: "Jobs failing", value: formatNumber(r.jobs.filter((j) => j.state === "failing").length), tone: r.jobs.some((j) => j.state === "failing") ? "bad" : undefined },
    { href: "#errors", label: "Errors, last 24h", value: formatNumber(r.errors.length), hint: "distinct messages", tone: undefined },
  ] as const;
  return (
    <nav aria-label="Summary" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {tiles.map((t) => (
        <a key={t.label} href={t.href} className="block h-full rounded-xl outline-offset-2 transition-transform hover:-translate-y-px" data-testid="summary-tile">
          <Tile label={t.label} value={t.value} hint={"hint" in t ? t.hint : undefined} tone={t.tone} />
        </a>
      ))}
    </nav>
  );
}

function OracleCard({ r, now }: { r: SystemReport; now: number }) {
  const o = r.oracle;
  const run = o.lastIndexedRun;
  return (
    <Card icon={<Radio size={16} aria-hidden />} title="Oracle" status={<StateChip state={o.ok ? "ok" : o.lastRunAgeSec === null || o.lastRunAgeSec > o.staleAfterSec ? "down" : "degraded"} />} data-testid="oracle-card">
      <Rows>
        <Row label="Last report">
          <span className={o.lastRunAgeSec !== null && o.lastRunAgeSec > o.staleAfterSec ? "text-bad" : ""}>
            <Age at={o.lastRunAt} now={now} />
          </span>
          {run ? (
            <span className="block text-xs text-subtle">
              {run.updated} updated, {run.created} listed, {run.settled} settled
            </span>
          ) : null}
        </Row>
        <Row label="Live trends">
          {o.liveTrends ?? "?"} <span className="text-subtle">of {o.totalTrends ?? "?"}</span>
        </Row>
        <Row label="Stale indexes">
          <span className={(o.staleTrends ?? 0) > 0 ? "text-bad" : ""}>{o.staleTrends ?? "?"}</span>
          {o.oldestUpdateAgeSec !== null ? <span className="block text-xs text-subtle">oldest update {duration(o.oldestUpdateAgeSec)} ago{o.retireWindowSec ? `, retires after ${duration(o.retireWindowSec)}` : ""}</span> : null}
        </Row>
        <Row label="Last settlement">
          <Age at={o.lastSettlementAt} now={now} />
          {o.settlements24h !== null ? <span className="block text-xs text-subtle">{o.settlements24h} in 24h</span> : null}
        </Row>
      </Rows>
      {o.error ? <p className="mt-2 [overflow-wrap:anywhere] font-mono text-xs text-bad">{o.error}</p> : null}
    </Card>
  );
}

function Freshness({ r, now }: { r: SystemReport; now: number }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-card" data-testid="jobs">
      <div className="hidden grid-cols-[minmax(0,1fr)_7rem_7rem_minmax(0,2fr)] gap-4 border-b border-line px-5 py-2.5 text-xs font-medium text-subtle sm:grid">
        <span>Job</span>
        <span>Status</span>
        <span className="text-right">Last finished</span>
        <span>Last error</span>
      </div>
      <ul className="divide-y divide-line">
        {r.jobs.map((j) => (
          <li key={j.job} data-testid="job-row" className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 px-4 py-3 text-[13px] sm:grid-cols-[minmax(0,1fr)_7rem_7rem_minmax(0,2fr)] sm:px-5">
            <span className="font-medium capitalize text-fg">
              {j.job}
              {j.intervalSec ? <span className="ml-1.5 font-normal normal-case text-subtle">every {duration(j.intervalSec)}</span> : null}
            </span>
            <span>
              <StateChip state={j.state} />
            </span>
            <span className="text-muted sm:text-right">
              <span className="text-subtle sm:hidden">finished </span>
              <Age at={j.lastOkAt} now={now} />
            </span>
            <span className="col-span-2 min-w-0 sm:col-span-1">
              {j.lastError && j.state === "failing" ? (
                <span className="block [overflow-wrap:anywhere] font-mono text-xs leading-5 text-bad">
                  {j.lastError} <span className="font-sans text-subtle">(<Age at={j.lastErrorAt} now={now} />)</span>
                </span>
              ) : j.lastError ? (
                <span className="text-subtle" title={j.lastError}>
                  none since it last failed <Age at={j.lastErrorAt} now={now} />
                </span>
              ) : (
                <span className="text-subtle">none</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Errors({ r, now }: { r: SystemReport; now: number }) {
  if (r.errors.length === 0) return <p className="rounded-xl border border-dashed border-line-strong px-4 py-8 text-center text-sm text-muted">No errors in the last 24 hours.</p>;
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-card" data-testid="recent-errors">
      {r.errors.map((e) => (
        <li key={`${e.source}-${e.message}`} data-testid="recent-error" className="flex flex-col gap-1 px-4 py-3 text-[13px] sm:flex-row sm:items-start sm:gap-4 sm:px-5">
          <span className="w-28 shrink-0">
            <Badge>{e.source}</Badge>
          </span>
          <p className="min-w-0 flex-1 [overflow-wrap:anywhere] font-mono text-xs leading-5 text-fg">{e.message}</p>
          <span className="shrink-0 text-xs tabular-nums text-muted sm:text-right">
            {e.count > 1 ? <span className="text-fg">{formatNumber(e.count)} times, </span> : null}
            last <Age at={e.lastSeenAt} now={now} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function SystemPage() {
  const now = useNow(1000);
  const system = useQuery({ queryKey: SYSTEM_KEY, queryFn: api.system, refetchInterval: REFRESH_MS });
  const r = system.data;

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">System</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">Every service, the oracle and the data sources, with what is wrong first. Refreshes every 20 seconds.</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {system.dataUpdatedAt > 0 ? (
            <span className="text-xs text-subtle" data-testid="updated" aria-live="polite">
              Updated {formatAge(system.dataUpdatedAt, now)}
            </span>
          ) : null}
          <Button size="sm" icon={<RefreshCw size={14} className={system.isFetching ? "animate-spin" : ""} aria-hidden />} onClick={() => void system.refetch()} disabled={system.isFetching}>
            Refresh
          </Button>
        </div>
      </div>

      {system.isPending ? (
        <div className="mt-6 space-y-4" aria-busy aria-label="Loading the system report">
          <div className="h-28 animate-pulse rounded-xl border border-line bg-surface" />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="h-[4.6rem] animate-pulse rounded-xl border border-line bg-surface" />
            ))}
          </div>
          <div className="h-96 animate-pulse rounded-xl border border-line bg-surface" />
        </div>
      ) : !r ? (
        <div className="mt-6">
          <Notice
            tone="bad"
            title="Could not load the system report"
            action={
              <Button size="sm" onClick={() => void system.refetch()} loading={system.isFetching}>
                Try again
              </Button>
            }
          >
            {system.error?.message}
          </Notice>
        </div>
      ) : (
        <>
          <div className="mt-6 space-y-3">
            {system.isError ? (
              <Notice tone="warn" title="Showing the last reading">
                Refreshing failed: {system.error.message}
              </Notice>
            ) : null}
            <Overall r={r} />
            <Summary r={r} />
          </div>

          <Section id="services" title="Services" description="Each service's own health endpoint, plus the backend and oracle as the backend reads them. Worst first; sort by any column.">
            <ServicesTable services={r.services} now={now} />
          </Section>

          <Section id="oracle" title="Oracle">
            <OracleCard r={r} now={now} />
          </Section>

          <Section
            id="elfa"
            title="Elfa keys"
            description="Each key, its route, its credits against the daily pacing and the month, and its last calls. Read from what the backend already tracks; nothing here spends a credit."
            action={<ElfaAction elfa={r.elfa} />}
          >
            <ElfaSection elfa={r.elfa} now={now} />
          </Section>

          <Section id="sources" title="Sources and AI" description="Requests since the backend started, rate limits and rests, and each source's newest stored reading.">
            <SourcesSection sources={r.sources} ai={r.ai} now={now} />
          </Section>

          <Section id="freshness" title="Jobs" description="The backend's background loops and when each last finished.">
            <Freshness r={r} now={now} />
          </Section>

          <Section id="errors" title="Recent errors" description="Distinct errors from the backend's log and every service's health in the last 24 hours, newest first. URLs show their host only and keys never appear.">
            <Errors r={r} now={now} />
          </Section>
        </>
      )}
    </div>
  );
}
