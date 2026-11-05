/**
 * Passkey-signed owner requests: what the account contract verifies in `owner_execute`.
 * The passkey signs SHA-256("tredio-account:v1:" || request JSON) as its WebAuthn challenge.
 */
import type { OwnerAction, OwnerRequest } from "./types";

const DOMAIN = new TextEncoder().encode("tredio-account:v1:");

/** The exact JSON text of a request; the contract hashes these bytes, so send them unchanged. */
export function requestJson(r: OwnerRequest): string {
  return JSON.stringify({ account: r.account, network: r.network, nonce: r.nonce, created_at: r.created_at, actions: r.actions });
}

/** The 32-byte WebAuthn challenge for `json`. */
export async function requestChallenge(json: string): Promise<Uint8Array> {
  const body = new TextEncoder().encode(json);
  const data = new Uint8Array(DOMAIN.length + body.length);
  data.set(DOMAIN);
  data.set(body, DOMAIN.length);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/** A request for `account`, created now with a random nonce. */
export function ownerRequest(account: string, network: "testnet" | "mainnet", actions: OwnerAction[], now = Date.now()): OwnerRequest {
  const nonce = Number(crypto.getRandomValues(new Uint32Array(2)).reduce((a, b) => a * 2 ** 21 + (b % 2 ** 21), 0));
  // Block time can trail the client clock; a minute in the past is always inside the window.
  return { account, network, nonce, created_at: Math.floor(now / 1000) - 60, actions };
}
