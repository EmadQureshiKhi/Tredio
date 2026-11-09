/**
 * An Agent API grant token, made where the owner is (the browser) and sealed to the Autopilot
 * executor at once: the API, and the owner's passkey, see only its SHA-256 commitment.
 */
import { sha256 } from "@noble/hashes/sha2.js";

const b64url = (b: Uint8Array) => {
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** The `credential` of a `grant_issue` intent for `token`: SHA-256 of its text, hex. */
export const grantCommitment = (token: string) => hex(sha256(new TextEncoder().encode(token)));

/** A new grant token (`ngt_` and 32 random bytes, base64url) and its commitment. */
export function newGrantCredential(): { token: string; commitment: string } {
  const token = `ngt_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
  return { token, commitment: grantCommitment(token) };
}
