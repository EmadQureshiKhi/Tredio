import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * NEAR proofs the API accepts:
 * - NEP-413 signed messages (wallets' `signMessage`, and the app's session key): an ed25519
 *   signature over SHA-256 of the Borsh payload, checked against a key the account really holds
 *   on chain (`view_access_key`).
 * - Passkey approvals: a WebAuthn assertion over a challenge, checked against the P-256 owner key
 *   the account contract stores (`owner_key`).
 */

export interface Nep413Proof {
  accountId: string;
  /** `ed25519:<base58>` */
  publicKey: string;
  /** base64 */
  signature: string;
  /** base64 of 32 bytes */
  nonce: string;
  recipient: string;
  message: string;
  callbackUrl?: string | null;
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return new Uint8Array(out);
}

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const borshString = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  return new Uint8Array([...u32(bytes.length), ...bytes]);
};

/** SHA-256 of the NEP-413 payload: tag 2^31 + 413, then Borsh {message, nonce, recipient, callbackUrl}. */
export function nep413Hash(p: Pick<Nep413Proof, "message" | "nonce" | "recipient" | "callbackUrl">): Uint8Array {
  const nonce = Buffer.from(p.nonce, "base64");
  if (nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  const parts = [
    u32(2 ** 31 + 413),
    borshString(p.message),
    new Uint8Array(nonce),
    borshString(p.recipient),
    p.callbackUrl ? new Uint8Array([1, ...borshString(p.callbackUrl)]) : new Uint8Array([0]),
  ];
  const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) {
    all.set(x, o);
    o += x.length;
  }
  return sha256(all);
}

/** True when the signature is the key's over the NEP-413 payload. Says nothing about whether the account holds the key. */
export function verifyNep413Signature(p: Nep413Proof): boolean {
  if (!p.publicKey.startsWith("ed25519:")) return false;
  try {
    const pk = base58Decode(p.publicKey.slice("ed25519:".length));
    const sig = Buffer.from(p.signature, "base64");
    return pk.length === 32 && sig.length === 64 && ed25519.verify(new Uint8Array(sig), nep413Hash(p), pk);
  } catch {
    return false;
  }
}

export type KeyPermission =
  | { kind: "full" }
  | { kind: "function_call"; receiverId: string; methodNames: string[]; gasKey: boolean };

/** Reads an account's access key over RPC: its permission, or null when the account does not hold it. */
export type AccessKeyReader = (accountId: string, publicKey: string) => Promise<KeyPermission | null>;

type RpcCall = <T>(method: string, params: unknown) => Promise<T>;

export function accessKeyReader(rpc: RpcCall): AccessKeyReader {
  return async (accountId, publicKey) => {
    let r: { permission: unknown };
    try {
      r = await rpc<{ permission: unknown }>("query", { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey });
    } catch (e) {
      if (/UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|does not exist/i.test(String((e as Error).message))) return null;
      throw e;
    }
    const perm = r.permission;
    if (perm === "FullAccess" || (typeof perm === "object" && perm !== null && "GasKeyFullAccess" in perm)) return { kind: "full" };
    const fc = (perm as Record<string, { receiver_id: string; method_names: string[] }>)?.FunctionCall ??
      (perm as Record<string, { receiver_id: string; method_names: string[] }>)?.GasKeyFunctionCall;
    if (fc) return { kind: "function_call", receiverId: fc.receiver_id, methodNames: fc.method_names, gasKey: "GasKeyFunctionCall" in (perm as object) };
    return null;
  };
}

/** A passkey assertion as the app sends it (signature: 64-byte r || s, hex). */
export interface PasskeyAssertion {
  authenticator_data: string;
  client_data_json: string;
  signature: string;
}

/**
 * True when `a` is the passkey with compressed P-256 key `ownerKeyHex` signing `challenge`
 * (WebAuthn: the signature covers SHA-256(authData || SHA-256(clientDataJSON)), the client data's
 * challenge is base64url(challenge) and its type is webauthn.get).
 */
export function verifyPasskey(a: PasskeyAssertion, challenge: Uint8Array, ownerKeyHex: string): boolean {
  try {
    const client = JSON.parse(a.client_data_json) as { type?: string; challenge?: string };
    if (client.type !== "webauthn.get" || client.challenge !== Buffer.from(challenge).toString("base64url")) return false;
    const auth = Buffer.from(a.authenticator_data, "base64url");
    if (auth.length < 37 || (auth[32]! & 0x01) === 0) return false;
    const msg = new Uint8Array([...auth, ...sha256(new TextEncoder().encode(a.client_data_json))]);
    return p256.verify(Buffer.from(a.signature, "hex"), sha256(msg), Buffer.from(ownerKeyHex, "hex"), { prehash: false, lowS: false });
  } catch {
    return false;
  }
}

/** `p256:<base58>` (as the account contract reports it) to hex. */
export function ownerKeyHex(ownerKey: string): string {
  return Buffer.from(base58Decode(ownerKey.replace(/^p256:/, ""))).toString("hex");
}
