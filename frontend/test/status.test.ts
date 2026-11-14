import { describe, expect, test } from "bun:test";
import { outlayerStall, STALL_NOTE } from "../src/features/status/data";

const service = (name: string, ok: boolean, issue: string | null) => ({ name, ok, issue, latencyMs: 12, startedAt: 0 });

describe("an OutLayer stall", () => {
  test("is read from the oracle's own issue text, with the count and the last good run", () => {
    const stall = outlayerStall({ services: [service("relayer", true, null), service("oracle", false, "enclave runs failing on OutLayer (5 in a row, each after its retries; last good run 2026-11-14 15:41 UTC)")] });
    expect(stall).toEqual({ inARow: 5, lastGoodAt: Date.UTC(2026, 10, 14, 15, 41) / 1000 });
  });

  test("tolerates an issue without a last good run", () => {
    expect(outlayerStall({ services: [service("oracle", false, "enclave runs failing on OutLayer (2 in a row, each after its retries)")] })).toEqual({ inARow: 2, lastGoodAt: null });
  });

  test("is not any other oracle problem, and not a healthy oracle", () => {
    expect(outlayerStall({ services: [service("oracle", false, "balance below 1 NEAR")] })).toBeNull();
    expect(outlayerStall({ services: [service("oracle", true, null)] })).toBeNull();
    expect(outlayerStall({ services: [] })).toBeNull();
  });

  test("the note says it is upstream and that nothing is at risk", () => {
    expect(STALL_NOTE).toContain("upstream of Tredio");
    expect(STALL_NOTE).toContain("keeps its last signed value");
  });
});
