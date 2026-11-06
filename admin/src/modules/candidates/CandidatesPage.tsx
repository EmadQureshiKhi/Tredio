"use client";
import { useQuery } from "@tanstack/react-query";
import { Inbox, Plus, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/src/components/ui/Button";
import { Notice } from "@/src/components/ui/Notice";
import { Tabs, type TabItem } from "@/src/components/ui/Tabs";
import { useToast } from "@/src/components/ui/Toasts";
import { api, ApiError } from "@/src/lib/api";
import { formatAge, useNow } from "@/src/lib/format";
import { CANDIDATE_STATUSES, type Candidate, type CandidateStatus } from "@/src/types/admin";
import { AddTopicDialog } from "./AddTopicDialog";
import { CandidateCard } from "./CandidateCard";
import { candidatesKey, useDecision } from "./queries";
import { ReviewDialog } from "./ReviewDialog";

type Tab = CandidateStatus | "all";

/** The backend returns at most this many rows per list, newest update first. */
const LIST_LIMIT = 300;
const PANEL_ID = "candidates-panel";

const EMPTY: Record<Tab, { title: string; body: React.ReactNode }> = {
  pending: {
    title: "Nothing to review",
    body: (
      <>
        The radar sends flagged and low-confidence proposals here. It runs every two hours; you can start a run from{" "}
        <Link href="/operations" className="text-accent underline-offset-2 hover:underline">
          Operations
        </Link>
        .
      </>
    ),
  },
  approved: { title: "No approved candidates waiting", body: "Approved candidates stay here until the oracle lists them." },
  rejected: { title: "No rejected candidates", body: "Candidates the radar or a reviewer turned down show up here." },
  live: { title: "No live trends yet", body: "Candidates move here once the oracle has listed them." },
  retired: { title: "No retired candidates", body: "Candidates whose trend faded land here. Approving one lists the topic again under its next identifier." },
  all: { title: "No candidates yet", body: "The radar has not proposed anything so far." },
};

function parseTab(value: string | null): Tab {
  return value === "all" || (CANDIDATE_STATUSES as readonly string[]).includes(value ?? "") ? (value as Tab) : "pending";
}

function SkeletonCard() {
  return (
    <div className="rounded-xl border border-line bg-surface shadow-card" aria-hidden>
      <div className="space-y-3 p-4 sm:p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <div className="h-5 w-48 animate-pulse rounded bg-raised" />
            <div className="h-4 w-36 animate-pulse rounded bg-raised" />
          </div>
          <div className="h-4 w-20 animate-pulse rounded bg-raised" />
        </div>
        <div className="h-4 w-full max-w-lg animate-pulse rounded bg-raised" />
        <div className="flex gap-1.5">
          <div className="h-6 w-24 animate-pulse rounded-md bg-raised" />
          <div className="h-6 w-16 animate-pulse rounded-md bg-raised" />
        </div>
        <div className="h-10 w-full animate-pulse rounded-lg bg-raised" />
      </div>
      <div className="flex items-center justify-between border-t border-line px-4 py-3 sm:px-5">
        <div className="h-4 w-64 animate-pulse rounded bg-raised" />
        <div className="hidden h-8 w-40 animate-pulse rounded-lg bg-raised sm:block" />
      </div>
    </div>
  );
}

export default function CandidatesPage() {
  const searchParams = useSearchParams();
  const tab = parseTab(searchParams.get("status"));
  const status = tab === "all" ? null : tab;
  const now = useNow();
  const notify = useToast();
  const decision = useDecision();
  const [reviewing, setReviewing] = useState<Candidate | null>(null);
  const [adding, setAdding] = useState(false);
  /** Quick rejects in flight, by candidate id. */
  const [rejecting, setRejecting] = useState<ReadonlySet<number>>(() => new Set());

  const list = useQuery({ queryKey: candidatesKey(status), queryFn: () => api.candidates(status), refetchInterval: 60_000 });
  const pending = useQuery({ queryKey: candidatesKey("pending"), queryFn: () => api.candidates("pending"), refetchInterval: 60_000 });
  const pendingCount = pending.data?.length;

  const selectTab = (next: Tab) => {
    window.history.replaceState(null, "", next === "pending" ? "/candidates" : `/candidates?status=${next}`);
  };

  const quickReject = async (c: Candidate) => {
    setRejecting((ids) => new Set(ids).add(c.id));
    try {
      const updated = await decision.mutateAsync({ id: c.id, body: { decision: "reject" } });
      notify({ tone: "ok", title: `Rejected ${updated.displayName}`, description: `${updated.identifier} will not be listed.` });
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        notify({ tone: "bad", title: `Could not reject ${c.displayName}`, description: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      setRejecting((ids) => {
        const next = new Set(ids);
        next.delete(c.id);
        return next;
      });
    }
  };

  const tabs: TabItem<Tab>[] = [
    {
      value: "pending",
      label: "Pending",
      badge:
        pendingCount !== undefined && pendingCount > 0 ? (
          <span className="min-w-5 rounded-full bg-warn-soft px-1.5 text-center text-[11px] font-semibold leading-5 text-warn tabular-nums">{pendingCount}</span>
        ) : null,
    },
    { value: "approved", label: "Approved" },
    { value: "rejected", label: "Rejected" },
    { value: "live", label: "Live" },
    { value: "retired", label: "Retired" },
    { value: "all", label: "All" },
  ];

  const rows = list.data ?? [];

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">Candidates</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
            Trends the radar and pasted links proposed. Approved candidates are listed once the collector has measured them.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {list.dataUpdatedAt > 0 && <span className="text-xs text-subtle">Updated {formatAge(list.dataUpdatedAt, now)}</span>}
          <Button
            size="sm"
            icon={<RefreshCw size={14} className={list.isFetching ? "animate-spin" : ""} aria-hidden />}
            onClick={() => void list.refetch()}
            disabled={list.isFetching}
          >
            Refresh
          </Button>
          <Button size="sm" variant="primary" icon={<Plus size={14} aria-hidden />} onClick={() => setAdding(true)}>
            Add a topic
          </Button>
        </div>
      </div>
      <AddTopicDialog open={adding} onClose={() => setAdding(false)} />

      <div className="mt-6">
        <Tabs items={tabs} value={tab} onChange={selectTab} label="Candidate status" panelId={PANEL_ID} />
      </div>

      <section id={PANEL_ID} role="tabpanel" aria-labelledby={`${PANEL_ID}-tab-${tab}`} aria-busy={list.isPending} className="mt-4">
        {list.isPending ? (
          <div className="space-y-3">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        ) : !list.data ? (
          <Notice
            tone="bad"
            title="Could not load candidates"
            action={
              <Button size="sm" onClick={() => void list.refetch()} loading={list.isFetching}>
                Try again
              </Button>
            }
          >
            {list.error?.message}
          </Notice>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center rounded-xl border border-dashed border-line-strong px-6 py-14 text-center">
            <div className="flex size-10 items-center justify-center rounded-xl bg-raised text-subtle">
              <Inbox size={20} aria-hidden />
            </div>
            <h2 className="mt-4 text-sm font-semibold text-fg">{EMPTY[tab].title}</h2>
            <p className="mt-1 max-w-sm text-sm leading-6 text-muted">{EMPTY[tab].body}</p>
          </div>
        ) : (
          <>
            {list.isError && (
              <div className="mb-3">
                <Notice tone="warn" title="Showing the last list loaded">
                  Refreshing failed: {list.error.message}
                </Notice>
              </div>
            )}
            <p className="mb-3 text-xs text-subtle" data-testid="candidates-count">
              {rows.length >= LIST_LIMIT ? `Showing the ${LIST_LIMIT} most recently updated` : `${rows.length} ${rows.length === 1 ? "candidate" : "candidates"}`}
            </p>
            <ul className="space-y-3">
              {rows.map((c) => (
                <li key={c.id}>
                  <CandidateCard candidate={c} now={now} rejecting={rejecting.has(c.id)} onReview={() => setReviewing(c)} onReject={() => void quickReject(c)} />
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {reviewing && <ReviewDialog key={reviewing.id} candidate={reviewing} onClose={() => setReviewing(null)} />}
    </div>
  );
}
