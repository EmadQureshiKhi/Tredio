import { formatAmount, parseAmount as parse } from "@/lib/amount";
import { price, tokenAmount, usdc } from "@/lib/format";

/** The portfolio's number formatting and amount parsing (pure, so unit-tested). */

const WINDOW_LABEL: Record<number, string> = { 900: "15M", 86_400: "24H", 604_800: "7D" };
export const windowShort = (w: number) => WINDOW_LABEL[w] ?? (w >= 86_400 ? `${Math.round(w / 86_400)}D` : `${Math.round(w / 60)}M`);

/** Token amounts (6 decimals unless given): the app's one holdings formatter, cut to `max` decimals. */
export const tokens = (raw: bigint, decimals = 6, max = 2): string => tokenAmount(raw, decimals, max);

/** A raw amount for `decimals`, or null when the text is not a positive number. */
export const parseAmount = (text: string, decimals: number): bigint | null => parse(text, decimals);

/** A raw amount written for an input field: exact, cut (not rounded) to `max` decimals, trailing zeros trimmed. */
export const amountText = (raw: bigint, decimals: number, max = decimals): string => formatAmount(raw, decimals, max);

/** Values that round to zero print as zero, never "-0.00". */
const settle = (v: number, digits: number) => (Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v);
export const signedUsdc = (v: number) => usdc(settle(v, 2), { sign: true });
/** A signed percent with one decimal: "+2.4%", "0.0%". */
export const signedPct = (v: number) => {
  const x = settle(v, 1);
  return `${x > 0 ? "+" : x < 0 ? "-" : ""}${Math.abs(x).toFixed(1)}%`;
};
export const toneOf = (v: number | null | undefined) => (v === null || v === undefined || Math.abs(v) < 0.005 ? "text-text-2" : v > 0 ? "text-up" : "text-down");

/** A coin's price in USDC: four significant digits once it is below a cent (curve coins start tiny). */
export const coinPrice = (v: number | null) => (v === null || !Number.isFinite(v) ? "-" : v >= 0.01 ? price(v) : new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 }).format(v));
