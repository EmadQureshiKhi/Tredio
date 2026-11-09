"use client";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Megaphone, MessageSquare, Radio, RefreshCw, ScrollText, Search, Users } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/src/components/ui/Button";
import { inputClass } from "@/src/components/ui/Field";
import { Notice } from "@/src/components/ui/Notice";
import { Tabs, type TabItem } from "@/src/components/ui/Tabs";
import { api, type ContentQuery } from "@/src/lib/api";
import { formatAge, formatNumber, plural, useDebounced, useNow } from "@/src/lib/format";
import type { ContentKind, ContentPage, ModeratedCall, ModeratedPost, ModeratedSignal, ModerationState, SocialCaller } from "@/src/types/admin";
import { CallersTable } from "./CallersTable";
import { CallRows, PostRows, SignalRows } from "./ContentList";
import { type Moderating, ModerateDialog, RenameDialog } from "./dialogs";
import { LogList } from "./LogList";
import { CALLER, EmptyState, ListSkeleton, moderationKey } from "./parts";

type Tab = ContentKind | "callers" | "log";
const TABS: readonly Tab[] = ["posts", "calls", "signals", "callers", "log"];
const PANEL_ID = "moderation-panel";
/** Rows per page; the backend serves up to 200. */
const PAGE = 50;
/** The backend lists at most this many callers, newest first. */
const CALLERS_LIMIT = 500;

const STATE_LABELS: Record<ModerationState, string> = { all: "Visible and hidden", visible: "Visible only", hidden: "Hidden only" };

const parseTab = (value: string | null): Tab => (TABS.includes(value as Tab) ? (value as Tab) : "posts");

/** A query's freshness and errors, the same for whichever tab is showing. */
type Shown = { dataUpdatedAt: number; isFetching: boolean; refetch: () => unknown };

/**
 * Moderation of the social layer: recent thread posts and calls, newest first, which an admin can
 * hide from every public view or restore; callers, whose handle and bio an admin can replace; and
 * the log of every action with its reason.
 */
export default function ModerationPage() {
  const searchParams = useSearchParams();
  const tab = parseTab(searchParams.get("tab"));
  const now = useNow();
  const [callerInput, setCallerInput] = useState("");
  const [state, setState] = useState<ModerationState>("all");
  const [offset, setOffset] = useState(0);
  const [callerSearch, setCallerSearch] = useState("");
  const [moderating, setModerating] = useState<Moderating | null>(null);
  const [editing, setEditing] = useState<SocialCaller | null>(null);

  const typed = useDebounced(callerInput.trim().toLowerCase().replace(/^@/, ""));
  const callerInvalid = typed.length > 0 && !CALLER.test(typed);
  const caller = callerInvalid ? "" : typed;
  const q = useDebounced(callerSearch.trim());

  // A new tab or filter starts at the first page.
  const filterKey = `${tab}|${caller}|${state}`;
  const [lastFilter, setLastFilter] = useState(filterKey);
  if (filterKey !== lastFilter) {
    setLastFilter(filterKey);
    setOffset(0);
  }

  const query: ContentQuery = { state, caller, offset, limit: PAGE };
  const contentOptions = { placeholderData: keepPreviousData, refetchInterval: 60_000 } as const;
  const posts = useQuery({ queryKey: [...moderationKey, "posts", query], queryFn: () => api.socialPosts(query), enabled: tab === "posts", ...contentOptions });
  const calls = useQuery({ queryKey: [...moderationKey, "calls", query], queryFn: () => api.socialCalls(query), enabled: tab === "calls", ...contentOptions });
  const signals = useQuery({ queryKey: [...moderationKey, "signals", query], queryFn: () => api.socialSignals(query), enabled: tab === "signals", ...contentOptions });
  const callers = useQuery({ queryKey: [...moderationKey, "callers", q], queryFn: () => api.socialCallers(q), enabled: tab === "callers", placeholderData: keepPreviousData, refetchInterval: 60_000 });
  const log = useQuery({ queryKey: [...moderationKey, "log"], queryFn: () => api.moderationLog(), enabled: tab === "log", refetchInterval: 60_000 });
  const shown: Shown = { posts, calls, signals, callers, log }[tab];

  const selectTab = (next: Tab) => window.history.replaceState(null, "", next === "posts" ? "/moderation" : `/moderation?tab=${next}`);
  const showContentBy = (c: SocialCaller) => {
    setCallerInput(c.handle ? `@${c.handle}` : c.address);
    setState("all");
    selectTab("posts");
  };

  const tabs: TabItem<Tab>[] = [
    { value: "posts", label: "Posts" },
    { value: "calls", label: "Calls" },
    { value: "signals", label: "Signals" },
    { value: "callers", label: "Callers" },
    { value: "log", label: "Log" },
  ];

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">Moderation</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
            Thread posts, calls and paid signals, newest first. Hiding one takes it out of every public view: trend threads, profiles, the leaderboard, share links and the signals feed.
            Nothing is deleted: the signed original stays, and restoring brings it back as it was.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {shown.dataUpdatedAt > 0 && <span className="text-xs text-subtle">Updated {formatAge(shown.dataUpdatedAt, now)}</span>}
          <Button size="sm" icon={<RefreshCw size={14} className={shown.isFetching ? "animate-spin" : ""} aria-hidden />} onClick={() => void shown.refetch()} disabled={shown.isFetching}>
            Refresh
          </Button>
        </div>
      </div>

      <div className="mt-6">
        <Tabs items={tabs} value={tab} onChange={selectTab} label="Moderation view" panelId={PANEL_ID} />
      </div>

      <section id={PANEL_ID} role="tabpanel" aria-labelledby={`${PANEL_ID}-tab-${tab}`} className="mt-4">
        {tab === "posts" || tab === "calls" || tab === "signals" ? (
          <>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative min-w-0 flex-1 sm:max-w-sm">
                <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" aria-hidden />
                <input
                  type="search"
                  value={callerInput}
                  onChange={(e) => setCallerInput(e.target.value)}
                  placeholder="Caller handle or identity"
                  aria-label="Filter by caller handle or identity"
                  aria-invalid={callerInvalid || undefined}
                  spellCheck={false}
                  className={inputClass(callerInvalid, "h-9 pl-9")}
                />
              </div>
              <select value={state} onChange={(e) => setState(e.target.value as ModerationState)} aria-label="Show" className={inputClass(false, "h-9 sm:w-48")}>
                {(Object.keys(STATE_LABELS) as ModerationState[]).map((s) => (
                  <option key={s} value={s}>
                    {STATE_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            {callerInvalid && <p className="mt-1.5 text-xs text-bad">A handle is 3 to 20 of a-z, 0-9 and _; an identity is 64 hex characters.</p>}
            <div className="mt-4">
              {tab === "posts" ? (
                <ContentPanel kind="posts" query={posts} state={state} caller={caller} offset={offset} onOffset={setOffset}>
                  {(rows: ModeratedPost[]) => <PostRows rows={rows} now={now} onModerate={setModerating} />}
                </ContentPanel>
              ) : tab === "calls" ? (
                <ContentPanel kind="calls" query={calls} state={state} caller={caller} offset={offset} onOffset={setOffset}>
                  {(rows: ModeratedCall[]) => <CallRows rows={rows} now={now} onModerate={setModerating} />}
                </ContentPanel>
              ) : (
                <ContentPanel kind="signals" query={signals} state={state} caller={caller} offset={offset} onOffset={setOffset}>
                  {(rows: ModeratedSignal[]) => <SignalRows rows={rows} now={now} onModerate={setModerating} />}
                </ContentPanel>
              )}
            </div>
          </>
        ) : tab === "callers" ? (
          <>
            <div className="relative min-w-0 sm:max-w-sm">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" aria-hidden />
              <input
                type="search"
                value={callerSearch}
                onChange={(e) => setCallerSearch(e.target.value)}
                placeholder="Search handle, identity or account"
                aria-label="Search callers by handle, identity or linked account"
                spellCheck={false}
                className={inputClass(false, "h-9 pl-9")}
              />
            </div>
            <div className="mt-4" aria-busy={callers.isPending}>
              {callers.isPending ? (
                <ListSkeleton />
              ) : !callers.data ? (
                <LoadError what="callers" error={callers.error} retry={() => void callers.refetch()} retrying={callers.isFetching} />
              ) : callers.data.length === 0 ? (
                <EmptyState icon={<Users size={20} aria-hidden />} title={q ? "No callers match" : "No callers yet"}>
                  {q ? `No caller's identity, handle or linked account contains “${q}”.` : "A caller shows up here with their first profile, call or post."}
                </EmptyState>
              ) : (
                <>
                  <StaleNotice error={callers.isError ? callers.error : null} />
                  <p className="mb-3 text-xs text-subtle" data-testid="callers-count">
                    {callers.data.length >= CALLERS_LIMIT ? `Showing the ${CALLERS_LIMIT} newest` : plural(callers.data.length, "caller")}
                  </p>
                  <CallersTable rows={callers.data} now={now} onContent={showContentBy} onEdit={setEditing} />
                </>
              )}
            </div>
          </>
        ) : (
          <div aria-busy={log.isPending}>
            {log.isPending ? (
              <ListSkeleton />
            ) : !log.data ? (
              <LoadError what="the log" error={log.error} retry={() => void log.refetch()} retrying={log.isFetching} />
            ) : log.data.length === 0 ? (
              <EmptyState icon={<ScrollText size={20} aria-hidden />} title="Nothing moderated yet">
                Every hide, restore and profile edit lands here with who made it and why.
              </EmptyState>
            ) : (
              <>
                <StaleNotice error={log.isError ? log.error : null} />
                <p className="mb-3 text-xs text-subtle">{log.data.length >= 200 ? "The 200 newest actions" : plural(log.data.length, "action")}</p>
                <LogList rows={log.data} now={now} />
              </>
            )}
          </div>
        )}
      </section>

      {moderating && <ModerateDialog key={`${moderating.kind}:${moderating.item.id}`} target={moderating} onClose={() => setModerating(null)} />}
      {editing && <RenameDialog key={editing.address} caller={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function LoadError({ what, error, retry, retrying }: { what: string; error: Error | null; retry: () => void; retrying: boolean }) {
  return (
    <Notice
      tone="bad"
      title={`Could not load ${what}`}
      action={
        <Button size="sm" onClick={retry} loading={retrying}>
          Try again
        </Button>
      }
    >
      {error?.message}
    </Notice>
  );
}

function StaleNotice({ error }: { error: Error | null }) {
  if (!error) return null;
  return (
    <div className="mb-3">
      <Notice tone="warn" title="Showing the last list loaded">
        Refreshing failed: {error.message}
      </Notice>
    </div>
  );
}

/** One page of posts or calls with its counts, empty states and paging. */
function ContentPanel<T>({
  kind,
  query,
  state,
  caller,
  offset,
  onOffset,
  children,
}: {
  kind: ContentKind;
  query: { data: ContentPage<T> | undefined; isPending: boolean; isFetching: boolean; isError: boolean; error: Error | null; refetch: () => unknown };
  state: ModerationState;
  caller: string;
  offset: number;
  onOffset: (offset: number) => void;
  children: (rows: T[]) => React.ReactNode;
}) {
  const page = query.data;
  const one = kind === "calls" ? "call" : kind === "signals" ? "signal" : "post";
  const filtered = Boolean(caller) || state !== "all";
  if (query.isPending) return <ListSkeleton />;
  if (!page) return <LoadError what={`${one}s`} error={query.error} retry={() => void query.refetch()} retrying={query.isFetching} />;
  if (page.rows.length === 0) {
    const Icon = kind === "calls" ? Megaphone : kind === "signals" ? Radio : MessageSquare;
    return (
      <EmptyState icon={<Icon size={20} aria-hidden />} title={filtered ? `No ${one}s match` : `No ${one}s yet`}>
        {filtered
          ? `Nothing ${state === "hidden" ? "hidden " : state === "visible" ? "visible " : ""}${caller ? `by ${caller}` : "here"}.`
          : kind === "calls"
            ? "Calls made on live trends show up here as callers make them."
            : kind === "signals"
              ? "Paid signals show up here as leaders publish them."
              : "Posts on trend threads show up here as callers write them."}
      </EmptyState>
    );
  }
  const from = offset + 1;
  const to = Math.min(offset + PAGE, page.matching);
  return (
    <>
      <StaleNotice error={query.isError ? query.error : null} />
      <p className="mb-3 text-xs text-subtle tabular-nums" data-testid="moderation-counts">
        {plural(page.total, one)} in all, {page.hidden === 0 ? "none" : formatNumber(page.hidden)} hidden
      </p>
      {children(page.rows)}
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-xs text-subtle tabular-nums" data-testid="moderation-range">
          {from}&ndash;{to} of {plural(page.matching, filtered ? "match" : one, filtered ? "matches" : `${one}s`)}
        </p>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" icon={<ChevronLeft size={15} aria-hidden />} disabled={offset === 0 || query.isFetching} onClick={() => onOffset(Math.max(0, offset - PAGE))}>
            Newer
          </Button>
          <Button size="sm" variant="ghost" disabled={to >= page.matching || query.isFetching} onClick={() => onOffset(offset + PAGE)}>
            Older
            <ChevronRight size={15} aria-hidden />
          </Button>
        </div>
      </div>
    </>
  );
}
