import type { Reading, SourceName, Trend } from "@/lib/api";
import { compact } from "@/lib/format";

/**
 * Listings: a topic that retired and came back lists again as `<base>.2` up to `<base>.9`. People
 * know it by its name, and rules follow the topic, so the app names a listing by its topic and
 * resolves a topic to its newest listing, live ones first (as the backend and executor do).
 */

const VERSION = /\.([2-9])$/;

/** "equity:dal.2" is "equity:dal". */
export const baseIdentifier = (identifier: string) => identifier.replace(VERSION, "");

/** 1 for the first listing, 2 for "equity:dal.2". */
export const listingNumber = (identifier: string) => Number(identifier.match(VERSION)?.[1] ?? 1);

const TICKER_CLASSES = new Set(["crypto", "equity", "commodity", "fx"]);

/** A readable name from the identifier alone, for a trend listed without one: "topic:world-cup" is "World Cup", "equity:dal.2" is "DAL". */
export function nameFromIdentifier(identifier: string): string {
  const [assetClass = "", ...rest] = baseIdentifier(identifier).split(":");
  const slug = rest.join(":");
  if (!slug) return assetClass;
  if (TICKER_CLASSES.has(assetClass)) return slug.toUpperCase();
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

/** The name a trend goes by: its display name, or one read from its identifier. */
export const trendName = (t: { displayName: string | null; identifier: string }) => t.displayName ?? nameFromIdentifier(t.identifier);

/** The newest listing of the topic `identifier` names, live ones first. */
export function newestListing<T extends { identifier: string; status: string; createdAt: number }>(trends: readonly T[], identifier: string): T | undefined {
  const base = baseIdentifier(identifier);
  const matches = trends.filter((t) => baseIdentifier(t.identifier) === base);
  const live = matches.filter((t) => t.status !== "retired");
  return [...(live.length > 0 ? live : matches)].sort((a, b) => b.createdAt - a.createdAt)[0];
}

/**
 * A trend's attention story in a few words: social posts (X and Telegram through Elfa, plus
 * Bluesky), news articles, Wikipedia readers, smart money and Hacker News mentions. Zero news or
 * Hacker News counts are left out: GDELT's usually means it did not answer, and most topics never
 * reach Hacker News.
 */
/** The index's cap in points: a trend past every answering source's saturation level reads exactly 100 until it fades. */
export const INDEX_CAP = 100;

/** What the cap means, for the badge's tooltip. */
export const CAP_NOTE = "Past every source's saturation level: the index reads the cap until attention fades. Perps and the coin keep trading; no new Up/Down series opens here.";

/** True when a trend reads the cap, so the chart is flat at the top and no new Up/Down series opens on it. */
export const atCap = (index: number) => index >= INDEX_CAP;

/**
 * How old a reading may be before the oracle leaves it out of the blend (the enclave's `maxAgeSec`
 * per source, apps/oracle/tee/src/method.rs). The app marks such readings as stale.
 */
export const SOURCE_MAX_AGE_SEC: Record<SourceName, number> = { elfa: 43_200, bluesky: 7_200, gdelt: 7_200, wikipedia: 172_800, hn: 10_800, nansen: 43_200 };

/** True when a reading is past its source's window, so the oracle no longer counts it. */
export const staleReading = (source: SourceName, reading: Pick<Reading, "observedAt"> | null, nowSec: number) =>
  reading !== null && nowSec - reading.observedAt > SOURCE_MAX_AGE_SEC[source];

export function attentionStory(t: Trend): string[] {
  const out: string[] = [];
  const { elfa, bluesky, gdelt, wikipedia, nansen, hn } = t.readings;
  if (elfa || bluesky) out.push(`${compact((elfa?.value ?? 0) + (bluesky?.value ?? 0))} posts`);
  if (gdelt && gdelt.value > 0) out.push(`${compact(gdelt.value)} articles`);
  if (wikipedia) out.push(`${compact(wikipedia.value)} readers`);
  if (nansen) out.push(`smart money ${nansen.value >= 0 ? "+" : "-"}$${compact(Math.abs(nansen.value))}`);
  if (hn && hn.value > 0) out.push(`${compact(hn.value)} on Hacker News`);
  return out;
}
