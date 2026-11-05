import { CircleAlert, CircleCheck, CircleDashed, CircleMinus, CirclePause, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, type Tone } from "@/src/components/ui/Badge";
import { formatAge, formatDate } from "@/src/lib/format";
import type { Severity } from "@/src/types/admin";

/** Building blocks of the system page. Status is always an icon and a word, never color alone. */

const ICONS = { ok: CircleCheck, warn: TriangleAlert, bad: CircleAlert, neutral: CircleDashed, accent: Info } as const;

/** A status chip: icon plus text in the tone's colors. */
export function Chip({ tone, children, icon, testId, title }: { tone: Tone; children: ReactNode; icon?: ReactNode; testId?: string; title?: string }) {
  const Icon = ICONS[tone];
  return (
    <Badge tone={tone} testId={testId} title={title}>
      {icon ?? <Icon size={12} aria-hidden className="-ml-0.5" />}
      {children}
    </Badge>
  );
}

/** Each state word the page shows, its tone and its label. */
const STATES: Record<string, { tone: Tone; label: string; icon?: ReactNode }> = {
  up: { tone: "ok", label: "Up" },
  ok: { tone: "ok", label: "OK" },
  degraded: { tone: "warn", label: "Degraded" },
  down: { tone: "bad", label: "Down" },
  idle: { tone: "neutral", label: "Idle" },
  never: { tone: "neutral", label: "Never run" },
  off: { tone: "neutral", label: "Off", icon: <CircleMinus size={12} aria-hidden className="-ml-0.5" /> },
  resting: { tone: "warn", label: "Resting", icon: <CirclePause size={12} aria-hidden className="-ml-0.5" /> },
  failing: { tone: "bad", label: "Failing" },
  stale: { tone: "warn", label: "Stale" },
  rejected: { tone: "bad", label: "Rejected" },
  "rate-limited": { tone: "warn", label: "Rate limited", icon: <CirclePause size={12} aria-hidden className="-ml-0.5" /> },
  quota: { tone: "warn", label: "Out of credits" },
  "route-down": { tone: "bad", label: "Route down" },
  "route-auth": { tone: "bad", label: "Route refused" },
  error: { tone: "bad", label: "Error" },
  healthy: { tone: "ok", label: "Healthy" },
  unhealthy: { tone: "bad", label: "Failing" },
  reserve: { tone: "neutral", label: "Reserve" },
};

export function StateChip({ state, testId, title }: { state: string; testId?: string; title?: string }) {
  const s = STATES[state] ?? { tone: "neutral" as Tone, label: state };
  return (
    <Chip tone={s.tone} icon={s.icon} testId={testId} title={title}>
      {s.label}
    </Chip>
  );
}

export const SEVERITY: Record<Severity, { tone: Tone; label: string }> = {
  critical: { tone: "bad", label: "Critical" },
  warning: { tone: "warn", label: "Warning" },
  info: { tone: "neutral", label: "Note" },
};

/** "2m ago" for a time, with the full date on hover; "never" without one. */
export function Age({ at, now, className = "" }: { at: number | null | undefined; now: number; className?: string }) {
  if (at === null || at === undefined) return <span className="text-subtle">never</span>;
  return (
    <time dateTime={new Date(at).toISOString()} title={formatDate(at)} className={className}>
      {formatAge(at, now)}
    </time>
  );
}

/** A thin bar from 0 to 100%, with a marker; the number beside it says what it means. */
export function Meter({ pct, tone = "accent", label }: { pct: number; tone?: Tone; label: string }) {
  const fill = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", neutral: "bg-subtle", accent: "bg-accent" }[tone];
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-raised ring-1 ring-line ring-inset" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(100, Math.max(0, pct)))}>
      <span className={`block h-full rounded-full ${fill}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  );
}

/** A section of the page with its heading, an anchor and an optional action on the right. */
export function Section({ id, title, description, action, children }: { id: string; title: string; description?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="mt-10 scroll-mt-28 sm:scroll-mt-20">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="text-base font-semibold text-fg">
            {title}
          </h2>
          {description ? <p className="mt-0.5 max-w-3xl text-[13px] leading-5 text-muted">{description}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** A monospace error line: red while it is the latest outcome, muted once something succeeded after it. */
export function ErrorText({ children, current = true }: { children: ReactNode; current?: boolean }) {
  return <p className={`mt-1 [overflow-wrap:anywhere] font-mono text-xs leading-5 ${current ? "text-bad" : "text-subtle"}`}>{children}</p>;
}

const count = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
/** 12,345 as "12.3K" where room is short. */
export const compact = (n: number) => count.format(n);
