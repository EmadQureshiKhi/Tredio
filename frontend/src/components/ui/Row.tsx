import type { ReactNode } from "react";
import { cn } from "./cn";

/** A label and value on one line, for order summaries and risk panels. */
export function Row({ label, value, tone, className }: { label: ReactNode; value: ReactNode; tone?: "up" | "down" | "warn" | "muted"; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-3 text-[13px]", className)}>
      <span className="text-text-2">{label}</span>
      <span className={cn("num text-right font-strong", tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "warn" ? "text-warn" : tone === "muted" ? "text-text-3" : "text-text")}>{value}</span>
    </div>
  );
}
