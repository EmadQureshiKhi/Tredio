/**
 * The attention index method (documented in docs/index-method.md). Pure and deterministic, so
 * anyone can recompute a reported value from the same measurements.
 */

/** The registry stores index values with 6 decimals: 1_000_000 is one point. */
export const INDEX_SCALE = 1_000_000;
export const MIN_INDEX_UNITS = 10_000n; // 0.01 points, the registry minimum
export const MAX_POINTS = 100;

export interface Component {
  /** Normalized value in [0, 1]. */
  value: number;
  weight: number;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Seasonal factor for a UTC hour: the profile value over the profile mean. */
export function seasonalFactor(profile: readonly number[], hourUtc: number): number {
  const mean = profile.reduce((a, b) => a + b, 0) / profile.length;
  const v = profile[((hourUtc % 24) + 24) % 24];
  return v === undefined || mean <= 0 ? 1 : v / mean;
}

/**
 * Normalizes a non-negative count: clip outliers at `clip`, deseasonalize by dividing by the
 * hour's seasonal factor, then log-scale so `saturation` maps to 1.
 */
export function normalizeCount(x: number, clip: number, saturation: number, seasonal: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  const clipped = Math.min(x, clip);
  const deseasonalized = clipped / (seasonal > 0 ? seasonal : 1);
  return clamp01(Math.log1p(deseasonalized) / Math.log1p(saturation));
}

/** Normalizes a signed USD flow to [0, 1] around 0.5 with a tanh response of width `scaleUsd`. */
export function normalizeFlow(netflowUsd: number, scaleUsd: number): number {
  if (!Number.isFinite(netflowUsd)) return 0.5;
  return clamp01(0.5 + 0.5 * Math.tanh(netflowUsd / scaleUsd));
}

/** Weighted mean of the available components, in points (0 to 100), or null if none. */
export function attentionPoints(components: readonly Component[]): number | null {
  let weighted = 0;
  let weights = 0;
  for (const c of components) {
    if (!Number.isFinite(c.value) || c.weight <= 0) continue;
    weighted += clamp01(c.value) * c.weight;
    weights += c.weight;
  }
  return weights > 0 ? (MAX_POINTS * weighted) / weights : null;
}

/**
 * Index points with boost components: each boost enters the weighted mean only when it would raise
 * it (strongest first), so a source most topics never reach (Hacker News) lifts the index of the
 * topics it covers without dragging down the rest. The result is continuous in every input: a
 * boost equal to the current mean changes nothing whether it enters or not. Null when the base
 * has no component.
 */
export function boostedPoints(components: readonly Component[], boosts: readonly Component[]): number | null {
  const base = attentionPoints(components);
  if (base === null) return null;
  let all = [...components];
  let points = base;
  for (const b of [...boosts].sort((x, y) => y.value - x.value)) {
    if (!Number.isFinite(b.value) || b.weight <= 0 || MAX_POINTS * clamp01(b.value) <= points) continue;
    all = [...all, b];
    points = attentionPoints(all) ?? points;
  }
  return points;
}

/**
 * A source's weight at `atSec` under its phase-in: 0 before `fromSec`, rising linearly to the full
 * weight `durationSec` later. Without a phase-in, the full weight.
 */
export function phasedWeight(weight: number, phaseIn: { fromSec: number; durationSec: number } | undefined, atSec: number): number {
  if (!phaseIn) return weight;
  return weight * clamp01((atSec - phaseIn.fromSec) / phaseIn.durationSec);
}

/** Points to registry units, rounded to 0.01 points and kept inside the registry bounds. */
export function toIndexUnits(points: number): bigint {
  const hundredths = Math.round(Math.min(Math.max(points, 0), MAX_POINTS) * 100);
  const units = BigInt(hundredths) * BigInt(INDEX_SCALE / 100);
  return units < MIN_INDEX_UNITS ? MIN_INDEX_UNITS : units;
}

export function unitsToPoints(units: bigint): number {
  return Number(units) / INDEX_SCALE;
}
