"use client";
import { type InputHTMLAttributes, type ReactNode, useId } from "react";
import { cn } from "./cn";

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  suffix?: ReactNode;
  action?: ReactNode;
  /** Keeps a line for the hint or error even when there is none, so one appearing never moves what follows. */
  reserveNote?: boolean;
}

/** A labelled input with an optional unit suffix, action (like Max), hint and error. */
export function Field({ label, hint, error, suffix, action, reserveNote, className, ...rest }: Props) {
  const id = useId();
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="font-strong text-[12.5px] text-text-2">
          {label}
        </label>
        {action}
      </div>
      <div className={cn("flex h-11 items-center rounded-xl border bg-surface-2 px-3 transition-colors focus-within:border-primary", error ? "border-down" : "border-line")}>
        <input
          id={id}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={error || hint ? `${id}-note` : undefined}
          className="num h-full min-w-0 flex-1 bg-transparent text-[15px] text-text outline-none placeholder:text-text-3"
          {...rest}
        />
        {suffix ? <span className="ml-2 shrink-0 font-strong text-[12.5px] text-text-3">{suffix}</span> : null}
      </div>
      {error || hint || reserveNote ? (
        <p id={`${id}-note`} className={cn("min-h-4 text-[12px] leading-4", error ? "text-down" : "text-text-3")}>
          {error ?? hint}
        </p>
      ) : null}
    </div>
  );
}
