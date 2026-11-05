"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pin, RefreshCw, RotateCcw, X } from "lucide-react";
import { Badge } from "@/src/components/ui/Badge";
import { Button } from "@/src/components/ui/Button";
import { Notice } from "@/src/components/ui/Notice";
import { useToast } from "@/src/components/ui/Toasts";
import { api, ApiError } from "@/src/lib/api";
import { formatAge, formatNumber, useNow } from "@/src/lib/format";
import { type Column, SortableTable } from "@/src/modules/system/Table";
import type { BoardTrend, RotationRow } from "@/src/types/admin";

const boardKey = ["admin", "rotation"] as const;

const hours = (sec: number) => (sec >= 86_400 ? `${(sec / 86_400).toFixed(1)} d` : `${Math.round(sec / 3600)} h`);
/** A rule's length in hours, as the rules are stated (36 h, not 1.5 d). */
const ruleHours = (sec: number) => `${Math.round(sec / 3600)} h`;

function Rule({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${ok ? "text-fg" : "text-subtle"}`} title={ok ? `Meets: ${label}` : `Not yet: ${label}`}>
      {ok ? <Check size={12} className="text-ok" aria-hidden /> : <X size={12} aria-hidden />}
      {label}
    </span>
  );
}

function KeepSwitch({ row, busy, onChange }: { row: BoardTrend; busy: boolean; onChange: (row: BoardTrend, pinned: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={row.pinned}
      aria-label={`Keep ${row.displayName ?? row.identifier} live`}
      disabled={busy}
      onClick={() => onChange(row, !row.pinned)}
      className={`inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 ${row.pinned ? "border-accent bg-accent" : "border-line-strong bg-raised"}`}
      data-testid="keep-switch"
    >
      <span className={`size-4 rounded-full bg-surface shadow-card transition-transform ${row.pinned ? "translate-x-[22px]" : "translate-x-[3px]"}`} />
    </button>
  );
}

function statusOf(r: RotationRow) {
  if (r.status === "rotating") return <Badge tone="warn">Rotating</Badge>;
  if (r.status === "done") return <Badge tone="ok">Rotated out</Badge>;
  return <Badge>Called off</Badge>;
}

/** The live board: who holds the slots, the rotation rules, and which trends are kept live. */
export default function RotationPage() {
  const now = useNow();
  const notify = useToast();
  const qc = useQueryClient();
  const board = useQuery({ queryKey: boardKey, queryFn: () => api.rotation(), refetchInterval: 30_000 });
  const fail = (title: string) => (err: unknown) => {
    if (!(err instanceof ApiError && err.status === 401)) notify({ tone: "bad", title, description: err instanceof Error ? err.message : String(err) });
  };
  const unkeep = useMutation({
    mutationFn: (base: string) => api.pin(base, false),
    onSuccess: (r) => {
      notify({ tone: "ok", title: `${r.identifier} is no longer kept`, description: "It waits in the queue like any other topic." });
      void qc.invalidateQueries({ queryKey: boardKey });
    },
    onError: fail("Could not change the pin"),
  });
  const pin = useMutation({
    mutationFn: ({ row, pinned }: { row: BoardTrend; pinned: boolean }) => api.pin(row.base, pinned),
    onSuccess: (r, { row }) => {
      notify({ tone: "ok", title: r.pinned ? `Keeping ${row.displayName ?? row.identifier} live` : `${row.displayName ?? row.identifier} can rotate again`, description: r.pinned ? "Rotation will never pick it." : undefined });
      void qc.invalidateQueries({ queryKey: boardKey });
    },
    onError: fail("Could not change the pin"),
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelRotation(),
    onSuccess: (r) => {
      notify({ tone: "ok", title: `Called off the rotation of ${r.cancelled}`, description: "The oracle updates it again from its next run." });
      void qc.invalidateQueries({ queryKey: boardKey });
    },
    onError: fail("Could not call the rotation off"),
  });

  const d = board.data;
  const columns: Column<BoardTrend>[] = [
    {
      key: "trend",
      label: "Trend",
      render: (r) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-fg">{r.displayName ?? r.base}</p>
          <p className="truncate font-mono text-[11px] text-subtle">{r.identifier}</p>
        </div>
      ),
      sort: (r) => (r.displayName ?? r.base).toLowerCase(),
    },
    { key: "index", label: "Index", align: "right", className: "w-20", render: (r) => <span className="tabular-nums">{r.index.toFixed(1)}</span>, sort: (r) => r.index },
    { key: "peak", label: "Peak", align: "right", className: "w-20", render: (r) => <span className="tabular-nums text-muted">{r.peakIndex.toFixed(1)}</span>, sort: (r) => r.peakIndex },
    {
      key: "share",
      label: "Of peak",
      align: "right",
      className: "w-24",
      render: (r) => <span className="tabular-nums">{r.peakIndex > 0 ? `${Math.round((r.index / r.peakIndex) * 100)}%` : "-"}</span>,
      sort: (r) => (r.peakIndex > 0 ? r.index / r.peakIndex : null),
    },
    { key: "age", label: "Live for", align: "right", className: "w-24", render: (r) => <span className="tabular-nums text-muted">{hours(r.ageSec)}</span>, sort: (r) => r.ageSec },
    {
      key: "rules",
      label: "Rotation rules",
      className: "w-80",
      render: (r) =>
        r.rotatingOut ? (
          <Badge tone="warn">Rotating out</Badge>
        ) : r.pinned ? (
          <span className="inline-flex items-center gap-1 text-xs text-accent">
            <Pin size={12} aria-hidden /> Kept live
          </span>
        ) : (
          <span className="flex flex-wrap gap-x-3 gap-y-1">
            <Rule ok={r.meets.age} label={`${ruleHours(d?.rules.minAgeSec ?? 0)} live`} />
            <Rule ok={r.meets.faded} label={`≤ ${Math.round((d?.rules.fadeRatio ?? 0) * 100)}% of peak`} />
            <Rule ok={r.meets.belowMedian} label="below median" />
            <Rule ok={r.meets.weaker} label={`fewer mentions (${formatNumber(r.mentions)})`} />
          </span>
        ),
    },
    { key: "keep", label: "Keep", align: "right", className: "w-16", render: (r) => <KeepSwitch row={r} busy={pin.isPending} onChange={(row, pinned) => pin.mutate({ row, pinned })} /> },
  ];

  return (
    <div className="flex flex-col gap-5" data-testid="rotation-page">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-fg">Live board</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            The trends holding live slots, and rotation: when every slot is taken, a trend that faded makes room for a stronger approved candidate, one at a time. Keep a trend to hold its slot.
          </p>
        </div>
        <Button size="sm" icon={<RefreshCw size={14} aria-hidden />} onClick={() => void board.refetch()} loading={board.isFetching && !board.isLoading}>
          Refresh
        </Button>
      </header>

      {board.isError ? <Notice tone="bad" title="The board could not load">{board.error instanceof Error ? board.error.message : "Try again."}</Notice> : null}

      {d ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-line bg-surface px-4 py-3.5 shadow-card">
              <p className="text-xs font-medium text-muted">Live slots</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-fg" data-testid="board-slots">
                {d.live.filter((t) => !t.rotatingOut).length} <span className="text-base font-normal text-subtle">of {d.rules.maxLive}</span>
              </p>
              {d.active ? <p className="mt-0.5 text-xs text-muted">plus 1 rotating out</p> : null}
            </div>
            <div className="rounded-xl border border-line bg-surface px-4 py-3.5 shadow-card">
              <p className="text-xs font-medium text-muted">Kept live</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-fg">{d.live.filter((t) => t.pinned).length}</p>
            </div>
            <div className="rounded-xl border border-line bg-surface px-4 py-3.5 shadow-card">
              <p className="text-xs font-medium text-muted">Rotation</p>
              <p className="mt-1.5 flex items-center gap-2">
                {d.rules.enabled ? <Badge tone="ok">On</Badge> : <Badge>Off</Badge>}
                <span className="text-xs text-muted">median index {d.median === null ? "-" : d.median.toFixed(1)}</span>
              </p>
              <p className="mt-1 truncate text-xs text-muted" title={d.strongest?.identifier}>
                {d.strongest ? `Strongest waiting: ${d.strongest.identifier}, ${formatNumber(d.strongest.mentions)} mentions` : "No candidate is ready to list"}
              </p>
            </div>
          </div>

          <Notice tone="info" title="Rotation rules">
            A trend rotates out only when every slot is taken and all of these hold: live at least {ruleHours(d.rules.minAgeSec)}, at or below {Math.round(d.rules.fadeRatio * 100)}% of its own peak, below the median of
            the live trends, and fewer mentions than the strongest candidate waiting. The oracle stops updating it, the registry retires it after two hours, its rounds settle at its last index, and the slot
            lists the queue at once. The board never shrinks: if no new trend takes the slot within {Math.round(d.rules.listGraceSec / 60)} min, the rotation is called off and the trend
            stays, and the next one waits {ruleHours(d.rules.cooldownSec)}. A rotation that has not finished in {ruleHours(d.rules.timeoutSec)} is called off. A kept trend never rotates out, and if it retires it lists again first in line, a crypto one
            without smart-money inflow. Only a live trend can be kept.
          </Notice>

          {d.active ? (
            <Notice
              tone="warn"
              title={`Rotating out ${d.active.identifier}`}
              action={
                <Button size="sm" variant="danger" icon={<RotateCcw size={14} aria-hidden />} loading={cancel.isPending} onClick={() => cancel.mutate()}>
                  Call off
                </Button>
              }
            >
              Started {formatAge(Date.parse(d.active.startedAt), now)}
              {d.active.replacement ? `; the strongest candidate waiting then was ${d.active.replacement}, and the slot goes to the first in line the oracle can list` : ""}. {d.active.reason}
            </Notice>
          ) : null}

          <SortableTable
            label="Live trends"
            testId="board-table"
            rowTestId="board-row"
            columns={columns}
            rows={d.live}
            rowKey={(r) => r.identifier}
            initialSort={{ key: "index", dir: "asc" }}
            mobile={(r) => (
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-fg">{r.displayName ?? r.base}</p>
                  <p className="text-xs text-muted">
                    {r.index.toFixed(1)} of a {r.peakIndex.toFixed(1)} peak · {hours(r.ageSec)} live{r.pinned ? " · kept" : ""}
                  </p>
                </div>
                <KeepSwitch row={r} busy={pin.isPending} onChange={(row, pinned) => pin.mutate({ row, pinned })} />
              </div>
            )}
          />

          <section className="flex flex-col gap-2" data-testid="community-picks">
            <h2 className="text-sm font-semibold text-fg">Community picks</h2>
            <p className="text-xs text-muted">
              Candidates at least {d.pickRules?.minWatchers ?? 3} accounts wait on (Notify me), up to {d.pickRules?.max ?? 3} at once. The oracle tries them right after kept topics; each still needs its
              listing checks, and crypto its smart-money inflow.
            </p>
            {(d.picks ?? []).length === 0 ? (
              <p className="text-sm text-muted">None right now.</p>
            ) : (
              <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
                {(d.picks ?? []).map((p) => (
                  <li key={p.identifier} className="flex items-center justify-between gap-3 px-4 py-3">
                    <span className="truncate font-mono text-[12px] text-fg">{p.identifier}</span>
                    <span className="shrink-0 text-xs text-muted tabular-nums">{p.watchers} waiting</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {d.keptWaiting.length > 0 ? (
            <section className="flex flex-col gap-2" data-testid="kept-waiting">
              <h2 className="text-sm font-semibold text-fg">Kept, waiting to list</h2>
              <p className="text-xs text-muted">Kept topics that are not live now. Each lists again first in line, and a crypto one needs no smart-money inflow.</p>
              <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
                {d.keptWaiting.map((base) => (
                  <li key={base} className="flex items-center justify-between gap-3 px-4 py-3">
                    <span className="inline-flex min-w-0 items-center gap-1.5 truncate font-mono text-[12px] text-fg">
                      <Pin size={12} className="shrink-0 text-accent" aria-hidden />
                      {base}
                    </span>
                    <Button size="sm" loading={unkeep.isPending && unkeep.variables === base} onClick={() => unkeep.mutate(base)}>
                      Stop keeping
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-fg">Recent rotations</h2>
            {d.recent.length === 0 ? (
              <p className="text-sm text-muted">None yet. The first one starts once every slot is taken and a trend qualifies.</p>
            ) : (
              <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
                {d.recent.map((r) => (
                  <li key={r.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-[12px] text-fg">
                        {r.identifier}
                        {r.replacement ? <span className="text-subtle"> (strongest waiting: {r.replacement})</span> : null}
                      </p>
                      <p className="truncate text-xs text-muted">{r.reason}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {statusOf(r)}
                      <span className="text-xs text-subtle">{formatAge(Date.parse(r.startedAt), now)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : board.isLoading ? (
        <div className="h-64 animate-pulse rounded-xl bg-raised" aria-label="Loading" />
      ) : null}
    </div>
  );
}
