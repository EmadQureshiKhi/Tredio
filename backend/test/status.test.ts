import { describe, expect, test } from "bun:test";
import { publicIssue } from "../src/status";

describe("public status", () => {
  test("says why a service is down without passing its errors on", () => {
    expect(publicIssue({ ok: true, latencyMs: 4, alerts: [] })).toBeNull();
    expect(publicIssue({ ok: false, latencyMs: null, alerts: [] })).toBe("not answering");
    expect(publicIssue({ ok: false, latencyMs: 2, alerts: ["balance: below 1 NEAR", "stale: 2 trends"] })).toBe("balance below 1 NEAR");
    expect(publicIssue({ ok: false, latencyMs: 2, alerts: [] })).toBe("reports a problem");
  });
});
