/**
 * NEP-297 events the contracts log (`EVENT_JSON:{...}`): parsing and the standards Tredio emits.
 */

export const STANDARDS = [
  "tredio-registry",
  "tredio-outcomes",
  "tredio-book",
  "tredio-perps",
  "tredio-coins",
  "tredio-curation",
  "tredio-account",
  "tredio-accounts",
  "nep245",
  "nep141",
] as const;

export type Standard = (typeof STANDARDS)[number];

export interface NearEvent<D = Record<string, unknown>> {
  standard: string;
  version: string;
  event: string;
  data: D;
}

const PREFIX = "EVENT_JSON:";

/** The events in one receipt's logs. near-sdk logs `data` as an object; NEP-141/245 use arrays. */
export function parseEvents(logs: readonly string[]): NearEvent[] {
  const out: NearEvent[] = [];
  for (const log of logs) {
    if (!log.startsWith(PREFIX)) continue;
    try {
      const e = JSON.parse(log.slice(PREFIX.length)) as NearEvent;
      if (typeof e.standard === "string" && typeof e.event === "string") out.push(e);
    } catch {
      // A malformed log is not an event.
    }
  }
  return out;
}

export function isTredioEvent(e: NearEvent): boolean {
  return (STANDARDS as readonly string[]).includes(e.standard);
}
