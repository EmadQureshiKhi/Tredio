import { describe, expect, test } from "bun:test";
import { burnPerDay, DAY_MS, freshMemory, plan } from "../src/plan";
import { contractTargets, format, NEAR, parseTargets, USDC } from "../src/targets";

describe("targets", () => {
  test("parse NEAR, gas-key and USDC entries", () => {
    const [a, b] = parseTargets("relayer=tredio-relayer.testnet@2/5,keeper-gas=tredio-keeper.testnet/ed25519:BiXU9Gv6Z2AmTAy3CwXYiKYFpbcKphFi55AYbB6JaDeP@0.3/1.25", "near");
    expect(a).toEqual({ name: "relayer", kind: "near", account: "tredio-relayer.testnet", publicKey: null, min: 2n * NEAR, target: 5n * NEAR });
    expect(b).toMatchObject({ kind: "gasKey", min: (3n * NEAR) / 10n, target: (125n * NEAR) / 100n });
    expect(parseTargets("mm=tredio-mm.testnet@500/5000", "usdc")[0]).toMatchObject({ kind: "usdc", min: 500n * USDC });
    expect(() => parseTargets("x=y@5/2", "near")).toThrow(/above the minimum/);
    expect(format(1_234_500n * 10n ** 18n, NEAR)).toBe("1.2345");
  });

  test("every Tredio contract keeps free NEAR above its storage; an external token is left out", () => {
    const contracts = { usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", registry: "registry.tredio.near", perps: "perps.tredio.near" };
    const t = contractTargets(contracts, "tredio.near", "0.3/1");
    expect(t.map((x) => [x.name, x.kind, x.account])).toEqual([
      ["registry-free", "free", "registry.tredio.near"],
      ["perps-free", "free", "perps.tredio.near"],
    ]);
    expect(t[0]).toMatchObject({ min: (3n * NEAR) / 10n, target: NEAR });
    expect(contractTargets(contracts, "tredio.near", "off")).toEqual([]);
    expect(() => contractTargets(contracts, "tredio.near", "1/0.5")).toThrow(/above the minimum/);
  });
});

describe("plan", () => {
  const [relayer, keeper] = parseTargets("relayer=r.testnet@2/5,keeper=k.testnet@1/3", "near");
  const o = { cooldownMs: 600_000, dailyCap: () => 10n * NEAR, spendable: () => 4n * NEAR };

  test("refills below the minimum to the target, by priority, within what the treasury can spend", () => {
    const d = plan([relayer!, keeper!], new Map([["relayer", 1n * NEAR], ["keeper", 0n]]), new Map(), 0, o);
    expect(d.map((x) => [x.target.name, x.amount, x.skip])).toEqual([
      ["relayer", 4n * NEAR, null],
      ["keeper", 0n, "the treasury cannot afford it"],
    ]);
  });

  test("a contract's free balance draws on the same NEAR budget", () => {
    const [registry] = contractTargets({ registry: "registry.tredio.testnet" }, "tredio.testnet", "0.3/1");
    const d = plan([relayer!, registry!], new Map([["relayer", 1n * NEAR], ["registry-free", 0n]]), new Map(), 0, { ...o, spendable: () => 5n * NEAR });
    expect(d.map((x) => [x.target.name, x.amount, x.skip])).toEqual([
      ["relayer", 4n * NEAR, null],
      ["registry-free", NEAR, null],
    ]);
  });

  test("respects cooldowns, backoff and the daily cap", () => {
    const m = freshMemory();
    m.lastTransfer = { at: 0, amount: "1", hash: null, status: "sent" };
    expect(plan([relayer!], new Map([["relayer", 0n]]), new Map([["relayer", m]]), 1000, o)[0]!.skip).toBe("cooling down");
    const capped = { ...freshMemory(), sent: [{ at: 0, amount: (10n * NEAR).toString() }] };
    expect(plan([relayer!], new Map([["relayer", 0n]]), new Map([["relayer", capped]]), 700_000, o)[0]!.skip).toBe("daily cap reached");
    expect(plan([relayer!], new Map([["relayer", 0n]]), new Map([["relayer", { ...freshMemory(), retryAt: 5000 }]]), 1000, o)[0]!.skip).toBe("backing off after a failure");
  });
});

test("burn per day counts refills, and waits for six hours of samples", () => {
  const short = { ...freshMemory(), samples: [{ at: 0, balance: "5" }, { at: 3_600_000, balance: "4" }] };
  expect(burnPerDay(short, 3_600_000)).toBeNull();
  const m = { ...freshMemory(), samples: [{ at: 0, balance: (5n * NEAR).toString() }, { at: DAY_MS / 2, balance: (4n * NEAR).toString() }], sent: [{ at: DAY_MS / 4, amount: (1n * NEAR).toString() }] };
  expect(burnPerDay(m, DAY_MS / 2)).toBe(4n * NEAR);
});
