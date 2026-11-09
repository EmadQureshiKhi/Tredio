/**
 * The three spellings of one policy wallet key. OutLayer custody keeps the wallet's NEAR key in its
 * enclave and sends from the key's implicit account (64 hex characters); its contract names the key
 * `ed25519:<hex>`; NEAR (and the account contract's sessions) spell the same key `ed25519:<base58>`.
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

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

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error("not base58");
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bytesOfHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => Number.parseInt(x, 16));

/** An ed25519 implicit account: the lowercase hex of its 32-byte public key. */
export const isImplicitAccount = (accountId: string) => /^[0-9a-f]{64}$/.test(accountId);

function implicitBytes(accountId: string): Uint8Array {
  if (!isImplicitAccount(accountId)) throw new Error(`${accountId} is not an ed25519 implicit account`);
  return bytesOfHex(accountId);
}

/** `ed25519:<base58>`: the key of an implicit account as NEAR spells it (what a session is added for). */
export const nearKeyOf = (implicitAccountId: string) => `ed25519:${base58Encode(implicitBytes(implicitAccountId))}`;

/** `ed25519:<hex>`: the key of an implicit account as OutLayer's contract names a policy wallet. */
export const custodyKeyOf = (implicitAccountId: string) => `ed25519:${hexOf(implicitBytes(implicitAccountId))}`;

/** The implicit account of an `ed25519:<base58>` or `ed25519:<hex>` public key. */
export function implicitAccountOf(publicKey: string): string {
  const body = publicKey.replace(/^ed25519:/, "");
  const raw = /^[0-9a-fA-F]{64}$/.test(body) ? bytesOfHex(body.toLowerCase()) : base58Decode(body);
  if (raw.length !== 32) throw new Error("an ed25519 public key is 32 bytes");
  return hexOf(raw);
}
