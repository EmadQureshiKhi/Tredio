import { keccak_256 } from "@noble/hashes/sha3.js";

/**
 * The few EIP-712 pieces Hyperliquid's signatures use: string, bytes32 and unsigned integer fields
 * in a domain whose verifying contract is the zero address. Both the L1 "phantom agent" digest
 * (actions.ts) and the user-signed transfers (transfers.ts) are built from these.
 */

/** keccak256 of a string's UTF-8 bytes: a type string's hash, or a `string` field's encoding. */
export const keccakText = (s: string): Uint8Array => keccak_256(new TextEncoder().encode(s));

export function concat(...parts: Uint8Array[]): Uint8Array {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return all;
}

/** An unsigned integer (below 2^64) as one 32-byte big-endian word. */
export function word(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("eip712: only unsigned safe integers");
  const w = new Uint8Array(32);
  new DataView(w.buffer).setBigUint64(24, BigInt(n));
  return w;
}

const DOMAIN_TYPE = keccakText("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

/** The separator of the domain `{ name, version, chainId, verifyingContract: 0x0 }`. */
export function domainSeparator(name: string, version: string, chainId: number): Uint8Array {
  return keccak_256(concat(DOMAIN_TYPE, keccakText(name), keccakText(version), word(chainId), new Uint8Array(32)));
}

/** The digest a signer signs: keccak256(0x19 0x01 || domain separator || struct hash). */
export function typedDataDigest(separator: Uint8Array, structHash: Uint8Array): Uint8Array {
  return keccak_256(concat(new Uint8Array([0x19, 0x01]), separator, structHash));
}
