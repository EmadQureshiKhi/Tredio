import { cn } from "./cn";

/** Lucide's check (or double check), drawing itself stroke by stroke as it appears. */
export function DrawnCheck({ double, className }: { double?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-4 shrink-0", className)} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {double ? (
        <>
          <path pathLength={1} className="draw-in" d="M18 6 7 17l-5-5" />
          <path pathLength={1} className="draw-in [animation-delay:120ms]" d="m22 10-7.5 7.5L13 16" />
        </>
      ) : (
        <path pathLength={1} className="draw-in" d="M20 6 9 17l-5-5" />
      )}
    </svg>
  );
}
