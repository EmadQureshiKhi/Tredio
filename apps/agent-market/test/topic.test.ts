import { describe, expect, test } from "bun:test";
import { matchTrends, resolve, score, slugify, topicQueries } from "../src/topic";
import { candidates, trends } from "./helpers";

const radar = { candidates, slots: { live: 9, max: 24 } };

describe("topic queries from a brief", () => {
  test("the title stripped of the request around it", () => {
    expect(topicQueries("Attention check: World Cup?", "")).toEqual(["World Cup"]);
    expect(topicQueries("What is the attention index for Tesla?", "")).toEqual(["Tesla"]);
    expect(topicQueries("attention index of Godzilla Minus Zero right now", "")).toEqual(["Godzilla Minus Zero"]);
    expect(topicQueries('"Stephen Miller"', "")).toEqual(["Stephen Miller"]);
    expect(topicQueries("$TSLA", "")).toEqual(["$TSLA"]);
  });

  test("an explicit topic comes first: JSON (the input schema), an identifier, a topic: line", () => {
    expect(topicQueries('{"topic":"AI agents"}', "")[0]).toBe("AI agents");
    expect(topicQueries("Attention check", '{"topic": "world cup"}')[0]).toBe("world cup");
    expect(topicQueries("Please look at this", "I care about topic:World-Cup.2 mostly")[0]).toBe("topic:world-cup.2");
    expect(topicQueries("Attention check", "Topic: Godzilla\nThanks!")[0]).toBe("Godzilla");
  });

  test("a title that is only the request falls back to the brief's first line", () => {
    expect(topicQueries("Attention check", "\nJensen Huang\nmore words")).toEqual(["Jensen Huang"]);
  });

  test("nothing to match: no queries", () => {
    expect(topicQueries("Attention check", "")).toEqual([]);
    expect(topicQueries("", "   ")).toEqual([]);
  });

  test("slugs follow the backend's", () => {
    expect(slugify("Ukraine–Russia Peace Talks!")).toBe("ukraine-russia-peace-talks");
    expect(slugify("Café & Bar")).toBe("cafe-and-bar");
  });
});

describe("topic resolution", () => {
  test("an identifier, exact or by its base, names the listing (a relisting before its retired base)", () => {
    expect(resolve(["topic:world-cup.2"], trends, radar)).toMatchObject({ kind: "trend", how: "identifier", trend: { identifier: "topic:world-cup.2" } });
    expect(resolve(["topic:world-cup"], trends, radar)).toMatchObject({ kind: "trend", how: "identifier", trend: { identifier: "topic:world-cup" } });
    // Equal scores: the live relisting wins over the retired listing.
    expect(matchTrends("World Cup", trends)[0]!.item.identifier).toBe("topic:world-cup.2");
  });

  test("a ticker, a name, a keyword, a slug and loose words", () => {
    expect(resolve(["$TSLA"], trends, radar)).toMatchObject({ how: "ticker", trend: { identifier: "equity:tsla.2", status: "active" } });
    expect(resolve(["Godzilla Minus Zero"], trends, radar)).toMatchObject({ how: "name", trend: { identifier: "topic:godzilla-minus-zero.2" } });
    expect(resolve(["godzilla"], trends, radar)).toMatchObject({ how: "keyword", trend: { identifier: "topic:godzilla-minus-zero.2" } });
    expect(resolve(["Susie Wiles"], trends, radar)).toMatchObject({ how: "keyword", trend: { identifier: "person:stephen-miller.2" } });
    expect(resolve(["jensen-huang"], trends, radar)).toMatchObject({ how: "slug", trend: { identifier: "person:jensen-huang" } });
    expect(resolve(["FIFA cup"], trends, radar)).toMatchObject({ how: "words", trend: { identifier: "topic:world-cup.2" } });
  });

  test("the score ranks exact names above loose words", () => {
    const t = trends.find((x) => x.identifier === "topic:world-cup.2")!;
    expect(score("topic:world-cup.2", t)!.score).toBeGreaterThan(score("World Cup", t)!.score);
    expect(score("World Cup", t)!.score).toBeGreaterThan(score("cup", t)!.score);
    expect(score("tennis", t)).toBeNull();
  });

  test("not listed but on the radar: the candidate, with the slots", () => {
    const r = resolve(["Cardano"], trends, radar);
    expect(r).toMatchObject({ kind: "candidate", how: "name", candidate: { identifier: "crypto:ada" }, slots: { live: 9, max: 24 } });
    expect(resolve(["$XMR"], trends, radar)).toMatchObject({ kind: "candidate", how: "ticker", candidate: { identifier: "crypto:xmr" } });
  });

  test("a later query is tried when the first names nothing; a listed match beats a radar one", () => {
    expect(resolve(["something unknown", "Tesla"], trends, radar)).toMatchObject({ kind: "trend", query: "Tesla", trend: { identifier: "equity:tsla.2" } });
    expect(resolve(["Cardano", "Tesla"], trends, radar)).toMatchObject({ kind: "trend", query: "Tesla" });
  });

  test("other close matches are offered as alternatives, never the same topic again", () => {
    const r = resolve(["hegseth"], trends, radar)!;
    expect(r.kind).toBe("trend");
    expect(r.alternatives.length).toBe(1);
    expect(r.alternatives[0]).toStartWith("politics:hegseth-");
    expect(resolve(["World Cup"], trends, radar)!.alternatives).toEqual([]);
  });

  test("a topic Tredio does not track resolves to nothing", () => {
    expect(resolve(["curling world championship"], trends, radar)).toBeNull();
    expect(resolve([], trends, radar)).toBeNull();
  });
});
