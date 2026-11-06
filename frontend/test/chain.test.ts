import { describe, expect, test } from "bun:test";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { verifyNep413Signature, verifyPasskey } from "../../packages/chain/src/proofs";
import { ownerRequest, requestChallenge, requestJson } from "@tredio/contracts";
import { compactLowS, candidateOwnerKeys, ownerKeyHex, type Assertion } from "../src/lib/account/webauthn";
import { signInMessage } from "../src/lib/account/AccountProvider";
import { base58Encode, base64UrlEncode, concatBytes, hexEncode, utf8 } from "../src/lib/chain/encoding";
import { keyPairFromSeed, newKeyPair, publicKeyOf, seedOf, signNep413 } from "../src/lib/chain/keys";
import { failureOf, failureText, refusalOf, returnValue, type Outcome } from "../src/lib/chain/outcome";
import { SIGN_IN_RECIPIENT } from "../src/lib/config";

describe("session keys and NEP-413", () => {
  test("a key pair round-trips through NEAR's string forms", () => {
    const seed = new Uint8Array(32).fill(7);
    const k = keyPairFromSeed(seed);
    expect(k.publicKey.startsWith("ed25519:")).toBe(true);
    expect(seedOf(k.secretKey)).toEqual(seed);
    expect(publicKeyOf(k.secretKey)).toBe(k.publicKey);
  });

  test("the app's sign-in signature verifies the way the API checks it", () => {
    const k = newKeyPair();
    const message = signInMessage("0uabc", k.publicKey, 1_793_900_000);
    const signed = signNep413(k.secretKey, message, SIGN_IN_RECIPIENT);
    expect(signed.publicKey).toBe(k.publicKey);
    expect(verifyNep413Signature({ accountId: "0uabc", publicKey: k.publicKey, signature: signed.signature, nonce: signed.nonce, recipient: SIGN_IN_RECIPIENT, message })).toBe(true);
    // Another recipient or a changed message does not verify.
    expect(verifyNep413Signature({ accountId: "0uabc", publicKey: k.publicKey, signature: signed.signature, nonce: signed.nonce, recipient: "evil.example", message })).toBe(false);
    expect(verifyNep413Signature({ accountId: "0uabc", publicKey: k.publicKey, signature: signed.signature, nonce: signed.nonce, recipient: SIGN_IN_RECIPIENT, message: `${message}!` })).toBe(false);
  });

  test("the sign-in message is the exact text the API rebuilds", () => {
    expect(signInMessage("alice.testnet", "ed25519:abc", 1700000000)).toBe("Tredio sign-in\naccount: alice.testnet\nkey: ed25519:abc\nissued: 1700000000");
  });
});

/** A WebAuthn assertion over `challenge` by `secret`, as an authenticator makes it (DER signature, any S). */
function fakeAssertion(secret: Uint8Array, challenge: Uint8Array, highS: boolean) {
  const clientDataJson = JSON.stringify({ type: "webauthn.get", challenge: base64UrlEncode(challenge), origin: "https://tredio.bid" });
  const authData = concatBytes(sha256(utf8("tredio.bid")), new Uint8Array([0x05, 0, 0, 0, 1]));
  const hash = sha256(concatBytes(authData, sha256(utf8(clientDataJson))));
  const sig = p256.Signature.fromBytes(p256.sign(hash, secret, { prehash: false, lowS: true }), "compact");
  const N = p256.Point.CURVE().n;
  const der = new p256.Signature(sig.r, highS ? N - sig.s : sig.s).toBytes("der");
  return { clientDataJson, authData, hash, der };
}

/** The challenge a passkey signs for an owner request, exactly as the account contract hashes it. */
const challenge = await requestChallenge(requestJson(ownerRequest("0uabc", "testnet", [{ freeze: { frozen: true } }])));

describe("passkey signatures", () => {
  const secret = p256.utils.randomSecretKey();
  const ownerKey = `p256:${base58Encode(p256.getPublicKey(secret, true))}`;

  for (const highS of [false, true]) {
    test(`a ${highS ? "high-S" : "low-S"} signature becomes the low-S r||s the contract checks`, () => {
      const a = fakeAssertion(secret, challenge, highS);
      const compact = compactLowS(a.der);
      expect(compact).toHaveLength(128);
      const s = BigInt(`0x${compact.slice(64)}`);
      expect(s <= p256.Point.CURVE().n / 2n).toBe(true);
      expect(verifyPasskey({ authenticator_data: base64UrlEncode(a.authData), client_data_json: a.clientDataJson, signature: compact }, challenge, ownerKeyHex(ownerKey))).toBe(true);
    });
  }

  test("the owner key is among the keys recovered from one signature (finding the account on a new device)", () => {
    const a = fakeAssertion(secret, challenge, false);
    const assertion = { signed: { hash: a.hash, der: a.der } } as Assertion;
    expect(candidateOwnerKeys(assertion)).toContain(ownerKey);
  });

  test("owner keys convert to the hex the API verifies against", () => {
    expect(ownerKeyHex(ownerKey)).toBe(hexEncode(p256.getPublicKey(secret, true)));
  });
});

describe("transaction outcomes", () => {
  const ok = (logs: string[] = [], executor = "perps.tredio.testnet"): Outcome => ({
    status: { SuccessValue: btoa(JSON.stringify({ id: 4 })) },
    transaction: { hash: "H" },
    receipts_outcome: [{ outcome: { status: { SuccessValue: "" }, logs, executor_id: executor } }],
  });

  test("a contract panic reads as the contract's own words", () => {
    const failure = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: index stale" } } } };
    expect(failureText(failure)).toBe("index stale");
    const o: Outcome = { status: { Failure: failure }, receipts_outcome: [] };
    expect(failureOf(o)).toBe("index stale");
  });

  test("a failed receipt fails the transaction even when the transaction itself succeeded", () => {
    const o: Outcome = { status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: not enough balance" } } } } } } }] };
    expect(failureOf(o)).toBe("not enough balance");
  });

  test("a logged refusal is found with its reason, and a plain success has none", () => {
    const refused = ok([`EVENT_JSON:${JSON.stringify({ standard: "tredio-perps", version: "1.0.0", event: "open_refused", data: [{ owner: "0uabc", reason: "stale index" }] })}`]);
    expect(refusalOf(refused)).toBe("stale index");
    expect(failureOf(refused)).toBeNull();
    expect(refusalOf(ok([`EVENT_JSON:${JSON.stringify({ standard: "tredio-perps", version: "1.0.0", event: "position_opened", data: [{ id: 4 }] })}`]))).toBeNull();
    expect(returnValue<{ id: number }>(ok())).toEqual({ id: 4 });
  });
});
