import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * The admin account the tests sign as: ADMIN_E2E_ACCOUNT and ADMIN_E2E_PRIVATE_KEY, else the
 * testnet deployer `tredio.testnet` from the local NEAR keychain (~/.near-credentials), which the
 * local backend lists in ADMIN_ACCOUNTS. The key stays in the test process and is never printed.
 */

export interface NearKey {
  accountId: string;
  publicKey: string;
  seed: Uint8Array;
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58decode = (s: string) => {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(ALPHABET.indexOf(c));
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
};
const b58encode = (bytes: Uint8Array) => {
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
};

function keyFrom(accountId: string, secret: string): NearKey {
  const seed = b58decode(secret.replace(/^ed25519:/, "")).slice(0, 32);
  if (seed.length !== 32) throw new Error("The admin test key is not an ed25519 secret key.");
  return { accountId, seed, publicKey: `ed25519:${b58encode(ed25519.getPublicKey(seed))}` };
}

export function adminAccount(): NearKey {
  if (process.env.ADMIN_E2E_ACCOUNT && process.env.ADMIN_E2E_PRIVATE_KEY) return keyFrom(process.env.ADMIN_E2E_ACCOUNT, process.env.ADMIN_E2E_PRIVATE_KEY);
  const file = path.join(homedir(), ".near-credentials", "testnet", "tredio.testnet.json");
  // near-cli writes the account id as `account_id` (legacy keychain) or leaves it to the file name.
  let json: { account_id?: string; private_key: string };
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`Set ADMIN_E2E_ACCOUNT and ADMIN_E2E_PRIVATE_KEY, or put the deployer's key at ${file}.`);
  }
  return keyFrom(json.account_id ?? "tredio.testnet", json.private_key);
}

/** A fresh key for an account no backend lists as an admin. */
export function strangerAccount(): NearKey {
  const seed = ed25519.utils.randomSecretKey();
  return { accountId: "stranger.testnet", seed, publicKey: `ed25519:${b58encode(ed25519.getPublicKey(seed))}` };
}

/** A NEP-413 signature (base64) of `message` for `recipient` with a 32-byte nonce, as a wallet's signMessage makes it. */
export function signNep413(key: NearKey, message: string, recipient: string, nonce: Uint8Array): string {
  const u32 = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
  };
  const str = (s: string) => {
    const bytes = new TextEncoder().encode(s);
    return [...u32(bytes.length), ...bytes];
  };
  const payload = new Uint8Array([...u32(2 ** 31 + 413), ...str(message), ...nonce, ...str(recipient), 0]);
  return Buffer.from(ed25519.sign(sha256(payload), key.seed)).toString("base64");
}
