import { pct } from "@/lib/format";
import { cn } from "./cn";

/** A signed percent change, colored by direction. */
export function Delta({ value, className, digits = 1 }: { value: number | null | undefined; className?: string; digits?: number }) {
  const tone = value === null || value === undefined || Math.abs(value) < 10 ** -digits / 2 ? "text-text-3" : value > 0 ? "text-up" : "text-down";
  return <span className={cn("num font-strong", tone, className)}>{pct(value, digits)}</span>;
}
