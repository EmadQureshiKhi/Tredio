import { describe, expect, test } from "bun:test";
import { contractFunds, describeHealth, publicIssue } from "../src/status";

describe("public status", () => {
  test("says why a service is down without passing its errors on", () => {
    expect(publicIssue({ ok: true, latencyMs: 4, alerts: [] })).toBeNull();
    expect(publicIssue({ ok: false, latencyMs: null, alerts: [] })).toBe("not answering");
    expect(publicIssue({ ok: false, latencyMs: 2, alerts: ["balance: below 1 NEAR", "stale: 2 trends"] })).toBe("balance below 1 NEAR");
    expect(publicIssue({ ok: false, latencyMs: 2, alerts: [] })).toBe("reports a problem");
  });

  test("reads when a service started, as unix seconds or an ISO time", () => {
    expect(describeHealth({ ok: true, startedAt: 1_794_000_000 }).startedAt).toBe(1_794_000_000);
    expect(describeHealth({ ok: true, startedAt: "2026-11-09T10:00:00.000Z" }).startedAt).toBe(Date.parse("2026-11-09T10:00:00.000Z") / 1000);
    expect(describeHealth({ ok: true }).startedAt).toBeNull();
  });

  test("a contract whose free balance cannot pay for its next writes is down; Circle's USDC is left out", async () => {
    const NEAR = 10n ** 24n;
    const accounts: Record<string, { amount: string; storage_usage: number }> = {
      // 2.692 NEAR locked by 269_200 bytes, 0.0001 NEAR free: the registry that stopped taking reports.
      "registry.tredio.near": { amount: (2_692_100n * 10n ** 18n).toString(), storage_usage: 269_200 },
      "perps.tredio.near": { amount: (3n * NEAR).toString(), storage_usage: 270_000 },
      "book.tredio.near": { amount: (4n * NEAR).toString(), storage_usage: 100_000 },
    };
    const chain = {
      deployment: {
        root: "tredio.near",
        contracts: { usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", registry: "registry.tredio.near", perps: "perps.tredio.near", book: "book.tredio.near", outcomes: "outcomes.tredio.near" },
      },
      viewer: {
        rpc: async (_: string, p: { account_id: string }) => {
          const a = accounts[p.account_id];
          if (!a) throw new Error("UNKNOWN_ACCOUNT");
          return a;
        },
      },
    } as unknown as Parameters<typeof contractFunds>[0];
    const funds = await contractFunds(chain);
    expect(funds.map((f) => [f.role, f.freeNear, f.ok, f.low])).toEqual([
      ["registry", "0.000", false, true],
      ["perps", "0.300", true, false],
      ["book", "3.000", true, false],
      ["outcomes", null, false, true],
    ]);
  });
});
