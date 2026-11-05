"use client";
import { type ReactNode, useEffect, useState } from "react";
import { Card, cn, Num } from "@/components/ui";

/** Small building blocks of the portfolio screen. */

export { amountText, parseAmount, signedUsdc, signedPct, tokens, toneOf, windowShort } from "./format";

const SIGNED = { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "exceptZero" } as const;
const SIGNED_PCT = { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: "exceptZero" } as const;

/** Live PnL that rolls as it moves (in its own tone, so without a flash): "+1.20", "-0.40", "0.00". */
export const SignedUsdc = ({ value, testId }: { value: number; testId?: string }) => <Num value={value} format={SIGNED} flash={false} testId={testId} />;
export const SignedPct = ({ value }: { value: number }) => <Num value={value} format={SIGNED_PCT} suffix="%" flash={false} />;

/** The current time, ticking every `ms` (for countdowns). */
export function useNow(ms = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** One portfolio section: a titled card with its total on the right and rows below. */
export function SectionCard({ id, title, count, subtitle, total, totalLabel = "Value", children, testId, action }: { id: string; title: string; count?: number; subtitle?: ReactNode; total?: ReactNode; totalLabel?: string; children: ReactNode; testId?: string; action?: ReactNode }) {
  return (
    <Card className="overflow-hidden" data-testid={testId}>
      <section aria-labelledby={id}>
        <div className="flex items-start justify-between gap-4 px-4 pb-4 pt-5 sm:px-6">
          <div className="min-w-0">
            <h2 id={id} className="flex items-center gap-2 font-strong text-[16px] leading-6 text-text">
              {title}
              {count !== undefined ? <span className="num rounded-full bg-surface-2 px-2 font-strong text-[12px] leading-5 text-text-2">{count}</span> : null}
            </h2>
            {subtitle ? <p className="mt-0.5 text-[13px] leading-5 text-text-2">{subtitle}</p> : null}
          </div>
          {total !== undefined ? (
            <div className="shrink-0 text-right">
              <p className="text-[11px] uppercase tracking-[0.08em] text-text-3">{totalLabel}</p>
              <p className="num mt-0.5 font-strong text-[16px] leading-6 text-text">{total}</p>
            </div>
          ) : null}
          {action}
        </div>
        {children}
      </section>
    </Card>
  );
}

/** A label over a value, for the figures inside a row. */
export function Figure({ label, children, className, align = "left" }: { label: ReactNode; children: ReactNode; className?: string; align?: "left" | "right" }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", align === "right" && "items-end text-right", className)}>
      <span className="truncate text-[11px] uppercase tracking-[0.08em] text-text-3">{label}</span>
      <span className="num truncate font-strong text-[14px] leading-5 text-text">{children}</span>
    </div>
  );
}

/** Placeholder rows while a section loads, at the height of real rows. */
export function SkeletonRows({ rows = 2 }: { rows?: number }) {
  return (
    <div className="flex flex-col divide-y divide-line border-t border-line" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex flex-col gap-3 px-4 py-4 sm:px-6">
          <div className="flex items-center justify-between gap-4">
            <div className="skeleton h-5 w-44" />
            <div className="skeleton h-5 w-20" />
          </div>
          <div className="skeleton h-4 w-64 max-w-full" />
        </div>
      ))}
    </div>
  );
}
