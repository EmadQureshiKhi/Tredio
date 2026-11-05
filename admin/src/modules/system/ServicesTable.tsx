import { Server } from "lucide-react";
import type { Fact, ServiceReport } from "@/src/types/admin";
import { Age, ErrorText, StateChip } from "./parts";
import { Line, SortableTable } from "./Table";

const STATE_RANK = { down: 0, degraded: 1, up: 2 } as const;

/** "market-maker" -> "Market maker". */
const serviceTitle = (name: string) => (name.charAt(0).toUpperCase() + name.slice(1)).replace(/-/g, " ");
const TONE_TEXT = { ok: "text-ok", warn: "text-warn", bad: "text-bad", neutral: "text-fg" } as const;

function FactValue({ fact, now }: { fact: Fact; now: number }) {
  const color = TONE_TEXT[fact.tone ?? "neutral"];
  return <span className={`tabular-nums ${color}`}>{fact.at !== undefined ? <Age at={fact.at} now={now} /> : fact.value}</span>;
}

/** A service's facts as "label value" pairs that wrap. */
function Facts({ facts, now }: { facts: Fact[]; now: number }) {
  if (facts.length === 0) return <span className="text-subtle">No detail reported.</span>;
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1">
      {facts.map((f) => (
        <div key={f.label} className="flex items-baseline gap-1.5">
          <dt className="text-subtle">{f.label}</dt>
          <dd>
            <FactValue fact={f} now={now} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Notes({ s }: { s: ServiceReport }) {
  return (
    <>
      {s.alerts.map((a) => (
        <p key={a} className="mt-1.5 [overflow-wrap:anywhere] text-xs leading-5 text-warn">
          {a}
        </p>
      ))}
      {s.lastError ? <ErrorText current={s.state !== "up"}>{s.lastError}</ErrorText> : null}
    </>
  );
}

function Name({ s }: { s: ServiceReport }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <span className="mt-0.5 text-subtle">
        <Server size={16} aria-hidden />
      </span>
      <div className="min-w-0">
        <p className="font-medium text-fg">{serviceTitle(s.name)}</p>
        <p className="font-mono text-xs text-subtle">{s.name}</p>
      </div>
    </div>
  );
}

function Status({ s }: { s: ServiceReport }) {
  return (
    <div className="min-w-0">
      <StateChip state={s.state} />
      {s.reason ? <p className="mt-1 text-xs leading-5 text-muted [overflow-wrap:anywhere]">{s.reason}</p> : null}
    </div>
  );
}

/** Where the backend reads the services it does not probe. */
const READ_FROM: Record<string, string> = { backend: "in process", oracle: "its reports", indexer: "its database" };
const latency = (s: ServiceReport) => (s.derived ? <span className="text-subtle">{READ_FROM[s.name] ?? "in process"}</span> : s.latencyMs === null ? <span className="text-bad">no answer</span> : `${s.latencyMs} ms`);

/** Every service, indexer and oracle included, worst first. */
export function ServicesTable({ services, now }: { services: ServiceReport[]; now: number }) {
  const rows = [...services].sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state]);
  return (
    <SortableTable
      label="Services"
      testId="services-table"
      rowTestId="service-row"
      rows={rows}
      rowKey={(s) => s.name}
      columns={[
        { key: "name", label: "Service", className: "w-[19%]", sort: (s) => serviceTitle(s.name), render: (s) => <Name s={s} /> },
        { key: "state", label: "Status", className: "w-[17%]", sort: (s) => STATE_RANK[s.state], render: (s) => <Status s={s} /> },
        { key: "latency", label: "Latency", align: "right", className: "w-[9%]", sort: (s) => (s.derived ? -1 : s.latencyMs), render: latency },
        { key: "success", label: "Last success", align: "right", className: "w-[11%]", sort: (s) => (s.lastSuccessAt === null ? null : -s.lastSuccessAt), render: (s) => <Age at={s.lastSuccessAt} now={now} /> },
        {
          key: "facts",
          label: "Details",
          render: (s) => (
            <>
              <Facts facts={s.facts} now={now} />
              <Notes s={s} />
            </>
          ),
        },
      ]}
      mobile={(s) => (
        <div data-testid="service-card-mobile">
          <div className="flex items-start justify-between gap-3">
            <Name s={s} />
            <StateChip state={s.state} />
          </div>
          {s.reason ? <p className="mt-1.5 text-xs leading-5 text-muted">{s.reason}</p> : null}
          <div className="mt-2">
            <Line label="Latency">{latency(s)}</Line>
            <Line label="Last success">
              <Age at={s.lastSuccessAt} now={now} />
            </Line>
            {s.facts.map((f) => (
              <Line key={f.label} label={f.label}>
                <FactValue fact={f} now={now} />
              </Line>
            ))}
          </div>
          <Notes s={s} />
        </div>
      )}
    />
  );
}
