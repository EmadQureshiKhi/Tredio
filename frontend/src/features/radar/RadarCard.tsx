"use client";
import { Bell, BellRing, ExternalLink, LoaderCircle, Users } from "lucide-react";
import { Badge, cn, Delta, Sparkline } from "@/components/ui";
import type { Candidate } from "@/lib/api";
import { assetClassLabel, compact } from "@/lib/format";

/** The attention number a card leads with: mentions when measured, else Wikipedia views, else Bluesky posts. */
function headline(c: Candidate): { label: string; value: number | null } {
  const r = c.readings;
  if (r?.mentions) return { label: "Mentions, 24h", value: r.mentions };
  if (r?.wikipedia) return { label: "Wikipedia views", value: r.wikipedia };
  if (r?.bluesky) return { label: "Bluesky posts, 24h", value: r.bluesky };
  return { label: "Attention", value: null };
}

/** Where it stands in the oracle's queue: community picks and the next two list first. */
export function queueBadge(queue: number | null | undefined, pick = false) {
  if (pick)
    return (
      <Badge tone="primary" icon={<Users className="size-3" aria-hidden />}>
        Community pick
      </Badge>
    );
  if (queue === null || queue === undefined) return <span className="text-[11.5px] text-text-3">Measuring</span>;
  if (queue <= 2) return <Badge tone="accent">Next to list</Badge>;
  return <span className="font-strong text-[11.5px] text-text-3 tabular-nums">#{queue} in line</span>;
}

/**
 * An approved candidate waiting for a live slot: what it is, the attention measured so far, where
 * it came from and its place in line, with "Notify me when it lists". Dashed, so it never reads as
 * a market you can trade yet.
 */
export function RadarCard({
  c,
  watching,
  pending,
  onWatch,
  className,
}: {
  c: Candidate;
  watching: boolean;
  pending: boolean;
  onWatch: (c: Candidate) => void;
  className?: string;
}) {
  const lead = headline(c);
  const signal = c.signal;
  return (
    <article className={cn("flex flex-col rounded-2xl border border-dashed border-line-strong bg-surface p-4", className)} data-testid="radar-candidate">
      <div className="flex h-6 items-center justify-between gap-2">
        <span className="text-[11.5px] font-strong uppercase tracking-[0.06em] text-text-3">{assetClassLabel(c.assetClass)}</span>
        {queueBadge(c.queue, c.pick)}
      </div>
      <h3 className="mt-2 line-clamp-1 font-strong text-[15px] leading-5 text-text">{c.displayName}</h3>
      <p className="mt-1 line-clamp-2 min-h-[36px] text-[12.5px] leading-[18px] text-text-2">{c.summary ?? c.identifier}</p>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] text-text-3">{lead.label}</p>
          <p className="font-strong text-[18px] leading-6 text-text tabular-nums">{compact(lead.value === null ? null : Math.round(lead.value))}</p>
        </div>
        <Sparkline values={c.spark ?? []} width={96} height={34} className="shrink-0" />
      </div>
      <div className="mt-2 flex min-h-[18px] items-center gap-1.5 text-[11.5px] leading-4 text-text-3">
        <span className="truncate">
          {signal ? signal.label : "Radar"}
          {signal?.count ? ` · ${compact(Math.round(signal.count))} ${signal.unit ?? ""}` : ""}
        </span>
        {c.heating !== null && c.heating !== undefined ? <Delta value={c.heating} className="shrink-0 text-[11.5px]" /> : null}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-3">
        <button
          type="button"
          onClick={() => onWatch(c)}
          disabled={pending}
          aria-pressed={watching}
          title={watching ? "You'll hear when it lists. Tap to stop." : "Hear when it lists. Each wait counts toward community picks."}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 font-strong text-[12.5px] transition-colors",
            watching ? "border-transparent bg-primary-soft text-primary" : "border-line bg-surface text-text-2 hover:text-text",
          )}
          data-testid="radar-watch"
        >
          {pending ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : watching ? <BellRing className="size-3.5" aria-hidden /> : <Bell className="size-3.5" aria-hidden />}
          {watching ? "Watching" : "Notify me"}
        </button>
        <span className="text-[11.5px] text-text-3 tabular-nums" data-testid="radar-watchers">{c.watchers ? `${c.watchers} want this` : ""}</span>
      </div>
      {c.attribution ? (
        // CoinGecko's free API asks for this credit wherever its data shows.
        <a href={c.attribution.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 self-start text-[11.5px] leading-4 text-text-3 transition-colors hover:text-text" data-testid="radar-attribution">
          {c.attribution.text}
          <ExternalLink className="size-3 shrink-0" aria-hidden />
        </a>
      ) : null}
    </article>
  );
}

/** "Heating up": community picks and the next to list first, then the steepest rise, then the most mentions. */
export function heatingOrder(a: Candidate, b: Candidate): number {
  const nextA = a.pick || (a.queue !== null && a.queue !== undefined && a.queue <= 2) ? 0 : 1;
  const nextB = b.pick || (b.queue !== null && b.queue !== undefined && b.queue <= 2) ? 0 : 1;
  return nextA - nextB || (b.heating ?? -1e9) - (a.heating ?? -1e9) || (b.readings?.mentions ?? 0) - (a.readings?.mentions ?? 0);
}

/** "Most wanted": the most accounts waiting first, then heating up. */
export function wantedOrder(a: Candidate, b: Candidate): number {
  return (b.watchers ?? 0) - (a.watchers ?? 0) || heatingOrder(a, b);
}
