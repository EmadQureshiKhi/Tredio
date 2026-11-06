import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  base58Decode,
  base58Encode,
  cached,
  failureOf,
  isTransient,
  nep413Hash,
  publicKeyOf,
  returnValue,
  toNear,
  verifyNep413Signature,
  verifyPasskey,
  type Viewer,
  walletWatch,
} from "../src/index";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("base58 and keys", () => {
  test("round-trips bytes, leading zeros included", () => {
    for (const bytes of [new Uint8Array([0, 0, 1, 2, 255]), new Uint8Array(32).fill(7), new Uint8Array([])]) {
      expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
    }
    expect(base58Encode(new Uint8Array([0, 0, 1]))).toBe("112");
  });

  test("publicKeyOf matches an independent ed25519 derivation, from a seed or a 64-byte secret", () => {
    const seed = new Uint8Array(32).map((_, i) => i * 3 + 1);
    const expected = `ed25519:${base58Encode(ed25519.getPublicKey(seed))}`;
    expect(publicKeyOf(`ed25519:${base58Encode(seed)}`)).toBe(expected);
    expect(publicKeyOf(`ed25519:${base58Encode(new Uint8Array([...seed, ...ed25519.getPublicKey(seed)]))}`)).toBe(expected);
  });
});

describe("NEP-413", () => {
  const nonce = Buffer.from(new Uint8Array(32).map((_, i) => i)).toString("base64");
  const message = { message: "Sign in to Tredio", nonce, recipient: "tredio.bid" };

  test("hashes the payload exactly as an independent Borsh encoding does", () => {
    // Vectors from a separate Python implementation of the NEP-413 payload.
    expect(hex(nep413Hash(message))).toBe("d2f457f22922c87849c3261a1cb9bc4f13efc5086b9a195f924cf2e8cc0a12d5");
    expect(hex(nep413Hash({ ...message, callbackUrl: "https://app.tredio.bid/cb" }))).toBe("42f794bce5c0911adae6cd62781e726be0c57776ad0437266c2d113fee9a34b4");
  });

  test("accepts the key's signature and nothing else", () => {
    const secret = ed25519.utils.randomSecretKey();
    const publicKey = `ed25519:${base58Encode(ed25519.getPublicKey(secret))}`;
    const signature = Buffer.from(ed25519.sign(nep413Hash(message), secret)).toString("base64");
    const proof = { ...message, accountId: "alice.testnet", publicKey, signature };
    expect(verifyNep413Signature(proof)).toBe(true);
    expect(verifyNep413Signature({ ...proof, recipient: "admin.tredio.bid" })).toBe(false);
    expect(verifyNep413Signature({ ...proof, publicKey: `ed25519:${base58Encode(ed25519.getPublicKey(ed25519.utils.randomSecretKey()))}` })).toBe(false);
  });
});

describe("passkeys", () => {
  const secret = p256.utils.randomSecretKey();
  const owner = hex(p256.getPublicKey(secret, true));
  const challenge = sha256(new TextEncoder().encode("a request"));

  function assertion(opts: { challenge?: Uint8Array; flags?: number; type?: string } = {}) {
    const auth = new Uint8Array(37);
    auth[32] = opts.flags ?? 0x05;
    const client = JSON.stringify({ type: opts.type ?? "webauthn.get", challenge: Buffer.from(opts.challenge ?? challenge).toString("base64url"), origin: "https://app.tredio.bid" });
    const digest = sha256(new Uint8Array([...auth, ...sha256(new TextEncoder().encode(client))]));
    const signature = hex(p256.sign(digest, secret, { prehash: false, lowS: false, format: "compact" }));
    return { authenticator_data: Buffer.from(auth).toString("base64url"), client_data_json: client, signature };
  }

  test("verifies a WebAuthn assertion over the challenge, as the account contract does", () => {
    expect(verifyPasskey(assertion(), challenge, owner)).toBe(true);
  });

  test("refuses another challenge, a missing user-presence flag, or a create ceremony", () => {
    expect(verifyPasskey(assertion({ challenge: sha256(new TextEncoder().encode("another")) }), challenge, owner)).toBe(false);
    expect(verifyPasskey(assertion({ flags: 0x04 }), challenge, owner)).toBe(false);
    expect(verifyPasskey(assertion({ type: "webauthn.create" }), challenge, owner)).toBe(false);
    expect(verifyPasskey(assertion(), challenge, hex(p256.getPublicKey(p256.utils.randomSecretKey(), true)))).toBe(false);
  });
});

describe("outcomes", () => {
  const ok = { status: { SuccessValue: Buffer.from(JSON.stringify({ id: "9" })).toString("base64") }, receipts_outcome: [] };

  test("reads the return value and the first failure", () => {
    expect(returnValue<{ id: string }>(ok as never)).toEqual({ id: "9" });
    expect(failureOf(ok as never)).toBeNull();
    const failed = { status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: unknown market" } } } } } } }] };
    expect(failureOf(failed as never)).toBe("unknown market");
  });

  test("tells a rate limit from a real refusal", () => {
    expect(isTransient(new Error("HTTP 429 Too Many Requests"))).toBe(true);
    expect(isTransient(new Error("fetch failed"))).toBe(true);
    expect(isTransient(new Error("Account does not exist"))).toBe(false);
  });

  test("formats yoctoNEAR without float rounding", () => {
    expect(toNear(10n ** 24n)).toBe("1");
    expect(toNear(15n * 10n ** 23n)).toBe("1.5");
    expect(toNear(1234567n * 10n ** 18n)).toBe("1.234567");
    expect(toNear(-(3n * 10n ** 23n))).toBe("-0.3");
  });
});

describe("cached readings", () => {
  test("waits for the first reading, then serves the last one while refreshing behind it", async () => {
    let n = 0;
    let gate = Promise.resolve();
    const read = cached(async () => {
      await gate;
      return ++n;
    }, 10);
    expect(await read()).toBe(1);
    await sleep(15);
    let release!: () => void;
    gate = new Promise((resolve) => (release = resolve));
    expect(await read()).toBe(1);
    release();
    await sleep(1);
    expect(await read()).toBe(2);
  });

  test("a wallet whose balance cannot be read keeps its last good reading", async () => {
    let failing = false;
    const viewer = {
      balance: async () => {
        if (failing) throw new Error("HTTP 429");
        return 2n * 10n ** 24n;
      },
      gasKey: async () => ({ balance: 3n * 10n ** 23n, nonces: 4 }),
    } as unknown as Viewer;
    const wallet = walletWatch(viewer, "Keeper", "tredio-keeper.testnet", { gasKeys: ["ed25519:x"] }, 5);
    expect((await wallet()).balance).toBe("2");
    failing = true;
    await sleep(10);
    await wallet();
    await sleep(1);
    const w = await wallet();
    expect(w.balance).toBe("2");
    expect(w.gasKeys[0]).toEqual({ publicKey: "ed25519:x", balance: "0.3", nonces: 4 });
  });
});
