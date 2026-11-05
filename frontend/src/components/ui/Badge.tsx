import type { ReactNode } from "react";
import { cn } from "./cn";

export type BadgeTone = "neutral" | "primary" | "accent" | "up" | "down" | "warn";
const tones: Record<BadgeTone, string> = {
  neutral: "bg-surface-2 text-text-2 border-line",
  primary: "bg-primary-soft text-primary border-transparent",
  accent: "bg-accent-soft text-text border-transparent",
  up: "bg-up-soft text-up border-transparent",
  down: "bg-down-soft text-down border-transparent",
  warn: "bg-warn-soft text-warn border-transparent",
};

export function Badge({ tone = "neutral", children, className, icon }: { tone?: BadgeTone; children: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <span className={cn("inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 font-strong text-[11.5px] tracking-[0.01em]", tones[tone], className)}>
      {icon}
      {children}
    </span>
  );
}
