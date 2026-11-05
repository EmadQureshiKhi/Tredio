/**
 * When a changing number may roll to its next value. A figure that updates with every new reading (live
 * PnL, a mark price) would otherwise roll as often as the data changes and never read; this lets one
 * roll start at most every `gap` ms and always lands on the latest value once it settles.
 */

/** The gap the app uses between two rolls of one number. */
export const ROLL_GAP_MS = 600;

/** Milliseconds to wait before showing a new value, given when the last roll started. */
export function rollDelay(lastRollAt: number, now: number, gap = ROLL_GAP_MS): number {
  return Math.max(0, lastRollAt + gap - now);
}

/** The direction of a change, for its flash: none for the first value or no move. */
export function rollDirection(from: number | null, to: number | null): "up" | "down" | null {
  if (from === null || to === null || from === to) return null;
  return to > from ? "up" : "down";
}

/** A number as a plain string the way `format` writes it, for the accessible (and tested) text. */
export function rollText(value: number, format: Intl.NumberFormatOptions, prefix = "", suffix = ""): string {
  return `${prefix}${new Intl.NumberFormat("en-US", format).format(value)}${suffix}`;
}
