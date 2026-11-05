"use client";
import { m } from "framer-motion";
import { useId, useState } from "react";
import { cn } from "./cn";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  tone?: "up" | "down";
}

const SLIDE = { type: "spring", duration: 0.32, bounce: 0.12 } as const;
const INSTANT = { duration: 0 } as const;

/**
 * A row of mutually exclusive choices (tabs, side pickers, windows). The selection is one pill
 * that slides to the chosen option; a choice made from the keyboard moves it at once.
 */
export function Segmented<T extends string>({ value, onChange, options, size = "md", className, label }: { value: T; onChange: (v: T) => void; options: readonly SegmentOption<T>[]; size?: "sm" | "md"; className?: string; label: string }) {
  const pill = `segment-${useId()}`;
  const [instant, setInstant] = useState(false);
  return (
    <div role="radiogroup" aria-label={label} className={cn("flex rounded-xl border border-line bg-surface-2 p-1", className)}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={(e) => {
              // A click from Enter or Space reports no pointer clicks (detail 0).
              setInstant(e.detail === 0);
              onChange(o.value);
            }}
            className={cn(
              "relative flex-1 whitespace-nowrap rounded-[9px] font-strong transition-colors duration-150",
              size === "sm" ? "h-7 px-2.5 text-[12.5px]" : "h-9 px-3 text-[13.5px]",
              active ? (o.tone === "up" ? "text-[#04140d]" : o.tone === "down" ? "text-[#1b0606]" : "text-text") : "text-text-2 hover:text-text",
            )}
          >
            {active ? (
              <m.span
                layoutId={pill}
                // Moves only when the choice changes, never with the layout around it.
                layoutDependency={value}
                aria-hidden
                initial={false}
                transition={instant ? INSTANT : SLIDE}
                style={{ borderRadius: 9 }}
                className={cn("absolute inset-0", o.tone === "up" ? "bg-up" : o.tone === "down" ? "bg-down" : "bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.25)]")}
              />
            ) : null}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
