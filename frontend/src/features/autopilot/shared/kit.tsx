"use client";
import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { BACK } from "@/components/shell/PageTransition";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { cn } from "@/components/ui";

/**
 * Small building blocks shared by the Autopilot, Copy, Leaders, caller and Settings screens, in the
 * app's visual language: display serif titles, quiet secondary text, 1 px line borders.
 */

export function PageHeader({ title, description, action, back }: { title: ReactNode; description?: ReactNode; action?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {back ? (
          <Link href={back.href} transitionTypes={BACK} className="mb-2 inline-flex items-center gap-1 font-strong text-[13px] text-text-3 transition-colors hover:text-text">
            <ChevronDown className="size-3.5 rotate-90" aria-hidden />
            {back.label}
          </Link>
        ) : null}
        <h1 className="font-display text-[30px] leading-[1.1] text-text sm:text-[36px]">{title}</h1>
        {description ? <p className="mt-2 max-w-2xl text-[14px] leading-[22px] text-text-2">{description}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 flex-wrap gap-2">{action}</div> : null}
    </header>
  );
}

export function SectionTitle({ title, subtitle, action, id, as: Tag = "h2" }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; id?: string; as?: "h2" | "h3" }) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div className="min-w-0">
        <Tag id={id} className="font-strong text-[16px] leading-6 text-text">
          {title}
        </Tag>
        {subtitle ? <p className="mt-0.5 text-[13px] leading-5 text-text-2">{subtitle}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** One figure with its label: PnL, win rate, drawdown. */
export function StatTile({ label, value, tone, hint, className, size = "md" }: { label: string; value: ReactNode; tone?: "up" | "down" | "muted"; hint?: ReactNode; className?: string; size?: "md" | "lg" }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1 rounded-2xl border border-line bg-surface-2/60 px-4 py-3", className)}>
      <span className="truncate text-[11.5px] uppercase tracking-[0.08em] text-text-3">{label}</span>
      <span
        className={cn(
          // The headline tile reads larger on phones, where it spans the row; the type is the same.
          size === "lg" ? "num font-strong text-[24px] leading-8 sm:text-[18px] sm:leading-7" : "num font-strong text-[18px] leading-7",
          tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "muted" ? "text-text-3" : "text-text",
        )}
      >
        {value}
      </span>
      {hint ? <span className="line-clamp-2 text-[12px] leading-4 text-text-3">{hint}</span> : null}
    </div>
  );
}

/** A native select drawn as a pill, for choices inside a sentence. */
export function SelectPill<T extends string | number>({
  value,
  onChange,
  options,
  label,
  invalid,
  className,
  testId,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<{ value: T; label: string; group?: string }>;
  label: string;
  invalid?: boolean;
  className?: string;
  testId?: string;
}) {
  const groups = [...new Set(options.map((o) => o.group ?? ""))];
  const render = (o: { value: T; label: string }) => (
    <option key={String(o.value)} value={String(o.value)}>
      {o.label}
    </option>
  );
  return (
    <span className={cn("relative inline-flex max-w-full align-middle leading-5", className)}>
      <select
        aria-label={label}
        data-testid={testId}
        aria-invalid={invalid || undefined}
        value={String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          const match = options.find((o) => String(o.value) === raw);
          if (match) onChange(match.value);
        }}
        className={cn(
          "h-9 max-w-full cursor-pointer appearance-none truncate rounded-[10px] border bg-surface-2 pl-3 pr-8 font-strong text-[14px] text-text outline-none transition-colors hover:border-line-strong focus-visible:border-primary",
          invalid ? "border-down" : "border-line",
        )}
      >
        {groups.length > 1 || groups[0] !== ""
          ? groups.map((g) => (
              <optgroup key={g} label={g}>
                {options.filter((o) => (o.group ?? "") === g).map(render)}
              </optgroup>
            ))
          : options.map(render)}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-text-3" aria-hidden />
    </span>
  );
}

/** A number input drawn as a pill, sized to its content, for amounts inside a sentence. */
export function NumberPill({
  value,
  onChange,
  label,
  prefix,
  suffix,
  invalid,
  width = 5,
  testId,
  decimals = true,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  prefix?: string;
  suffix?: string;
  invalid?: boolean;
  /** Minimum width in characters. */
  width?: number;
  testId?: string;
  decimals?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-9 items-center rounded-[10px] border bg-surface-2 px-2.5 align-middle leading-5 transition-colors focus-within:border-primary hover:border-line-strong",
        invalid ? "border-down" : "border-line",
      )}
    >
      {prefix ? <span className="mr-0.5 font-strong text-[14px] text-text-3">{prefix}</span> : null}
      <input
        aria-label={label}
        aria-invalid={invalid || undefined}
        data-testid={testId}
        inputMode={decimals ? "decimal" : "numeric"}
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(decimals ? /[^0-9.]/g : /[^0-9]/g, ""))}
        style={{ width: `${Math.max(width, value.length + 0.5)}ch` }}
        className="num h-full min-w-0 bg-transparent text-center font-strong text-[14px] text-text outline-none"
      />
      {suffix ? <span className="ml-0.5 font-strong text-[13px] text-text-3">{suffix}</span> : null}
    </span>
  );
}

/** A choice between a few words inside a sentence (up or down, long or short). */
export function ChoicePill<T extends string>({ value, onChange, options, label, testId }: { value: T; onChange: (v: T) => void; options: ReadonlyArray<{ value: T; label: string; tone?: "up" | "down" }>; label: string; testId?: string }) {
  return (
    <span role="radiogroup" aria-label={label} data-testid={testId} className="inline-flex h-9 items-center rounded-[10px] border border-line bg-surface-2 p-[3px] align-middle leading-5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "h-full rounded-[7px] px-2.5 font-strong text-[13.5px] transition-colors",
              active ? (o.tone === "up" ? "bg-up text-[#04140d]" : o.tone === "down" ? "bg-down text-[#1b0606]" : "bg-surface text-text shadow-[0_1px_2px_rgba(0,0,0,0.2)]") : "text-text-2 hover:text-text",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </span>
  );
}

/**
 * A button that asks once more before acting: the first press arms it, the second confirms.
 * It disarms itself after a few seconds or when focus leaves.
 */
export function useConfirm(timeoutMs = 4000) {
  const [armed, setArmed] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return {
    armed,
    /** True when `key` was already armed (go ahead); otherwise arms it and returns false. */
    confirm(key: string): boolean {
      if (armed === key) {
        setArmed(null);
        return true;
      }
      setArmed(key);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setArmed(null), timeoutMs);
      return false;
    },
    disarm: () => setArmed(null),
  };
}

/** A labelled multi-line input matching Field. */
export function TextArea({ label, value, onChange, max, placeholder, rows = 3, hint, testId }: { label: string; value: string; onChange: (v: string) => void; max: number; placeholder?: string; rows?: number; hint?: ReactNode; testId?: string }) {
  const id = useId();
  const over = value.length > max;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="font-strong text-[12.5px] text-text-2">
          {label}
        </label>
        <span className={cn("num text-[12px]", over ? "text-down" : "text-text-3")} aria-live="polite">
          {value.length}/{max}
        </span>
      </div>
      <textarea
        id={id}
        data-testid={testId}
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={over || undefined}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className={cn("w-full resize-none rounded-xl border bg-surface-2 px-3 py-2.5 text-[15px] leading-[22px] text-text outline-none transition-colors placeholder:text-text-3 focus:border-primary", over ? "border-down" : "border-line")}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-[12px] leading-4 text-text-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A thin progress meter, for a cap that is being used up. */
export function Meter({ value, max, label, tone = "primary" }: { value: number; max: number; label: string; tone?: "primary" | "warn" | "down" }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
      <div className={cn("h-full rounded-full transition-[width] duration-500", tone === "down" ? "bg-down" : tone === "warn" ? "bg-warn" : "bg-primary")} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** A quiet note that a background refresh failed while the last data stays on screen. */
export function StaleNote({ onRetry, what = "this" }: { onRetry: () => void; what?: string }) {
  return (
    <p role="status" className="flex items-center gap-2 text-[12.5px] text-text-3">
      <span className="size-1.5 shrink-0 rounded-full bg-warn" aria-hidden />
      Could not refresh {what}; showing the last update.
      <button type="button" onClick={onRetry} className="font-strong text-text-2 underline-offset-2 hover:text-text hover:underline">
        Retry
      </button>
    </p>
  );
}
