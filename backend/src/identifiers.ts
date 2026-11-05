/**
 * Trend identifiers as the registry and the oracle define them: lowercase `[a-z0-9:._-]`,
 * 1 to 64 bytes, `<class>:<slug>`, with a retired trend's return listed as `<base>.<n>`.
 */

export const ASSET_CLASSES = ["crypto", "equity", "commodity", "fx", "person", "politics", "topic"] as const;
export type AssetClassName = (typeof ASSET_CLASSES)[number];
export const CRYPTO = 0;
export const EQUITY = 1;
export const PERSON = 4;
export const TOPIC = 6;
export const MAX_IDENTIFIER_LENGTH = 64;

const IDENTIFIER_RE = /^[a-z0-9:._-]{1,64}$/;
const VERSION_RE = /\.([2-9])$/;

export function isNormalized(identifier: string): boolean {
  return IDENTIFIER_RE.test(identifier);
}

/** A slug from free text: lowercase words joined by hyphens. */
export function slugify(raw: string, max = 48): string {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

/** `<class>:<slug>`, or null when nothing usable is left. */
export function makeIdentifier(cls: AssetClassName, slug: string): string | null {
  const s = slugify(slug, MAX_IDENTIFIER_LENGTH - cls.length - 1);
  if (!s) return null;
  const id = `${cls}:${s}`;
  return isNormalized(id) ? id : null;
}

export function baseOf(identifier: string): string {
  return identifier.replace(VERSION_RE, "");
}

export function assetClassOf(identifier: string): number {
  const prefix = identifier.split(":")[0] ?? "";
  const i = (ASSET_CLASSES as readonly string[]).indexOf(prefix);
  return identifier.includes(":") && i >= 0 ? i : TOPIC;
}

function slugOf(identifier: string): string {
  const base = baseOf(identifier);
  const colon = base.indexOf(":");
  return colon >= 0 ? base.slice(colon + 1) : base;
}

/** Ticker for crypto and equity trends (`crypto:sol` gives `SOL`), otherwise null. */
export function tickerOf(identifier: string): string | null {
  const cls = assetClassOf(identifier);
  if (cls !== CRYPTO && cls !== EQUITY) return null;
  const slug = slugOf(identifier);
  return /^[a-z0-9]{1,15}$/.test(slug) ? slug.toUpperCase() : null;
}

/** Keywords when nothing better is known: the cashtag for tickers, else the slug's words. */
export function defaultKeywords(identifier: string): string[] {
  const ticker = tickerOf(identifier);
  if (ticker) return [`$${ticker}`];
  return [slugOf(identifier).replace(/[-_.:]+/g, " ").trim()];
}

/** Display name when nothing better is known: the slug's words, capitalized. */
export function defaultName(identifier: string): string {
  const ticker = tickerOf(identifier);
  if (ticker) return `$${ticker}`;
  return slugOf(identifier)
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
