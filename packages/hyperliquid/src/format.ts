/**
 * Hyperliquid's tick and lot rules for perps: a price has at most five significant figures and at
 * most `6 - szDecimals` decimals (integers are always allowed); a size has at most `szDecimals`
 * decimals. Both go over the wire as decimal strings without trailing zeros, which is also what
 * the account contract parses.
 */

const trim = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);

export function formatSize(size: number, szDecimals: number): string {
  if (!(size > 0) || !Number.isFinite(size)) throw new Error("size must be positive");
  const f = 10 ** szDecimals;
  return trim((Math.floor(size * f + 1e-9) / f).toFixed(szDecimals));
}

/** Rounds a price to Hyperliquid's rules, toward the side that keeps the order no worse than asked (`up` for buys). */
export function formatPrice(price: number, szDecimals: number, round: "up" | "down" | "nearest" = "nearest"): string {
  if (!(price > 0) || !Number.isFinite(price)) throw new Error("price must be positive");
  const maxDecimals = Math.max(0, 6 - szDecimals);
  const magnitude = Math.floor(Math.log10(price));
  // Five significant figures; an integer price is allowed however many digits it has.
  const sigDecimals = Math.max(0, 4 - magnitude);
  const decimals = Math.min(maxDecimals, sigDecimals);
  const f = 10 ** decimals;
  const scaled = price * f;
  const r = round === "up" ? Math.ceil(scaled - 1e-9) : round === "down" ? Math.floor(scaled + 1e-9) : Math.round(scaled);
  return trim((r / f).toFixed(decimals));
}
