/** Unit helpers: USDC and outcome tokens have 6 decimals, the index 6, trend coins 18. */

export const USDC_DECIMALS = 6;
export const INDEX_DECIMALS = 6;
export const COIN_DECIMALS = 18;
export const ONE_USDC = 1_000_000n;
/** The index's cap, 100 points. A series that opens there can only settle Down: Up needs a close above the opening, and ties go Down. */
export const INDEX_MAX = 100 * 10 ** INDEX_DECIMALS;
export const opensAtCap = (openingIndex: number) => openingIndex >= INDEX_MAX;

/** Parses a decimal string ("12.5") into raw units with `decimals`, rounding down. */
export function toRaw(value: string | number, decimals: number): bigint {
  const s = typeof value === "number" ? value.toFixed(decimals) : value.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`not a decimal amount: ${value}`);
  const [int, frac = ""] = s.split(".");
  return BigInt(int ?? "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/** Formats raw units with `decimals`, trimming trailing zeros (at most `maxFraction` digits). */
export function fromRaw(raw: bigint | string, decimals: number, maxFraction = decimals): string {
  const v = BigInt(raw);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const int = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

export const usdc = (raw: bigint | string) => fromRaw(raw, USDC_DECIMALS, 2);
export const indexPoints = (raw: number) => raw / 10 ** INDEX_DECIMALS;
export const tickToPrice = (tick: number) => tick / 1000;
