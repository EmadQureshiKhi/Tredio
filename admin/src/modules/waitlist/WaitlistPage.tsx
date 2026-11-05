"use client";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Download, Inbox, MailCheck, RefreshCw, Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/src/components/ui/Badge";
import { Button } from "@/src/components/ui/Button";
import { Dialog } from "@/src/components/ui/Dialog";
import { inputClass } from "@/src/components/ui/Field";
import { Notice } from "@/src/components/ui/Notice";
import { useToast } from "@/src/components/ui/Toasts";
import { api, ApiError } from "@/src/lib/api";
import { formatAge, formatDate, formatNumber, shortAddress, useNow } from "@/src/lib/format";
import type { WaitlistRow } from "@/src/types/admin";

/** Rows per page; the backend serves up to 200. */
const PAGE = 50;

const waitlistKey = (q: string, offset: number) => ["admin", "waitlist", q, offset] as const;

/** The search a moment after typing stops, so each keystroke does not ask the backend. */
function useDebounced(value: string, ms = 250): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

const plural = (n: number, one: string, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;

function Stat({ label, value, hint, testId }: { label: string; value: number | undefined; hint?: string; testId: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3.5 shadow-card">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-fg" data-testid={testId}>
        {value === undefined ? <span className="inline-block h-7 w-14 animate-pulse rounded bg-raised align-middle" aria-label="Loading" /> : formatNumber(value)}
      </p>
      {hint && <p className="mt-0.5 text-xs text-subtle">{hint}</p>}
    </div>
  );
}

function StatusCell({ row }: { row: WaitlistRow }) {
  if (row.unsubscribedAt) return <Badge tone="warn" title={`Unsubscribed ${formatDate(Date.parse(row.unsubscribedAt))}`}>Unsubscribed</Badge>;
  if (row.invitedAt) return <Badge tone="ok" title={`Invited ${formatDate(Date.parse(row.invitedAt))}`}>Invited</Badge>;
  return <Badge>Waiting</Badge>;
}

function Checkbox({ checked, indeterminate = false, onChange, label }: { checked: boolean; indeterminate?: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = indeterminate;
      }}
      onChange={(e) => onChange(e.target.checked)}
      className="size-4 shrink-0 cursor-pointer accent-[var(--accent)]"
    />
  );
}

export default function WaitlistPage() {
  const now = useNow();
  const notify = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [exporting, setExporting] = useState(false);

  // A new search starts at the first page with nothing selected.
  const [lastQ, setLastQ] = useState(q);
  if (q !== lastQ) {
    setLastQ(q);
    setOffset(0);
    setSelected(new Set());
  }

  const list = useQuery({ queryKey: waitlistKey(q, offset), queryFn: () => api.waitlist(q, offset, PAGE), placeholderData: keepPreviousData, refetchInterval: 60_000 });
  const page = list.data;
  const rows = page?.rows ?? [];
  const pageIds = rows.map((r) => r.id);
  const picked = pageIds.filter((id) => selected.has(id));

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["admin", "waitlist"] });
  const failed = (title: string) => (err: unknown) => {
    if (!(err instanceof ApiError && err.status === 401)) notify({ tone: "bad", title, description: err instanceof Error ? err.message : String(err) });
  };

  const invite = useMutation({
    mutationFn: (ids: number[]) => api.inviteWaitlist(ids),
    onSuccess: (n, ids) => {
      notify({ tone: "ok", title: n === 0 ? "Already invited" : `Marked ${plural(n, "signup")} invited`, description: n < ids.length ? `${plural(ids.length - n, "was", "were")} invited before and kept that time.` : undefined });
      setSelected(new Set());
      void refresh();
    },
    onError: failed("Could not mark them invited"),
  });

  const remove = useMutation({
    mutationFn: (ids: number[]) => api.deleteWaitlist(ids),
    onSuccess: (n) => {
      notify({ tone: "ok", title: `Deleted ${plural(n, "signup")}`, description: "Their emails are gone for good." });
      setSelected(new Set());
      setConfirmDelete(false);
      void refresh();
    },
    onError: failed("Could not delete them"),
  });

  const exportCsv = async () => {
    setExporting(true);
    try {
      const { blob, name } = await api.waitlistCsv();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (err) {
      failed("Could not export the waitlist")(err);
    } finally {
      setExporting(false);
    }
  };

  const toggle = (id: number, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const allPicked = pageIds.length > 0 && picked.length === pageIds.length;

  const matching = page?.matching ?? 0;
  const from = matching === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE, matching);

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">Waitlist</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
            People who asked to hear when Tredio opens on Mainnet, from the website and the app. Nothing is emailed until the launch; deletion requests sent to contact@tredio.bid are handled here.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          {list.dataUpdatedAt > 0 && <span className="hidden text-xs text-subtle sm:inline">Updated {formatAge(list.dataUpdatedAt, now)}</span>}
          <Button size="sm" icon={<RefreshCw size={14} className={list.isFetching ? "animate-spin" : ""} aria-hidden />} onClick={() => void list.refetch()} disabled={list.isFetching}>
            Refresh
          </Button>
          <Button size="sm" icon={<Download size={14} aria-hidden />} onClick={() => void exportCsv()} loading={exporting} disabled={!page || page.total === 0}>
            Export CSV
          </Button>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-3 gap-3">
        <Stat label="Signups" value={page?.total} testId="waitlist-total" />
        <Stat label="Linked accounts" value={page?.linked} hint="Joined in the app, signed in" testId="waitlist-linked" />
        <Stat label="Invited" value={page?.invited} hint="Marked for the beta" testId="waitlist-invited" />
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" aria-hidden />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search email or account"
            aria-label="Search the waitlist by email or account"
            className={inputClass(false, "h-9 pl-9")}
          />
        </div>
        <div className="flex items-center gap-2 sm:ml-auto">
          {picked.length > 0 && <span className="mr-1 text-xs text-muted tabular-nums">{plural(picked.length, "selected", "selected")}</span>}
          <Button size="sm" variant="primary" icon={<MailCheck size={14} aria-hidden />} disabled={picked.length === 0} loading={invite.isPending} onClick={() => invite.mutate(picked)}>
            Mark invited
          </Button>
          <Button size="sm" variant="danger" icon={<Trash2 size={14} aria-hidden />} disabled={picked.length === 0 || remove.isPending} onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        </div>
      </div>

      <section aria-busy={list.isPending} className="mt-4">
        {list.isPending ? (
          <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-card" aria-hidden>
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex items-center gap-4 border-b border-line px-4 py-3.5 last:border-b-0">
                <div className="size-4 animate-pulse rounded bg-raised" />
                <div className="h-4 w-56 animate-pulse rounded bg-raised" />
                <div className="ml-auto h-4 w-20 animate-pulse rounded bg-raised" />
              </div>
            ))}
          </div>
        ) : !page ? (
          <Notice
            tone="bad"
            title="Could not load the waitlist"
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
            <h2 className="mt-4 text-sm font-semibold text-fg">{q ? "No signups match" : "No signups yet"}</h2>
            <p className="mt-1 max-w-sm text-sm leading-6 text-muted">
              {q ? `Nothing on the waitlist contains “${q}”.` : "Signups from the website's waitlist form and the app's Mainnet card show up here."}
            </p>
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
            <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-card">
              <table className="w-full table-fixed text-sm" data-testid="waitlist-table">
                <thead className="hidden border-b border-line bg-raised/50 text-left text-xs font-medium text-muted sm:table-header-group">
                  <tr>
                    <th scope="col" className="w-11 py-2.5 pl-4">
                      <Checkbox checked={allPicked} indeterminate={picked.length > 0 && !allPicked} onChange={(on) => setSelected(on ? new Set(pageIds) : new Set())} label="Select every signup on this page" />
                    </th>
                    <th scope="col" className="py-2.5 pr-4 font-medium">Email</th>
                    <th scope="col" className="w-24 py-2.5 pr-4 font-medium">Source</th>
                    <th scope="col" className="w-40 py-2.5 pr-4 font-medium">Account</th>
                    <th scope="col" className="w-28 py-2.5 pr-4 font-medium">Joined</th>
                    <th scope="col" className="w-32 py-2.5 pr-4 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const joined = Date.parse(r.createdAt);
                    return (
                      <tr key={r.id} data-testid="waitlist-row" data-email={r.email} className={`border-b border-line last:border-b-0 ${selected.has(r.id) ? "bg-accent-soft/40" : ""}`}>
                        <td className="w-11 py-3 pl-4 align-top sm:align-middle">
                          <Checkbox checked={selected.has(r.id)} onChange={(on) => toggle(r.id, on)} label={`Select ${r.email}`} />
                        </td>
                        {/* Phones: one cell carries the whole row. */}
                        <td className="py-3 pr-4 align-top sm:align-middle">
                          <p className="truncate font-medium text-fg" title={r.email}>
                            {r.email}
                          </p>
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted sm:hidden">
                            <Badge>{r.source === "app" ? "App" : "Website"}</Badge>
                            <StatusCell row={r} />
                            <span title={formatDate(joined)}>{formatAge(joined, now)}</span>
                            {r.account && (
                              <span className="font-mono" title={r.account}>
                                {shortAddress(r.account)}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="hidden py-3 pr-4 sm:table-cell">
                          <Badge>{r.source === "app" ? "App" : "Website"}</Badge>
                        </td>
                        <td className="hidden py-3 pr-4 sm:table-cell">
                          {r.account ? (
                            <span className="font-mono text-[13px] text-fg" title={r.account}>
                              {shortAddress(r.account)}
                            </span>
                          ) : (
                            <span className="text-subtle">None</span>
                          )}
                        </td>
                        <td className="hidden py-3 pr-4 text-muted sm:table-cell" title={formatDate(joined)}>
                          {formatAge(joined, now)}
                        </td>
                        <td className="hidden py-3 pr-4 sm:table-cell">
                          <StatusCell row={r} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-xs text-subtle tabular-nums" data-testid="waitlist-range">
                {from}&ndash;{to} of {plural(matching, q ? "match" : "signup", q ? "matches" : "signups")}
              </p>
              <div className="flex items-center gap-1.5">
                <Button size="sm" variant="ghost" icon={<ChevronLeft size={15} aria-hidden />} disabled={offset === 0 || list.isFetching} onClick={() => setOffset((o) => Math.max(0, o - PAGE))}>
                  Newer
                </Button>
                <Button size="sm" variant="ghost" disabled={to >= matching || list.isFetching} onClick={() => setOffset((o) => o + PAGE)}>
                  Older
                  <ChevronRight size={15} aria-hidden />
                </Button>
              </div>
            </div>
          </>
        )}
      </section>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        locked={remove.isPending}
        title={`Delete ${plural(picked.length, "signup")}?`}
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirmDelete(false)} disabled={remove.isPending}>
              Cancel
            </Button>
            <Button variant="danger" icon={<Trash2 size={15} aria-hidden />} loading={remove.isPending} onClick={() => remove.mutate(picked)}>
              Delete for good
            </Button>
          </div>
        }
      >
        <p className="text-sm leading-6 text-muted">This erases these emails from the waitlist and cannot be undone. Use it for deletion requests; someone who joins again is added back.</p>
        <ul className="mt-3 max-h-48 space-y-1 overflow-y-auto rounded-lg border border-line bg-raised px-3 py-2 font-mono text-[13px] text-fg">
          {rows
            .filter((r) => selected.has(r.id))
            .map((r) => (
              <li key={r.id} className="truncate">
                {r.email}
              </li>
            ))}
        </ul>
      </Dialog>
    </div>
  );
}
