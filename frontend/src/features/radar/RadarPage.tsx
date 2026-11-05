"use client";
import { Radar as RadarIcon, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Button, Empty, ErrorNote, Segmented, Skeleton } from "@/components/ui";
import { PageHeader } from "@/features/autopilot/shared/kit";
import type { Candidate } from "@/lib/api";
import { useUpcoming } from "@/lib/hooks/queries";
import { heatingOrder, RadarCard, wantedOrder } from "./RadarCard";
import { useWatch } from "./useWatch";

type Filter = "all" | "crypto" | "person" | "topic" | "markets";
type Sort = "heating" | "wanted" | "next" | "new";

const FILTERS = [
  { value: "all", label: "All" },
  { value: "crypto", label: "Crypto" },
  { value: "person", label: "People" },
  { value: "topic", label: "Topics" },
  { value: "markets", label: "Stocks & politics" },
] as const;

const PAGE = 24;

function matches(c: Candidate, f: Filter) {
  if (f === "all") return true;
  if (f === "markets") return c.assetClass === "equity" || c.assetClass === "politics" || c.assetClass === "commodity" || c.assetClass === "fx";
  return c.assetClass === f;
}

const byQueue = (a: Candidate, b: Candidate) => (a.queue ?? 1e9) - (b.queue ?? 1e9) || heatingOrder(a, b);
const byNewest = (a: Candidate, b: Candidate) => Date.parse(b.createdAt) - Date.parse(a.createdAt);

/** Every approved candidate waiting for a live slot, with filters, sorting, search and alerts. */
export default function RadarPage() {
  const radar = useUpcoming();
  const watch = useWatch();
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("heating");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);

  const all = useMemo(() => radar.data?.candidates ?? [], [radar.data]);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = all.filter((c) => matches(c, filter) && (!q || c.displayName.toLowerCase().includes(q) || (c.summary ?? "").toLowerCase().includes(q) || c.keywords.some((k) => k.toLowerCase().includes(q))));
    return rows.sort(sort === "heating" ? heatingOrder : sort === "wanted" ? wantedOrder : sort === "next" ? byQueue : byNewest);
  }, [all, filter, sort, query]);
  const heating = all.filter((c) => (c.heating ?? 0) > 0).length;
  const slots = radar.data?.slots;

  return (
    <div className="flex flex-col gap-6" data-testid="radar-page">
      <PageHeader
        back={{ href: "/", label: "Markets" }}
        title="On the radar"
        description="Topics the radar found and approved, waiting for a live slot. Tap Notify me to hear the second one lists: the topics most people wait on become community picks and list first."
      />

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Live markets" value={slots ? `${slots.live} of ${slots.max}` : "-"} />
        <Stat label="Waiting to list" value={radar.data ? String(all.length) : "-"} />
        <Stat label="Heating up" value={radar.data ? String(heating) : "-"} />
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={filter === f.value}
              onClick={() => (setFilter(f.value), setShown(PAGE))}
              className={`h-8 shrink-0 rounded-full border px-3.5 font-strong text-[13px] transition-colors ${filter === f.value ? "border-transparent bg-text text-bg" : "border-line bg-surface text-text-2 hover:text-text"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="relative flex h-9 items-center sm:w-56">
            <Search className="pointer-events-none absolute left-3 size-4 text-text-3" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => (setQuery(e.target.value), setShown(PAGE))}
              placeholder="Search the radar"
              aria-label="Search the radar"
              className="h-9 w-full rounded-full border border-line bg-surface pl-9 pr-3 text-[13px] text-text placeholder:text-text-3 focus:border-primary focus:outline-none"
            />
          </label>
          <Segmented
            label="Sort the radar"
            size="sm"
            value={sort}
            onChange={setSort}
            options={[
              { value: "heating", label: "Heating up" },
              { value: "wanted", label: "Most wanted" },
              { value: "next", label: "Next to list" },
              { value: "new", label: "Newest" },
            ]}
            className="w-full sm:w-auto"
          />
        </div>
      </div>

      {radar.isError ? (
        <ErrorNote message="The radar could not load. It retries every minute." onRetry={() => void radar.refetch()} />
      ) : !radar.data ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-[236px] rounded-2xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <Empty
          icon={<RadarIcon className="size-6" />}
          title={all.length === 0 ? "The radar is clear" : "Nothing matches"}
          body={all.length === 0 ? "Every approved topic already has a live market. New ones appear here as the radar finds them." : "Try another category or search."}
          action={
            all.length > 0 ? (
              <Button tone="secondary" onClick={() => (setFilter("all"), setQuery(""))}>
                Show everything
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {list.slice(0, shown).map((c) => (
              <RadarCard key={c.id} c={c} watching={watch.ids.has(c.id)} pending={watch.pending === c.id} onWatch={watch.toggle} />
            ))}
          </div>
          {list.length > shown ? (
            <div className="flex justify-center">
              <Button tone="secondary" onClick={() => setShown((n) => n + PAGE)}>
                Show {Math.min(PAGE, list.length - shown)} more of {list.length - shown}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface px-4 py-3">
      <p className="text-[12px] text-text-3">{label}</p>
      <p className="mt-0.5 font-strong text-[20px] leading-7 text-text tabular-nums">{value}</p>
    </div>
  );
}
