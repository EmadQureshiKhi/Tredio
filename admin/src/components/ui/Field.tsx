import type { ReactNode } from "react";

/** Input styling shared by every text field, red when the value is invalid. */
export function inputClass(invalid: boolean, extra = ""): string {
  return `w-full rounded-lg border bg-surface px-3 text-sm text-fg outline-none transition-[border-color,box-shadow] placeholder:text-subtle focus:ring-[3px] disabled:opacity-60 ${
    invalid ? "border-bad focus:ring-bad/20" : "border-line-strong focus:border-accent focus:ring-ring"
  } ${extra}`;
}

/** A labelled field with an optional character counter and one message line (error, warning or hint). */
export function Field({
  id,
  label,
  counter,
  error,
  warning,
  hint,
  aside,
  children,
}: {
  id: string;
  label: string;
  counter?: { value: number; max: number };
  error?: string;
  warning?: string;
  hint?: ReactNode;
  /** Shown at the right of the label row, after the counter. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  const message = error ?? warning ?? hint;
  return (
    <div>
      <div className="mb-1.5 flex min-h-5 items-center justify-between gap-3">
        <label htmlFor={id} className="text-[13px] font-medium text-fg">
          {label}
        </label>
        <div className="flex items-center gap-3">
          {aside}
          {counter && (
            <span className={`text-xs tabular-nums ${counter.value > counter.max ? "font-medium text-bad" : "text-subtle"}`} aria-hidden>
              {counter.value}/{counter.max}
            </span>
          )}
        </div>
      </div>
      {children}
      {message && (
        <p id={`${id}-message`} className={`mt-1.5 text-xs leading-5 ${error ? "text-bad" : warning ? "text-warn" : "text-subtle"}`}>
          {message}
        </p>
      )}
    </div>
  );
}

/** Props that tie an input to its Field message. */
export function describedBy(id: string, invalid: boolean, hasMessage: boolean) {
  return { "aria-invalid": invalid || undefined, "aria-describedby": hasMessage ? `${id}-message` : undefined } as const;
}
