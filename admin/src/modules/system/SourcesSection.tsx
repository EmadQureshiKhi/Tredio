import { formatNumber } from "@/src/lib/format";
import type { AiProviderReport, SourceReport, SystemReport } from "@/src/types/admin";
import { Age, ErrorText, StateChip } from "./parts";
import { Line, SortableTable } from "./Table";

const STATE_RANK: Record<string, number> = { failing: 0, resting: 1, idle: 2, ok: 3, off: 4 };

function Requests({ ok, failed, limited }: { ok: number; failed: number; limited: number }) {
  if (ok + failed + limited === 0) return <span className="text-subtle">none</span>;
  return (
    <span className="tabular-nums">
      {formatNumber(ok)} ok
      {failed > 0 ? <span className="text-bad">, {formatNumber(failed)} failed</span> : null}
      {limited > 0 ? <span className="text-warn">, {formatNumber(limited)} 429</span> : null}
    </span>
  );
}

function Reading({ s, now }: { s: SourceReport; now: number }) {
  if (s.newestReadingAt === null) return <span className="text-subtle">not a reading source</span>;
  return (
    <span className={s.staleReadings ? "text-warn" : ""}>
      <Age at={s.newestReadingAt} now={now} />
      <span className="text-subtle"> · {formatNumber(s.readingsLastHour ?? 0)} last hour</span>
    </span>
  );
}

const current = (lastOkAt: number | null, lastErrorAt: number | null) => lastErrorAt !== null && (lastOkAt === null || lastErrorAt > lastOkAt);

function LastError({ message, at, ok, now }: { message: string | null; at: number | null; ok: number | null; now: number }) {
  if (!message) return <span className="text-subtle">none</span>;
  return (
    <ErrorText current={current(ok, at)}>
      {message} <span className="font-sans text-subtle">(<Age at={at} now={now} />)</span>
    </ErrorText>
  );
}

export function SourcesSection({ sources, ai, now }: { sources: SourceReport[]; ai: SystemReport["ai"]; now: number }) {
  return (
    <div className="space-y-4">
      <SortableTable
        label="Data sources"
        testId="sources"
        rowTestId="source-row"
        rows={sources}
        rowKey={(s) => s.name}
        columns={[
          { key: "name", label: "Source", className: "w-[14%]", sort: (s) => s.label, render: (s) => <p className="font-medium text-fg">{s.label}</p> },
          {
            key: "state",
            label: "Status",
            className: "w-[13%]",
            sort: (s) => STATE_RANK[s.state] ?? 9,
            render: (s) => (
              <>
                <StateChip state={s.state} />
                {s.note ? <p className="mt-1 text-xs leading-5 text-muted">{s.note}</p> : null}
              </>
            ),
          },
          { key: "requests", label: "Requests since start", align: "right", className: "w-[17%]", sort: (s) => s.requests, render: (s) => <Requests ok={s.ok} failed={s.errors} limited={s.rateLimited} /> },
          { key: "ok", label: "Last success", align: "right", className: "w-[11%]", sort: (s) => (s.lastOkAt === null ? null : -s.lastOkAt), render: (s) => <Age at={s.lastOkAt} now={now} /> },
          { key: "reading", label: "Newest reading", align: "right", className: "w-[17%]", sort: (s) => (s.newestReadingAt === null ? null : -s.newestReadingAt), render: (s) => <Reading s={s} now={now} /> },
          { key: "error", label: "Last error", sort: (s) => (s.lastErrorAt === null ? null : -s.lastErrorAt), render: (s) => <LastError message={s.lastError} at={s.lastErrorAt} ok={s.lastOkAt} now={now} /> },
        ]}
        mobile={(s) => (
          <div>
            <div className="flex items-center justify-between gap-3">
              <p className="font-medium text-fg">{s.label}</p>
              <StateChip state={s.state} />
            </div>
            <div className="mt-2">
              <Line label="Requests">
                <Requests ok={s.ok} failed={s.errors} limited={s.rateLimited} />
              </Line>
              <Line label="Last success">
                <Age at={s.lastOkAt} now={now} />
              </Line>
              <Line label="Newest reading">
                <Reading s={s} now={now} />
              </Line>
            </div>
            {s.lastError ? <LastError message={s.lastError} at={s.lastErrorAt} ok={s.lastOkAt} now={now} /> : null}
          </div>
        )}
      />
      <p className="pt-2 text-[13px] text-muted" data-testid="ai-budget">
        AI calls left today: {ai.leftToday === null ? "unlimited" : <span className={ai.leftToday === 0 ? "text-bad" : "text-fg"}>{formatNumber(ai.leftToday)} of {formatNumber(ai.dailyCalls)}</span>}, shared by the radar and pasted links.
      </p>
      <SortableTable<AiProviderReport>
        label="AI providers"
        testId="ai-providers"
        rowTestId="ai-provider"
        rows={ai.providers}
        rowKey={(p) => p.name}
        empty="No AI provider is configured, so the radar cannot assess signals."
        columns={[
          {
            key: "name",
            label: "AI provider, in fallback order",
            className: "w-[31%]",
            render: (p) => (
              <p className="truncate font-mono text-xs text-fg" title={p.name}>
                {p.name}
              </p>
            ),
          },
          {
            key: "state",
            label: "Status",
            className: "w-[13%]",
            sort: (p) => STATE_RANK[p.state] ?? 9,
            render: (p) => (
              <>
                <StateChip state={p.state} />
                {p.benchedUntil ? (
                  <p className="mt-1 text-xs text-muted">
                    back <Age at={p.benchedUntil} now={now} />
                  </p>
                ) : null}
              </>
            ),
          },
          { key: "requests", label: "Requests", align: "right", className: "w-[17%]", sort: (p) => p.requests, render: (p) => <Requests ok={p.ok} failed={p.failures} limited={0} /> },
          { key: "ok", label: "Last success", align: "right", className: "w-[11%]", sort: (p) => (p.lastOkAt === null ? null : -p.lastOkAt), render: (p) => <Age at={p.lastOkAt} now={now} /> },
          { key: "error", label: "Last error", render: (p) => <LastError message={p.lastError} at={p.lastErrorAt} ok={p.lastOkAt} now={now} /> },
        ]}
        mobile={(p) => (
          <div>
            <div className="flex items-center justify-between gap-3">
              <p className="min-w-0 truncate font-mono text-xs text-fg">{p.name}</p>
              <StateChip state={p.state} />
            </div>
            <div className="mt-2">
              <Line label="Requests">
                <Requests ok={p.ok} failed={p.failures} limited={0} />
              </Line>
              <Line label="Last success">
                <Age at={p.lastOkAt} now={now} />
              </Line>
            </div>
            {p.lastError ? <LastError message={p.lastError} at={p.lastErrorAt} ok={p.lastOkAt} now={now} /> : null}
          </div>
        )}
      />
    </div>
  );
}
