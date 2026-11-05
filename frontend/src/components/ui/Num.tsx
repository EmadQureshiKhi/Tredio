"use client";
import NumberFlow, { type Format } from "@number-flow/react";
import { useEffect, useRef, useState } from "react";
import { cn } from "./cn";
import { rollDelay, rollDirection, rollText } from "./roll";

/**
 * A number that rolls its changed digits to each new value and flashes green or red for a moment
 * with the direction. Rolls are throttled (see roll.ts), so a figure that moves with every new reading
 * still reads; reduced motion swaps values instantly. The accessible text, and the test id, sit on
 * a hidden copy of the latest value, since the rolling digits live in a shadow root.
 *
 *   <Num value={tokenNumber(raw, 6)} testId="total-cash" />
 *   <Num value={pnl} format={{ ...TWO_DECIMALS, signDisplay: "exceptZero" }} className="text-up" />
 */

export const TWO_DECIMALS: Format = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
const EASE = "cubic-bezier(0.25, 1, 0.5, 1)";
const SPIN = { duration: 420, easing: EASE };
const FADE = { duration: 220, easing: "ease-out" };
const FLASH_MS = 260;
/**
 * NumberFlow pads its number and each digit above and below (half the fade mask's height each)
 * for the mask that rolling digits pass through; cancelling both keeps its line exactly as tall
 * as plain text, so nothing shifts when a placeholder turns into a number.
 */
const NO_EXTRA_HEIGHT = { marginBlock: "calc(round(nearest, calc(var(--number-flow-mask-height, 0.25em) / 2), 1px) * -2)" };

export function Num({
  value,
  format = TWO_DECIMALS,
  prefix,
  suffix,
  className,
  testId,
  flash = true,
  from,
  placeholder = "-",
}: {
  value: number | null | undefined;
  format?: Format;
  prefix?: string;
  suffix?: string;
  className?: string;
  testId?: string;
  /** Flash the change's direction (off where the number's own color already says it). */
  flash?: boolean;
  /** Count up from this value when first shown (a result arriving), instead of appearing at once. */
  from?: number;
  /** Shown while there is no value. */
  placeholder?: string;
}) {
  const target = value === null || value === undefined || !Number.isFinite(value) ? null : value;
  const shown = useSettled(target, from);
  const el = useRef<HTMLSpanElement>(null);
  const previous = useRef(shown);

  useEffect(() => {
    const dir = rollDirection(previous.current, shown);
    previous.current = shown;
    if (!flash || !dir || !el.current) return;
    const color = getComputedStyle(document.documentElement).getPropertyValue(dir === "up" ? "--up" : "--down").trim();
    el.current.animate([{ color }, {}], { duration: FLASH_MS, easing: "ease-out" });
  }, [shown, flash]);

  if (shown === null || target === null) {
    return (
      <span className={className} data-testid={testId}>
        {placeholder}
      </span>
    );
  }
  return (
    <span ref={el} className={cn("relative", className)}>
      <NumberFlow aria-hidden style={NO_EXTRA_HEIGHT} value={shown} format={format} locales="en-US" prefix={prefix} suffix={suffix} spinTiming={SPIN} transformTiming={SPIN} opacityTiming={FADE} />
      <span className="sr-only" data-testid={testId}>
        {rollText(target, format, prefix, suffix)}
      </span>
    </span>
  );
}

/** The value to show: the latest one, at most one roll per gap, starting from `from` when given. */
function useSettled(value: number | null, from?: number): number | null {
  const [shown, setShown] = useState<number | null>(from !== undefined && value !== null ? from : value);
  const lastRoll = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    if (value === shown) return;
    // A first value (or a cleared one) shows at once; a change waits its turn to roll.
    const wait = shown === null || value === null ? 0 : rollDelay(lastRoll.current, performance.now());
    const t = setTimeout(() => {
      if (shown !== null && value !== null) lastRoll.current = performance.now();
      setShown(value);
    }, wait);
    return () => clearTimeout(t);
  }, [value, shown]);
  return shown;
}
