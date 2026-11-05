/** Time series helpers: step lookups over observations sorted by time (seconds). */

export interface Point {
  /** Unix seconds. */
  t: number;
  v: number;
}

/** The last value observed at or before `t`, or null. Binary search: `points` must be sorted by time. */
export function valueAt(points: readonly Point[], t: number): number | null {
  let lo = 0;
  let hi = points.length - 1;
  let found: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = points[mid]!;
    if (p.t <= t) {
      found = p.v;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Percent change of a step series over `windowSec` ending at `t`, or null when the series has no
 * observation at or before the window's start (not enough history to judge).
 */
export function changePct(points: readonly Point[], t: number, windowSec: number): number | null {
  const now = valueAt(points, t);
  const then = valueAt(points, t - windowSec);
  if (now === null || then === null || then <= 0) return null;
  return ((now - then) / then) * 100;
}
