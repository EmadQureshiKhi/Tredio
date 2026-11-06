import { APP_URL } from "@/lib/config";

/**
 * Share links for trends, calls and PnL results, and the "Share to X" intent. Safe to import from
 * client and server code alike.
 *
 *   window.open(xIntentUrl({ text: "Long Ethereum attention", url: trendShareUrl("crypto:eth") }), "_blank")
 *   shareToX({ text, url: pnlShareUrl({ ... }) })
 */

/** The app's origin: the page's own in the browser, the configured public URL on the server. */
export function appOrigin(): string {
  return typeof window === "undefined" ? APP_URL : window.location.origin;
}

const absolute = (path: string) => `${appOrigin()}${path}`;

/** X's web intent for a new post with `text` and an optional link card for `url`. */
export function xIntentUrl({ text, url }: { text: string; url?: string }): string {
  const q = new URLSearchParams({ text });
  if (url) q.set("url", url);
  return `https://twitter.com/intent/tweet?${q.toString()}`;
}

/** Opens the X intent in a new tab (from a click handler, so pop-up blockers allow it). */
export function shareToX(post: { text: string; url?: string }): void {
  window.open(xIntentUrl(post), "_blank", "noopener,noreferrer");
}

/** A trend's page; its link card is the trend's live attention card. */
export const trendShareUrl = (identifier: string) => absolute(`/t/${identifier}`);

/** One call on a trend's thread, with a card showing the call, its outcome and the caller's record. */
export const callShareUrl = (identifier: string, callId: number | string) => absolute(callSharePath(identifier, callId));
export const callSharePath = (identifier: string, callId: number | string) => `/share/call/${encodeURIComponent(identifier)}/${callId}`;

// ---------------------------------------------------------------------------------------------
// PnL results
// ---------------------------------------------------------------------------------------------

export type PnlKind = "attention" | "assetPerp" | "outcome" | "coin";
export type PnlSide = "long" | "short" | "up" | "down" | "hold";

/**
 * A trade result as the share card shows it. The numbers travel in the link itself, so anyone can
 * write any numbers into one. When `tx` is the transaction that closed an attention perp, the
 * card checks the PnL and exit against that transaction's close event and only then shows
 * "Verified".
 */
export interface PnlShare {
  kind: PnlKind;
  /** What was traded, for example "Ethereum" or "BTC". */
  market: string;
  side: PnlSide;
  /** Realized or unrealized profit, USDC. */
  pnl: number;
  /** Return on margin (or cost), percent. */
  roi: number | null;
  /** Entry and exit: index points for attention, prices for asset perps and coins, USDC per token for outcomes. */
  entry: number | null;
  exit: number | null;
  leverage: number | null;
  /** The closing transaction, when there is one, and the account that sent it (NEAR looks a transaction up by both). */
  tx: string | null;
  account: string | null;
  /** The trend identifier, so the page can link to the market. */
  identifier: string | null;
}

const KINDS: readonly PnlKind[] = ["attention", "assetPerp", "outcome", "coin"];
const SIDES: readonly PnlSide[] = ["long", "short", "up", "down", "hold"];

const round = (v: number, digits: number) => Number(v.toFixed(digits));

export function pnlSharePath(p: PnlShare): string {
  const q = new URLSearchParams({ k: p.kind, m: p.market, s: p.side, p: String(round(p.pnl, 2)) });
  if (p.roi !== null) q.set("r", String(round(p.roi, 2)));
  if (p.entry !== null) q.set("e", String(round(p.entry, 6)));
  if (p.exit !== null) q.set("x", String(round(p.exit, 6)));
  if (p.leverage !== null) q.set("l", String(round(p.leverage, 2)));
  if (p.identifier) q.set("t", p.identifier);
  if (p.tx) q.set("tx", p.tx);
  if (p.tx && p.account) q.set("a", p.account);
  return `/share/pnl?${q.toString()}`;
}

export const pnlShareUrl = (p: PnlShare) => absolute(pnlSharePath(p));

type Params = URLSearchParams | Record<string, string | string[] | undefined>;
const get = (params: Params, key: string): string | undefined => {
  if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
};

/** Printable text only, trimmed and capped: the card renders whatever the link carries. */
const clean = (v: string | undefined, max: number) =>
  v
    ?.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "")
    .trim()
    .slice(0, max) || undefined;

function num(v: string | undefined, min: number, max: number): number | null {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/** Reads a PnL share from a link's search params; null when the link is not a usable result. */
export function parsePnlShare(params: Params): PnlShare | null {
  const kind = get(params, "k") as PnlKind | undefined;
  const side = get(params, "s") as PnlSide | undefined;
  const market = clean(get(params, "m"), 48);
  const pnl = num(get(params, "p"), -1e9, 1e9);
  if (!kind || !KINDS.includes(kind) || !side || !SIDES.includes(side) || !market || pnl === null) return null;
  const tx = get(params, "tx");
  const account = get(params, "a");
  const identifier = clean(get(params, "t"), 80);
  return {
    kind,
    market,
    side,
    pnl,
    roi: num(get(params, "r"), -100_000, 100_000),
    entry: num(get(params, "e"), 0, 1e12),
    exit: num(get(params, "x"), 0, 1e12),
    leverage: num(get(params, "l"), 0, 1000),
    tx: tx && /^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(tx) ? tx : null,
    account: account && /^[a-z0-9._-]{2,64}$/.test(account) ? account : null,
    identifier: identifier && /^[a-z0-9:._-]+$/.test(identifier) ? identifier : null,
  };
}

/** The one-line story of a result, for the post text and the card's title. */
export function pnlHeadline(p: PnlShare): string {
  const what = p.kind === "attention" ? `${p.market} attention` : p.market;
  if (p.side === "hold") return what;
  const side = p.side === "up" || p.side === "down" ? p.side.toUpperCase() : p.side;
  const lev = p.leverage && p.leverage > 1 ? ` ${trimZeros(p.leverage)}x` : "";
  return `${what}, ${side}${lev}`;
}

export const trimZeros = (v: number, digits = 2) => String(Number(v.toFixed(digits)));
