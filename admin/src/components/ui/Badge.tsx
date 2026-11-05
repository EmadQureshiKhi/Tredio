import type { ReactNode } from "react";

export type Tone = "neutral" | "accent" | "ok" | "bad" | "warn";

const TONES: Record<Tone, string> = {
  neutral: "border-line bg-raised text-muted",
  accent: "border-transparent bg-accent-soft text-accent",
  ok: "border-transparent bg-ok-soft text-ok",
  bad: "border-transparent bg-bad-soft text-bad",
  warn: "border-transparent bg-warn-soft text-warn",
};

export function Badge({ tone = "neutral", children, title, className = "", testId }: { tone?: Tone; children: ReactNode; title?: string; className?: string; testId?: string }) {
  return (
    <span
      title={title}
      data-testid={testId}
      className={`inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 text-[11px] font-medium leading-none ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/** A small status light with a text label (never color alone). */
export function StatusDot({ tone }: { tone: Tone }) {
  const color = { neutral: "bg-subtle", accent: "bg-accent", ok: "bg-ok", bad: "bg-bad", warn: "bg-warn" }[tone];
  return <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${color}`} />;
}
