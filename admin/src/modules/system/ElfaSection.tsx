"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { Button } from "@/src/components/ui/Button";
import { Dialog } from "@/src/components/ui/Dialog";
import { Notice } from "@/src/components/ui/Notice";
import { useToast } from "@/src/components/ui/Toasts";
import { api } from "@/src/lib/api";
import { formatNumber } from "@/src/lib/format";
import type { ElfaKeyCheck, ElfaKeyReport, ElfaReport } from "@/src/types/admin";
import { Age, Chip, ErrorText, Meter, StateChip } from "./parts";
import { Line, SortableTable } from "./Table";

export const SYSTEM_KEY = ["admin", "system"] as const;

const STATE_RANK: Record<string, number> = { "route-auth": 0, "route-down": 1, rejected: 2, error: 3, quota: 4, "rate-limited": 5, idle: 6, ok: 7 };

/** 8 KB, 4.2 MB, 300 MB. */
const size = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.round(bytes / 1024).toLocaleString("en-US")} KB` : `${(bytes / 1024 / 1024).toLocaleString("en-US", { maximumFractionDigits: bytes < 10 * 1024 * 1024 ? 1 : 0 })} MB`;

function Usage({ used, of, label }: { used: number; of: number; label: string }) {
  const pct = of > 0 ? (used / of) * 100 : 0;
  return (
    <div className="ml-auto w-full max-w-36">
      <p className="tabular-nums text-fg">
        {formatNumber(used)} <span className="text-subtle">of {formatNumber(of)}</span>
      </p>
      <div className="mt-1">
        <Meter pct={pct} tone={pct >= 100 ? "bad" : pct >= 80 ? "warn" : "accent"} label={label} />
      </div>
    </div>
  );
}

function KeyName({ k }: { k: ElfaKeyReport }) {
  return (
    <div className="min-w-0">
      <p className="font-mono text-xs text-fg">
        <span className="text-subtle">#{k.index}</span> {k.key}
      </p>
      <p className="mt-0.5 truncate font-mono text-xs text-muted" title="Route host and port">
        {k.route}
      </p>
    </div>
  );
}

function KeyStatus({ k, now }: { k: ElfaKeyReport; now: number }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <StateChip state={k.state} title={k.lastStatus ? `Last HTTP status ${k.lastStatus}` : undefined} />
        {k.busy ? <Chip tone="accent">In flight</Chip> : null}
      </div>
      {k.benchedUntil ? (
        <p className="mt-1 text-xs text-muted">
          back <Age at={k.benchedUntil} now={now} />
        </p>
      ) : null}
    </div>
  );
}

function LastCall({ k, now }: { k: ElfaKeyReport; now: number }) {
  const current = k.lastErrorAt !== null && (k.lastOkAt === null || k.lastErrorAt > k.lastOkAt);
  return (
    <div className="min-w-0">
      <p className="text-muted">
        {k.requests === 0 ? (
          <span className="text-subtle">No calls since the backend started</span>
        ) : (
          <>
            <span className="text-subtle">Succeeded</span> <Age at={k.lastOkAt} now={now} />
            <span className="text-subtle">
              {" "}
              · {formatNumber(k.requests)} {k.requests === 1 ? "call" : "calls"}
              {k.failures > 0 ? `, ${formatNumber(k.failures)} failed` : ""}
            </span>
          </>
        )}
      </p>
      {k.lastError ? (
        <ErrorText current={current}>
          {k.lastError} <span className="font-sans text-subtle">(<Age at={k.lastErrorAt} now={now} />)</span>
        </ErrorText>
      ) : null}
    </div>
  );
}

const OUTCOME_STATE: Record<ElfaKeyCheck["outcome"], string> = { ok: "ok", rejected: "rejected", quota: "quota", throttled: "rate-limited", "route-down": "route-down", "route-auth": "route-auth", plan: "error", error: "error" };

/** What the last manual check said for each key. */
function CheckResults({ check, now }: { check: NonNullable<ElfaReport["lastCheck"]>; now: number }) {
  return (
    <div className="mt-4 rounded-xl border border-line bg-surface shadow-card" data-testid="elfa-check">
      <p className="border-b border-line px-4 py-2.5 text-xs font-medium text-subtle sm:px-5" aria-live="polite">
        {check.running ? (
          <>
            Checking keys one at a time: {check.results.length} of {check.total} done
          </>
        ) : (
          <>
            Checked with Elfa <Age at={check.at} now={now} />
          </>
        )}
      </p>
      <ul className="divide-y divide-line">
        {check.results.map((r) => (
          <li key={r.index} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-2.5 text-[13px] sm:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1.4fr)_auto] sm:px-5">
            <span className="font-mono text-xs text-fg">
              <span className="text-subtle">#{r.index}</span> {r.key}
            </span>
            <span className="order-last col-span-2 text-muted sm:order-none sm:col-span-1">
              {r.plan ?? "plan unknown"}
              {r.free ? <span className="text-subtle"> (free)</span> : null}
            </span>
            <span className="order-last col-span-2 tabular-nums text-muted sm:order-none sm:col-span-1">
              {r.usedThisMonth !== null ? `${formatNumber(r.usedThisMonth)} used this month` : (r.error ?? "")}
              {r.monthlyLimit !== null ? <span className="text-subtle"> of {formatNumber(r.monthlyLimit)}</span> : null}
            </span>
            <span className="justify-self-end">
              <StateChip state={OUTCOME_STATE[r.outcome]} title={r.status ? `HTTP ${r.status}` : undefined} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CheckKeys({ keys, running }: { keys: number; running: boolean }) {
  const [open, setOpen] = useState(false);
  const notify = useToast();
  const queryClient = useQueryClient();
  const check = useMutation({
    mutationFn: api.checkElfaKeys,
    onSuccess: () => {
      setOpen(false);
      notify({ tone: "ok", title: "Key check started", description: "Keys are checked one at a time; each result shows here as it lands." });
      void queryClient.invalidateQueries({ queryKey: SYSTEM_KEY });
    },
    onError: (err) => {
      setOpen(false);
      notify({ tone: "bad", title: "Could not check the keys", description: err.message });
    },
  });
  return (
    <>
      <Button size="sm" icon={<KeyRound size={14} aria-hidden />} onClick={() => setOpen(true)} loading={check.isPending} disabled={running}>
        {running ? "Checking keys" : "Check keys now"}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        locked={check.isPending}
        title="Check every Elfa key?"
        description={`This asks Elfa for each key's status, one key at a time with about a minute between keys. It costs one credit each, ${keys} in all.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={check.isPending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => check.mutate()} loading={check.isPending}>
              Spend {keys} {keys === 1 ? "credit" : "credits"}
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">The page never spends credits on its own; this is the only action here that does.</p>
      </Dialog>
    </>
  );
}

export function ElfaSection({ elfa, now }: { elfa: ElfaReport; now: number }) {
  if (!elfa.configured) {
    return (
      <Notice tone="info" title="No Elfa keys are configured">
        Set ELFA_API_KEYS on the backend to read X and Telegram attention.
      </Notice>
    );
  }
  const t = elfa.totals;
  const f = elfa.fallback;
  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Keys working" value={`${elfa.keys.filter((k) => k.state === "ok" || k.state === "idle").length} of ${elfa.keys.length}`} />
        <Tile label="Credits today" value={`${formatNumber(t.usedToday)} of ${formatNumber(t.allowanceToday)}`} hint={`${formatNumber(t.leftToday)} left at today's pace`} />
        <Tile label="Credits this month" value={`${formatNumber(t.usedMonth)} of ${formatNumber(t.monthly)}`} hint={`${formatNumber(elfa.limits.monthlyPerKey)} per key, paced daily`} />
        <Tile label="Fallback bandwidth" value={f ? `${f.pct.toLocaleString("en-US", { maximumFractionDigits: 1 })}%` : "off"} hint={f ? `${size(f.bytes)} of ${size(f.capBytes)}, ${formatNumber(f.requests)} ${f.requests === 1 ? "request" : "requests"}` : "not configured"} />
      </div>
      {elfa.skipped.length > 0 || elfa.unusedRoutes.length > 0 ? (
        <p className="mt-3 text-[13px] text-muted">
          {elfa.skipped.length > 0 ? <>Not used (no route): {elfa.skipped.join(", ")}. </> : null}
          {elfa.unusedRoutes.length > 0 ? <>Routes no key uses: {elfa.unusedRoutes.join(", ")}.</> : null}
        </p>
      ) : null}
      <div className="mt-4">
        <SortableTable
          label="Elfa keys"
          testId="elfa-keys"
          rowTestId="elfa-key"
          rows={elfa.keys}
          rowKey={(k) => String(k.index)}
          initialSort={{ key: "state", dir: "asc" }}
          columns={[
            { key: "key", label: "Key and route", className: "w-[19%]", sort: (k) => k.index, render: (k) => <KeyName k={k} /> },
            { key: "state", label: "Status", className: "w-[16%]", sort: (k) => STATE_RANK[k.state] ?? 9, render: (k) => <KeyStatus k={k} now={now} /> },
            { key: "today", label: "Today", align: "right", className: "w-[15%]", sort: (k) => k.usedToday, render: (k) => <Usage used={k.usedToday} of={k.allowanceToday} label={`Key ${k.index} credits today`} /> },
            {
              key: "month",
              label: "This month",
              align: "right",
              className: "w-[15%]",
              sort: (k) => k.usedMonth,
              render: (k) => <Usage used={k.usedMonth} of={elfa.limits.monthlyPerKey} label={`Key ${k.index} credits this month`} />,
            },
            { key: "last", label: "Calls since start", render: (k) => <LastCall k={k} now={now} /> },
          ]}
          mobile={(k) => (
            <div>
              <div className="flex items-start justify-between gap-3">
                <KeyName k={k} />
                <KeyStatus k={k} now={now} />
              </div>
              <div className="mt-2">
                <Line label="Today">
                  {formatNumber(k.usedToday)} <span className="text-subtle">of {formatNumber(k.allowanceToday)}</span>
                </Line>
                <Line label="This month">
                  {formatNumber(k.usedMonth)} <span className="text-subtle">of {formatNumber(elfa.limits.monthlyPerKey)}</span>
                </Line>
              </div>
              <div className="mt-1">
                <LastCall k={k} now={now} />
              </div>
            </div>
          )}
        />
      </div>
      {elfa.lastCheck ? <CheckResults check={elfa.lastCheck} now={now} /> : null}
    </div>
  );
}

export function ElfaAction({ elfa }: { elfa: ElfaReport }) {
  return elfa.configured && elfa.keys.length > 0 ? <CheckKeys keys={elfa.keys.length} running={elfa.lastCheck?.running ?? false} /> : null;
}

export function Tile({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: "ok" | "warn" | "bad" }) {
  const color = tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : "text-fg";
  return (
    <div className="h-full min-w-0 rounded-xl border border-line bg-surface px-3.5 py-3 shadow-card">
      <p className="truncate text-xs text-subtle">{label}</p>
      <p className={`mt-1 truncate text-lg font-semibold tabular-nums ${color}`}>{value}</p>
      {hint ? <p className="mt-0.5 truncate text-xs text-subtle">{hint}</p> : null}
    </div>
  );
}
