/** Formatting for prices, sizes, money and time, consistent across the app. */

const nf = (min: number, max: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });
const NF0 = nf(0, 0);
const NF2 = nf(2, 2);

/** USDC amounts: two decimals, thousands separators. */
export function usdc(v: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  const s = NF2.format(Math.abs(v));
  if (opts.sign) return `${v > 0 ? "+" : v < 0 ? "-" : ""}${s}`;
  return v < 0 ? `-${s}` : s;
}

/**
 * Token amounts and balances from raw units: cut (never rounded up) to `max` decimals, at least
 * two, with thousands separators, so a balance never shows more than the account holds. Every
 * screen formats holdings with this one helper, so a position reads the same everywhere.
 */
export function tokenAmount(raw: bigint, decimals: number, max = 2): string {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const digits = Math.min(max, decimals);
  const cut = (v % base).toString().padStart(decimals, "0").slice(0, digits).replace(/0+$/, "");
  const frac = cut.padEnd(Math.min(2, digits), "0");
  const text = `${(v / base).toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
  return neg && /[1-9]/.test(text) ? `-${text}` : text;
}

/** A token amount as a number, cut exactly as `tokenAmount` cuts it, for a rolling number. */
export function tokenNumber(raw: bigint, decimals: number, max = 2): number {
  return Number(tokenAmount(raw, decimals, max).replace(/,/g, ""));
}

/** Compact counts: 1.2K, 3.4M. */
export function compact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v);
}

/** Attention index points (0 to 100). */
export const points = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "-" : v.toFixed(2));

/** Percent with sign: +3.2%. */
export function pct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  const s = Math.abs(v).toFixed(digits);
  return `${v > 0 ? "+" : v < 0 ? "-" : ""}${s}%`;
}

/** A price with as many decimals as its size needs. */
export function price(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  const a = Math.abs(v);
  const digits = a >= 1000 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 4 : 6;
  return nf(digits === 2 ? 2 : 0, digits).format(v);
}

export const integer = (v: number) => NF0.format(v);

/** Probability (0 to 1) as cents: 0.53 shows as 53c. */
export const cents = (v: number) => `${(v * 100).toFixed(1)}c`;

export function shortAddress(a: string | null | undefined): string {
  if (!a) return "";
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

/** "3m ago", "2h ago", "4d ago". */
export function ago(unixSec: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.floor(nowMs / 1000 - unixSec));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/** "in 4h 12m" or "ended". */
export function countdown(untilSec: number, nowMs = Date.now()): string {
  const s = Math.floor(untilSec - nowMs / 1000);
  if (s <= 0) return "ended";
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

export const windowLabel = (sec: number) => (sec >= 604_800 ? "7 days" : sec >= 86_400 ? "24 hours" : `${Math.round(sec / 60)} minutes`);

const CLASS_LABEL: Record<string, string> = {
  crypto: "Crypto",
  equity: "Stock",
  commodity: "Commodity",
  fx: "FX",
  person: "Person",
  politics: "Politics",
  topic: "Topic",
};
export const assetClassLabel = (c: string) => CLASS_LABEL[c] ?? "Topic";
