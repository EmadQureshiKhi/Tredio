import { describe, expect, test } from "bun:test";
import {
  activationTicketMessage,
  canonicalJson,
  deployment,
  deploymentPlan,
  isDeployed,
  MAINNET_USDC,
  ownerApprovalDigest,
  ownerRequests,
  requestChallenge,
  requestJson,
} from "../src/index";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("owner requests", () => {
  test("hash exactly as the deployed account contract does", async () => {
    const json = requestJson({ account: "0ugt5v5y5rdhyhndtyhrwrkp5rxrmxhpfbrcx9ets3g94pjsdjt330", network: "testnet", nonce: 7, created_at: 1793900000, actions: [{ freeze: { frozen: true } } as never] });
    // The testnet account's `challenge_of` view returned this hash (base64url NvuQerSR...) for the same request.
    expect(hex(await requestChallenge(json))).toBe("36fb907ab491c79a291abc74631ca034220cc3bae82cad3c89afdfba9c38138a");
  });

  test("serialize their fields in the order the contract reads them", () => {
    const json = requestJson({ actions: [], created_at: 1, nonce: 2, network: "testnet", account: "a.testnet" } as never);
    expect(json).toBe('{"account":"a.testnet","network":"testnet","nonce":2,"created_at":1,"actions":[]}');
  });
});

describe("canonical JSON", () => {
  test("sorts keys at every level and drops undefined fields", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  test("refuses values that would hash differently on two machines", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson(1n as never)).toThrow();
  });
});

describe("API approvals and tickets", () => {
  const base = { network: "testnet" as const, account: "0uABC.testnet", nonce: "n1", expiresAt: 100 };

  test("an approval binds the action, its parameters, the account and the nonce", async () => {
    const follow = await ownerApprovalDigest({ ...base, request: ownerRequests.follow("0xAbC", { ratio: 0.5 }) });
    expect(follow).toHaveLength(32);
    expect(hex(follow)).toBe(hex(await ownerApprovalDigest({ ...base, account: "0uabc.testnet", request: ownerRequests.follow("0xabc", { ratio: 0.5 }) })));
    expect(hex(follow)).not.toBe(hex(await ownerApprovalDigest({ ...base, request: ownerRequests.follow("0xabc", { ratio: 0.6 }) })));
    expect(hex(follow)).not.toBe(hex(await ownerApprovalDigest({ ...base, nonce: "n2", request: ownerRequests.follow("0xabc", { ratio: 0.5 }) })));
    expect(hex(follow)).not.toBe(hex(await ownerApprovalDigest({ ...base, request: ownerRequests.enableRule(1, "AA") })));
  });

  test("an activation ticket signs a domain-tagged canonical message", () => {
    const m = new TextDecoder().decode(activationTicketMessage({ network: "testnet", ownerKey: "p256:K", account: "0uxyz", expiresAt: 5 }));
    expect(m).toBe('tredio-activation:v1:{"account":"0uxyz","expiresAt":5,"network":"testnet","ownerKey":"p256:K"}');
  });
});

describe("deployments", () => {
  test("testnet names every contract under the root account", () => {
    const d = deployment("testnet");
    for (const account of Object.values(d.contracts)) expect(account.endsWith(`.${d.root}`)).toBe(true);
    expect(d.globalCode.account).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  });

  test("mainnet is the plan until it is deployed: native USDC, Rhea, the MPC signer, no test window", () => {
    expect(isDeployed("testnet")).toBe(true);
    const plan = deploymentPlan("mainnet");
    if (isDeployed("mainnet")) return;
    expect(() => deployment("mainnet")).toThrow(/not deployed on mainnet yet/);
    expect(plan.contracts.usdc).toBe(MAINNET_USDC);
    for (const [role, account] of Object.entries(plan.contracts)) if (role !== "usdc") expect(account).toBe(`${role}.${plan.root}`);
    expect(plan.external).toEqual({ exchange: "v2.ref-finance.near", chainSignatures: "v1.signer" });
    expect(plan.params.outcomeTestWindow).toBe(0);
    expect(Object.keys(plan.params).sort()).toEqual(Object.keys(deployment("testnet").params).sort());
  });
});

describe("session calls", () => {
  test("default to the gas v1 accounts need and take v2's lower amount", async () => {
    const { calls, SESSION_CALL_TGAS_V2 } = await import("../src/index");
    const c = calls(deployment("testnet"));
    expect(c.account.sessionCall("0uabc", "faucet").gas).toBe((300n * 10n ** 12n).toString());
    expect(c.account.sessionCall("0uabc", { top_up_gas: { amount: "1" } }, SESSION_CALL_TGAS_V2).gas).toBe((150n * 10n ** 12n).toString());
  });
});

describe("account versions", () => {
  const missing = new Error("Contract call failed: 0uabc.version - wasm execution failed with error: MethodResolveError(MethodNotFound)");

  test("pick session gas, mark age and key handling by version", async () => {
    const { sessionCallTgas, sessionCallPrepaid, hlMarkMaxAge, keepsGasKeys, bindsMarkToAssetIndex } = await import("../src/index");
    expect([sessionCallTgas(1), sessionCallTgas(2), sessionCallTgas(3)]).toEqual([300, 150, 150]);
    expect([sessionCallPrepaid(1), sessionCallPrepaid(2)]).toEqual([3n * 10n ** 23n, 15n * 10n ** 22n]);
    expect([hlMarkMaxAge(1), hlMarkMaxAge(2)]).toEqual([120, 300]);
    expect([keepsGasKeys(1), keepsGasKeys(2), bindsMarkToAssetIndex(1), bindsMarkToAssetIndex(2)]).toEqual([false, true, false, true]);
  });

  test("a missing version view is v1 and cached; v2 answers are cached too", async () => {
    const { AccountVersions } = await import("../src/index");
    const reads: string[] = [];
    const v = new AccountVersions(async (account) => {
      reads.push(account);
      if (account === "0uold") throw missing;
      return 2;
    });
    expect(await v.of("0uold")).toBe(1);
    expect(await v.of("0uold")).toBe(1);
    expect(await v.of("0unew")).toBe(2);
    expect(await v.of("0unew")).toBe(2);
    expect(reads).toEqual(["0uold", "0unew"]);
    expect(v.known("0unew")).toBe(2);
    v.forget("0unew");
    expect(v.known("0unew")).toBeNull();
  });

  test("an RPC failure or a missing account reads as v1 without being cached", async () => {
    const { AccountVersions } = await import("../src/index");
    let fail: Error | null = new Error("rpc 429");
    const v = new AccountVersions(async () => {
      if (fail) throw fail;
      return 2;
    });
    expect(await v.of("0ua")).toBe(1);
    fail = new Error("Account does not exist: 0ua");
    expect(await v.of("0ua")).toBe(1);
    fail = null;
    expect(await v.of("0ua")).toBe(2);
  });

  test("concurrent reads share one view, and answers expire", async () => {
    const { AccountVersions } = await import("../src/index");
    let now = 0;
    let reads = 0;
    const v = new AccountVersions(
      async () => {
        reads++;
        await Bun.sleep(5);
        return 2;
      },
      { ttlMs: 1_000, now: () => now },
    );
    expect(await Promise.all([v.of("0ua"), v.of("0ua"), v.of("0ua")])).toEqual([2, 2, 2]);
    expect(reads).toBe(1);
    now = 1_001;
    await v.of("0ua");
    expect(reads).toBe(2);
  });

  test("the version view's answer: whole numbers from 2 up, anything else v1", async () => {
    const { versionFrom, isMissingMethod } = await import("../src/index");
    expect([versionFrom(2), versionFrom(3), versionFrom(1), versionFrom("2"), versionFrom(null), versionFrom(2.5)]).toEqual([2, 3, 1, 1, 1, 1]);
    expect(isMissingMethod(missing)).toBe(true);
    expect(isMissingMethod(new Error("CONTRACT_EXECUTION_ERROR"))).toBe(true);
    expect(isMissingMethod(new Error("UNKNOWN_ACCOUNT"))).toBe(false);
  });

  test("later account code joins the allowed hashes and the first request only once deployments names it", async () => {
    const { accountCodeHashes, latestAccountCode, upgradeToLatest } = await import("../src/index");
    const d = deployment("testnet");
    const { accountV2: _, accountV3: __, ...v1Only } = d.globalCode;
    const v1 = { ...d, globalCode: v1Only };
    expect(accountCodeHashes(v1)).toEqual([d.globalCode.account]);
    expect(upgradeToLatest(v1)).toBeNull();
    expect(latestAccountCode(v1)).toBeNull();
    const v2 = { ...d, globalCode: { ...v1Only, accountV2: "4reLvkAWfqk5fsqio1KLudk46cqRz9erQdaHkWZKMJDZ" } };
    expect(accountCodeHashes(v2)).toEqual([d.globalCode.account, "4reLvkAWfqk5fsqio1KLudk46cqRz9erQdaHkWZKMJDZ"]);
    expect(upgradeToLatest(v2)).toEqual({ upgrade: { code_hash: "4reLvkAWfqk5fsqio1KLudk46cqRz9erQdaHkWZKMJDZ" } });
    // A third version is the one offered, and accounts on v2 stay recognised.
    const v3 = { ...d, globalCode: { ...v2.globalCode, accountV3: "9nK6CrUQx6V5WQnaUM4R4VUP8iGXqvTTnZpoKcfJn9Yp" } };
    expect(accountCodeHashes(v3)).toEqual([d.globalCode.account, "4reLvkAWfqk5fsqio1KLudk46cqRz9erQdaHkWZKMJDZ", "9nK6CrUQx6V5WQnaUM4R4VUP8iGXqvTTnZpoKcfJn9Yp"]);
    expect(latestAccountCode(v3)).toEqual({ version: 3, hash: "9nK6CrUQx6V5WQnaUM4R4VUP8iGXqvTTnZpoKcfJn9Yp" });
    // Testnet has published v2, and offers the newest version it names.
    expect(d.globalCode.accountV2).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(upgradeToLatest(d)).toEqual({ upgrade: { code_hash: (d.globalCode.accountV3 ?? d.globalCode.accountV2)! } });
  });
});
