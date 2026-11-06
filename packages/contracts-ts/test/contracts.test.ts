import { describe, expect, test } from "bun:test";
import { activationTicketMessage, canonicalJson, deployment, ownerApprovalDigest, ownerRequests, requestChallenge, requestJson } from "../src/index";

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
});
