"use client";
import { useQueryClient } from "@tanstack/react-query";
import { Snowflake } from "lucide-react";
import Link from "next/link";
// A namespace read, since only Next's bundled React (canary) exports it; plain React would fail to import it.
import * as React from "react";
import { FORWARD } from "@/components/shell/PageTransition";
import { Badge, cn, Delta, Num, Sparkline } from "@/components/ui";
import { type Trend, trends } from "@/lib/api";
import { assetClassLabel } from "@/lib/format";
import { attentionStory, trendName } from "@/lib/trends";

const { ViewTransition } = React;

const ONE_DECIMAL = { minimumFractionDigits: 1, maximumFractionDigits: 1 };

/**
 * The names a trend's card shares with its page: its name, index and sparkline morph into the
 * page's title, index and chart (see Morph). Only one element per name may be on screen.
 */
export const morphName = (part: "title" | "index" | "chart", t: Pick<Trend, "id">) => `trend-${part}-${t.id}`;

/** A named element that morphs into its namesake on the next page, or a plain one when `on` is false. */
export function Morph({ name, on = true, children }: { name: string; on?: boolean; children: React.ReactNode }) {
  if (!on) return children;
  return (
    <ViewTransition name={name} share="morph" default="none">
      {children}
    </ViewTransition>
  );
}

/**
 * A trend's card. `morph` names its parts for the move into the trend's page; a list that renders
 * the same trend twice (one copy hidden per screen size) names only the visible one.
 */
export function TrendCard({ trend: t, tradable, className, morph = true }: { trend: Trend; tradable?: boolean; className?: string; morph?: boolean }) {
  const name = trendName(t);
  const client = useQueryClient();
  // The trend's page renders whole in the navigation's first frame (so the morph has both ends)
  // when its data is already here: fetch it the moment the card is about to be chosen.
  const warm = () => void client.prefetchQuery({ queryKey: ["trend", t.identifier], queryFn: () => trends.get(t.identifier), staleTime: 10_000 });
  return (
    <Link
      href={`/t/${t.identifier}`}
      transitionTypes={FORWARD}
      onPointerEnter={warm}
      onFocus={warm}
      onTouchStart={warm}
      className={cn("group flex h-full flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-card transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-line-strong", className)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge>{assetClassLabel(t.assetClass)}</Badge>
            {t.status === "cooling" ? (
              <Badge tone="warn" icon={<Snowflake className="size-3" aria-hidden />}>
                Cooling
              </Badge>
            ) : null}
            {tradable ? <Badge tone="primary">Hyperliquid</Badge> : null}
          </div>
          <Morph name={morphName("title", t)} on={morph}>
            <h3 className="mt-2.5 line-clamp-2 w-fit font-strong text-[16px] leading-6 text-text">{name}</h3>
          </Morph>
          {t.summary ? <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-text-2">{t.summary}</p> : null}
        </div>
      </div>
      <div className="mt-auto flex items-end justify-between gap-3">
        <div>
          <p className="text-[11.5px] uppercase tracking-[0.08em] text-text-3">Attention</p>
          <div className="mt-1 flex items-baseline gap-2">
            <Morph name={morphName("index", t)} on={morph}>
              <span className="num-display font-display text-[30px] leading-none text-text">
                <Num value={t.index} format={ONE_DECIMAL} />
              </span>
            </Morph>
            <Delta value={t.change24h ?? null} className="text-[13px]" />
          </div>
        </div>
        <Morph name={morphName("chart", t)} on={morph}>
          <Sparkline values={t.spark ?? []} width={112} height={40} />
        </Morph>
      </div>
      <p className="truncate border-t border-line pt-3 text-[12px] text-text-3">
        {[...attentionStory(t).slice(0, 3), ...(t.index >= t.peakIndex && (t.change24h ?? 0) > 5 ? ["at its peak"] : [])].join("  ·  ") || "Measuring attention"}
      </p>
    </Link>
  );
}

export function TrendCardSkeleton() {
  return (
    <div className="flex h-[236px] flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-5">
      <div className="skeleton h-6 w-20" />
      <div className="skeleton h-5 w-3/4" />
      <div className="mt-auto skeleton h-9 w-1/2" />
    </div>
  );
}
