"use client";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { AnimatePresence, m } from "framer-motion";
import Link from "next/link";
import { Badge, cn, listItem } from "@/components/ui";
import type { Call, Trend } from "@/lib/api";
import { ago, countdown } from "@/lib/format";
import { trendLabel } from "@/features/autopilot/shared/rule-text";

const OUTCOME = { open: { label: "Open", tone: "neutral" }, hit: { label: "Hit", tone: "up" }, miss: { label: "Miss", tone: "down" }, void: { label: "Void", tone: "warn" } } as const;

/** A caller's calls with their outcome: opening and closing index, and when they resolve. */
export function CallList({ calls, trends }: { calls: Call[]; trends: Trend[] | undefined }) {
  return (
    <ul className="relative divide-y divide-line overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface" data-testid="call-list">
      <AnimatePresence initial={false} mode="popLayout">
        {calls.map((c) => {
          const o = OUTCOME[c.outcome];
          const up = c.direction === "up";
          const id = c.identifier ?? "";
          return (
            <m.li key={c.id} {...listItem} className="flex gap-3 px-4 py-3.5 sm:px-5" data-testid="call-row" data-outcome={c.outcome} data-trend={id}>
              <span className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full", up ? "bg-up-soft text-up" : "bg-down-soft text-down")} aria-hidden>
                {up ? <ArrowUpRight className="size-4" /> : <ArrowDownRight className="size-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 text-[14px] leading-5 text-text">
                    <span className="font-strong">{up ? "Up" : "Down"}</span> on{" "}
                    <Link href={`/t/${id}`} className="font-strong hover:underline hover:underline-offset-4">
                      {trendLabel(id, trends)}
                    </Link>
                    <span className="text-text-3"> · {c.horizon_sec >= 604_800 ? "7 days" : "24h"}</span>
                  </p>
                  <Badge tone={o.tone} className="shrink-0">
                    {o.label}
                  </Badge>
                </div>
                <p className="num mt-1 text-[12.5px] text-text-2">
                  Opened at {c.opening_index.toFixed(2)}
                  {c.closing_index !== null ? (
                    <>
                      {" "}
                      <span className="text-text-3">→</span> closed at {c.closing_index.toFixed(2)}
                    </>
                  ) : c.outcome === "open" ? (
                    <span className="text-text-3"> · resolves in {countdown(c.resolves_at)}</span>
                  ) : null}
                  <span className="text-text-3"> · {ago(c.called_at)}</span>
                </p>
                {c.note ? <p className="mt-1.5 break-words text-[13px] leading-5 text-text-2">{c.note}</p> : null}
              </div>
            </m.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}
