import { describe, expect, test } from "bun:test";
import type { Reading, Trend } from "../src/lib/api";
import { attentionStory, baseIdentifier, listingNumber, newestListing, trendName } from "../src/lib/trends";

const t = (identifier: string, status: string, createdAt: number, displayName: string | null = null) => ({ identifier, status, createdAt, displayName });

describe("listings", () => {
  test("a relisted topic is named by its topic, not its listing number", () => {
    expect(baseIdentifier("equity:dal.2")).toBe("equity:dal");
    expect(baseIdentifier("topic:web3.0")).toBe("topic:web3.0");
    expect(listingNumber("equity:dal.2")).toBe(2);
    expect(listingNumber("equity:dal")).toBe(1);
    expect(trendName(t("equity:dal.2", "active", 2))).toBe("DAL");
    expect(trendName(t("topic:world-cup", "active", 1))).toBe("World Cup");
    expect(trendName(t("person:sam_altman", "active", 1))).toBe("Sam Altman");
    expect(trendName(t("equity:dal.2", "active", 2, "Delta Air Lines"))).toBe("Delta Air Lines");
  });

  test("a topic resolves to its newest listing, live ones first, as rules do", () => {
    const list = [t("crypto:eth", "retired", 1), t("crypto:eth.2", "active", 5), t("crypto:btc", "active", 3)];
    expect(newestListing(list, "crypto:eth")?.identifier).toBe("crypto:eth.2");
    expect(newestListing(list, "crypto:eth.2")?.identifier).toBe("crypto:eth.2");
    expect(newestListing([t("crypto:eth", "retired", 1)], "crypto:eth")?.identifier).toBe("crypto:eth");
    expect(newestListing(list, "crypto:sol")).toBeUndefined();
  });
});

describe("attention story", () => {
  const r = (value: number): Reading => ({ value, windowSec: 86_400, observedAt: 0 });
  const story = (readings: Partial<Trend["readings"]>) =>
    attentionStory({ readings: { elfa: null, bluesky: null, gdelt: null, hn: null, nansen: null, wikipedia: null, ...readings } } as Trend);

  test("posts add X and Telegram to Bluesky, and Hacker News comes last", () => {
    expect(story({ elfa: r(1200), bluesky: r(300), wikipedia: r(5000), hn: r(16) })).toEqual(["1.5K posts", "5K readers", "16 on Hacker News"]);
    expect(story({ bluesky: r(42) })).toEqual(["42 posts"]);
  });

  test("zero news and Hacker News counts are left out", () => {
    expect(story({ elfa: r(8), gdelt: r(0), hn: r(0) })).toEqual(["8 posts"]);
    expect(story({ gdelt: r(32), nansen: r(-25_000) })).toEqual(["32 articles", "smart money -$25K"]);
  });
});
