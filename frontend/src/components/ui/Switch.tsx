"use client";
import { cn } from "./cn";

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn("relative h-6 w-10 shrink-0 rounded-full border transition-colors disabled:opacity-45", checked ? "border-transparent bg-primary" : "border-line bg-surface-3")}
    >
      <span className={cn("absolute left-0 top-0.5 size-[18px] rounded-full bg-white shadow transition-transform", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
    </button>
  );
}
