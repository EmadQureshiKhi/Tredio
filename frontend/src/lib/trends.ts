import type { Trend } from "@/lib/api";
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

/** The name a trend goes by: its display name, or its identifier without the listing number. */
export const trendName = (t: { displayName: string | null; identifier: string }) => t.displayName ?? baseIdentifier(t.identifier);

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
