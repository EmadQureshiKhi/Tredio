import { describe, expect, test } from "bun:test";
import type { Sender } from "@tredio/chain";
import { deployment } from "@tredio/contracts";
import { Executor } from "../src/executor";
import { type Action, GRADUATION_IN_FLIGHT, plan } from "../src/plan";
import type { Snapshot } from "../src/snapshot";

const D = deployment("testnet");

/** A sender whose sends fail with the given errors, in order, then succeed. */
function sender(errors: string[]) {
  const sent: string[] = [];
  const s = {
    send: async (call: { methodName: string }) => {
      sent.push(call.methodName);
      const e = errors.shift();
      if (e) throw new Error(e);
      return { hash: `tx${sent.length}`, value: undefined };
    },
  };
  return { sender: s as unknown as Sender, sent };
}

const graduate = (): Action => {
  const snap = { now: 0, params: {} as never, windows: [], trends: [], latest: [], settleable: new Set<number>(), unlisted: [], expiredMarkets: [], positions: [], perpMarkets: [], curves: [{ trend: "topic:a", stage: "pooled" } as never] } as Snapshot;
  return plan(snap, D, { seriesWindows: [], coins: false, settleDelaySec: 30 })[0]!;
};

describe("keeper executor", () => {
  test("a graduation step in flight is retried on the next scan, not backed off or counted as a failure", async () => {
    let now = 1_000_000;
    const { sender: s, sent } = sender(["Smart contract panicked: a graduation step is in flight"]);
    const ex = new Executor(s, () => {}, () => now);
    const a = graduate();
    expect(a.waitsOn).toBe(GRADUATION_IN_FLIGHT);
    expect(await ex.run([a], 4)).toBe(1);
    expect(ex.failed).toBe(0);
    expect(ex.lastError).toBeNull();
    now += 5_000;
    expect(await ex.run([a], 4)).toBe(1);
    expect(sent).toEqual(["graduate", "graduate"]);
    expect(ex.sent.graduate).toBe(1);
  });

  test("any other refusal backs off", async () => {
    let now = 1_000_000;
    const { sender: s, sent } = sender(["Smart contract panicked: curve not ready"]);
    const ex = new Executor(s, () => {}, () => now);
    const a = graduate();
    await ex.run([a], 4);
    expect(ex.failed).toBe(1);
    now += 5_000;
    expect(await ex.run([a], 4)).toBe(0);
    now += 30_000;
    expect(await ex.run([a], 4)).toBe(1);
    expect(sent).toEqual(["graduate", "graduate"]);
  });
});
