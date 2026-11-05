"use client";
import { useRef, type KeyboardEvent, type ReactNode } from "react";

export interface TabItem<T extends string> {
  value: T;
  label: string;
  badge?: ReactNode;
}

/**
 * A segmented tab list (WAI-ARIA tabs: arrow keys, Home and End move between tabs). It scrolls
 * sideways when it does not fit.
 */
export function Tabs<T extends string>({ items, value, onChange, label, panelId }: { items: TabItem<T>[]; value: T; onChange: (value: T) => void; label: string; panelId: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = items.findIndex((t) => t.value === value);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: items.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const target = (next + items.length) % items.length;
    onChange(items[target]!.value);
    refs.current[target]?.focus();
  };

  return (
    <div className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex w-max min-w-full gap-0.5 rounded-xl border border-line bg-surface p-1 sm:min-w-0 sm:gap-1">
        {items.map((tab, i) => {
          const selected = tab.value === value;
          return (
            <button
              key={tab.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${panelId}-tab-${tab.value}`}
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab.value)}
              className={`flex h-8 flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-lg px-1.5 text-[12.5px] font-medium transition-colors sm:flex-none sm:gap-1.5 sm:px-3 sm:text-[13px] ${
                selected ? "bg-raised text-fg shadow-card ring-1 ring-line" : "text-muted hover:text-fg"
              }`}
            >
              {tab.label}
              {tab.badge}
            </button>
          );
        })}
      </div>
    </div>
  );
}
