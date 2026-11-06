import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58Decode, base58Encode, base64Encode, type Bytes, concatBytes, randomBytes, utf8 } from "./encoding";

/**
 * Ed25519 keys in NEAR's string forms: the public key `ed25519:<base58 of 32 bytes>` and the secret
 * key `ed25519:<base58 of seed || public key>` (64 bytes), as near-kit and every NEAR tool read it.
 */

export interface KeyPair {
  publicKey: string;
  secretKey: string;
}

export const ed25519PublicKey = (seed: Uint8Array) => `ed25519:${base58Encode(ed25519.getPublicKey(seed))}`;

/** The key pair of a 32-byte seed. */
export function keyPairFromSeed(seed: Uint8Array): KeyPair {
  const pub = ed25519.getPublicKey(seed);
  return { publicKey: `ed25519:${base58Encode(pub)}`, secretKey: `ed25519:${base58Encode(concatBytes(seed, pub))}` };
}

/** A fresh random key pair. */
export const newKeyPair = (): KeyPair => keyPairFromSeed(randomBytes(32));

/** The 32-byte seed inside an `ed25519:` secret key (64-byte secret or 32-byte seed). */
export function seedOf(secretKey: string): Bytes {
  const raw = base58Decode(secretKey.replace(/^ed25519:/, ""));
  if (raw.length !== 64 && raw.length !== 32) throw new Error("an ed25519 secret key is 32 or 64 bytes");
  return raw.slice(0, 32);
}

export const publicKeyOf = (secretKey: string) => ed25519PublicKey(seedOf(secretKey));

const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const borshString = (s: string) => {
  const bytes = utf8(s);
  return concatBytes(u32(bytes.length), bytes);
};

/** SHA-256 of the NEP-413 payload: tag 2^31 + 413, then Borsh {message, nonce, recipient, callbackUrl: none}. */
export function nep413Hash(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  if (nonce.length !== 32) throw new Error("a NEP-413 nonce is 32 bytes");
  return sha256(concatBytes(u32(2 ** 31 + 413), borshString(message), nonce, borshString(recipient), new Uint8Array([0])));
}

/** A NEP-413 signed message by `secretKey`: the signature and nonce in base64, as the API takes them. */
export function signNep413(secretKey: string, message: string, recipient: string): { signature: string; nonce: string; publicKey: string } {
  const nonce = randomBytes(32);
  const seed = seedOf(secretKey);
  const signature = ed25519.sign(nep413Hash(message, nonce, recipient), seed);
  return { signature: base64Encode(signature), nonce: base64Encode(nonce), publicKey: ed25519PublicKey(seed) };
}
