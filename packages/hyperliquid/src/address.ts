import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * The Hyperliquid address a Tredio account trades from: the EVM address of the account's own
 * Chain Signatures key (predecessor = the account, path `hyperliquid`). It is read from the MPC
 * contract's `derived_public_key` view, so no root key is hardcoded here.
 */

export const HL_PATH = "hyperliquid";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(s: string): Uint8Array {
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

/** `secp256k1:<base58 of x || y>` to its EVM address. */
export function evmAddressOfKey(key: string): string {
  const xy = base58Decode(key.replace(/^secp256k1:/, ""));
  if (xy.length !== 64) throw new Error("expected a 64-byte secp256k1 public key");
  return `0x${bytesToHex(keccak_256(xy).slice(-20))}`;
}

type View = <T>(contractId: string, method: string, args: object) => Promise<T>;

/** The account's Hyperliquid address, asking the Chain Signatures contract for its derived key. */
export async function hyperliquidAddressOf(view: View, signerContract: string, account: string): Promise<string> {
  const key = await view<string>(signerContract, "derived_public_key", { path: HL_PATH, predecessor: account, domain_id: 0 });
  return evmAddressOfKey(key);
}
