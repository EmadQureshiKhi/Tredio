import { describe, expect, test } from "bun:test";
import { HANDLERS } from "../src/derive";
import { canonicalOwnerKey, parseData, parseEvents, parseNearAmount, parseTokenId, SCHEMAS } from "../src/events";
import type { Block } from "../src/neardata";
import { scenario } from "./fixtures/scenario";
import real from "./fixtures/testnet-276377507.json";

function allLogs(blocks: Iterable<Block | null>): string[] {
  const logs: string[] = [];
  for (const b of blocks) for (const s of b?.shards ?? []) for (const r of s.receipt_execution_outcomes) logs.push(...r.execution_outcome.outcome.logs);
  return logs;
}

describe("parseEvents", () => {
  test("reads the EVENT_JSON lines of a real testnet receipt", () => {
    const outcomes = (real as unknown as Block).shards
      .flatMap((s) => s.receipt_execution_outcomes)
      .find((r) => r.execution_outcome.outcome.executor_id === "outcomes.tredio.testnet" && r.execution_outcome.outcome.logs.length)!;
    const events = parseEvents(outcomes.execution_outcome.outcome.logs);
    expect(events.map((e) => `${e.standard}/${e.event}`)).toEqual(["nep245/mt_mint", "nep245/mt_mint", "tredio-outcomes/sets_minted"]);
    expect(events.map((e) => e.logIndex)).toEqual([0, 1, 2]);
    expect(events[0]!.data).toEqual([{ owner_id: "tredio-mm.testnet", token_ids: ["1:up"], amounts: ["100000000"] }]);
    for (const e of events) expect(parseData(e).ok).toBe(true);
  });

  test("skips plain logs and malformed JSON, keeping log line indexes", () => {
    const events = parseEvents([
      "hello",
      'EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_mint","data":[{"owner_id":"a.testnet","amount":"1"}]}',
      "EVENT_JSON:{not json",
      'EVENT_JSON:{"standard":"nep141","event":"ft_burn"}',
      'EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_burn","data":[{"owner_id":"a.testnet","amount":"1"}]}',
    ]);
    expect(events.map((e) => [e.event, e.logIndex])).toEqual([
      ["ft_mint", 1],
      ["ft_burn", 4],
    ]);
  });
});

describe("event shapes", () => {
  const events = parseEvents(allLogs(scenario().values()));

  test("every fixture event of a known standard matches its shape", () => {
    for (const e of events) {
      if (!SCHEMAS[e.standard]) continue;
      const r = parseData(e);
      if (!r.ok) throw new Error(`${e.standard}/${e.event}: ${r.reason}`);
    }
  });

  test("the fixtures cover every handled event of every standard", () => {
    const seen = new Set(events.map((e) => `${e.standard}/${e.event}`));
    const handled = Object.values(HANDLERS).flatMap((byStandard) =>
      Object.entries(byStandard).flatMap(([standard, h]) => Object.keys(h).map((event) => `${standard}/${event}`)),
    );
    expect(handled.filter((k) => !seen.has(k))).toEqual([]);
  });

  test("every handler validates with the schema the event table names", () => {
    for (const byStandard of Object.values(HANDLERS)) {
      for (const [standard, handlers] of Object.entries(byStandard)) {
        for (const [event, h] of Object.entries(handlers)) expect(h.schema).toBe(SCHEMAS[standard]![event]!);
      }
    }
  });

  test("rejects wrong shapes and unknown events", () => {
    expect(parseData({ standard: "tredio-book", event: "trade", data: { series: "1" } }).ok).toBe(false);
    expect(parseData({ standard: "nep141", event: "ft_mint", data: { owner_id: "a.testnet", amount: "1" } }).ok).toBe(false);
    expect(parseData({ standard: "nep141", event: "ft_mint", data: [{ owner_id: "a.testnet", amount: "-1" }] }).ok).toBe(false);
    expect(parseData({ standard: "tredio-registry", event: "nope", data: {} })).toEqual({ ok: false, reason: "unknown event" });
  });

  test("book assets are 'usdc' or a token", () => {
    const d = (asset: unknown) => ({ standard: "tredio-book", event: "deposit", data: { account: "a.testnet", asset, amount: "1" } });
    expect(parseData(d("usdc")).ok).toBe(true);
    expect(parseData(d({ token: { series: 3, side: "down" } })).ok).toBe(true);
    expect(parseData(d({ token: { series: 3, side: "sideways" } })).ok).toBe(false);
  });
});

describe("helpers", () => {
  test("token ids", () => {
    expect(parseTokenId("12:up")).toEqual({ series: 12, side: "up" });
    expect(parseTokenId("3:down")).toEqual({ series: 3, side: "down" });
    expect(parseTokenId("3:sideways")).toBeNull();
    expect(parseTokenId("x:up")).toBeNull();
  });

  test("NEAR amounts as the factory logs them", () => {
    expect(parseNearAmount("0.05 NEAR")).toBe("50000000000000000000000");
    expect(parseNearAmount("1 NEAR")).toBe("1000000000000000000000000");
    expect(parseNearAmount("1.234567890123456789 NEAR")).toBe("1234567890123456789000000");
    expect(parseNearAmount("500 yoctoNEAR")).toBe("500");
    expect(parseNearAmount("0 NEAR")).toBe("0");
    expect(parseNearAmount("lots")).toBeNull();
  });

  test("owner keys in the account contract's form", () => {
    // A testnet account created with a hex key; its owner_key() view answers the p256 form.
    expect(canonicalOwnerKey("0393e8ad57d23efcd64d23160c4184c1094936bf5320e39081f68565d044edcbd9")).toBe("p256:24eKposN222SnvWAo96mjwzggTLZJsDGsftLQtJB7Vis2");
    expect(canonicalOwnerKey("p256:24eKposN222SnvWAo96mjwzggTLZJsDGsftLQtJB7Vis2")).toBe("p256:24eKposN222SnvWAo96mjwzggTLZJsDGsftLQtJB7Vis2");
    expect(canonicalOwnerKey("24eKposN222SnvWAo96mjwzggTLZJsDGsftLQtJB7Vis2")).toBe("p256:24eKposN222SnvWAo96mjwzggTLZJsDGsftLQtJB7Vis2");
  });
});
