"use client";
import { ArrowRight, ChevronRight, Radar as RadarIcon } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { FORWARD } from "@/components/shell/PageTransition";
import type { Radar } from "@/lib/api";
import { useEdgeFade } from "@/lib/edges";
import { heatingOrder, RadarCard } from "./RadarCard";
import { useWatch } from "./useWatch";

/** How many cards the markets page shows before "See all". */
const SHOWN = 24;

/**
 * The markets page's "On the radar": the candidates heating up fastest, in two rows that scroll
 * sideways (one on phones), ending in a card to the full radar.
 */
export function RadarStrip({ radar }: { radar: Radar }) {
  const watch = useWatch();
  const fade = useEdgeFade();
  const shown = useMemo(() => [...radar.candidates].sort(heatingOrder).slice(0, SHOWN), [radar]);
  const total = radar.candidates.length;
  return (
    <section aria-labelledby="upcoming-title" className="flex flex-col gap-3" data-testid="radar-strip">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <RadarIcon className="size-[18px] translate-y-[3px] text-primary" aria-hidden />
          <h2 id="upcoming-title" className="font-strong text-[15px] text-text">
            On the radar
          </h2>
          <span className="text-[13px] text-text-3">
            {total} waiting<span className="hidden sm:inline"> · measuring attention before listing</span>
          </span>
        </div>
        <Link href="/radar" transitionTypes={FORWARD} className="inline-flex shrink-0 items-center gap-0.5 font-strong text-[13px] text-text-2 transition-colors hover:text-text" data-testid="radar-see-all">
          See all
          <ChevronRight className="size-4" aria-hidden />
        </Link>
      </div>
      <div {...fade} className="edge-fade no-scrollbar -mx-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
        <div className="grid auto-cols-[264px] grid-flow-col grid-rows-1 gap-3 sm:grid-rows-2">
          {shown.map((c) => (
            <RadarCard key={c.id} c={c} watching={watch.ids.has(c.id)} pending={watch.pending === c.id} onWatch={watch.toggle} />
          ))}
          <Link
            href="/radar"
            transitionTypes={FORWARD}
            className="group flex flex-col items-start justify-center gap-2 rounded-2xl border border-dashed border-line-strong bg-surface-2 p-5 transition-colors hover:border-primary sm:row-span-2"
          >
            <span className="font-display text-[26px] leading-none text-text tabular-nums">{total}</span>
            <span className="font-strong text-[14px] text-text">See every topic on the radar</span>
            <span className="text-[12.5px] leading-[18px] text-text-2">Each lists the moment a live slot opens, strongest first.</span>
            <span className="mt-1 inline-flex items-center gap-1 font-strong text-[13px] text-primary">
              Open the radar
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
            </span>
          </Link>
        </div>
      </div>
    </section>
  );
}
