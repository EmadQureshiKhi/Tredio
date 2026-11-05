import { canonicalJson } from "./owner-approval";

/**
 * Activation tickets. Creating a passkey account costs the relayer its storage and the first
 * session's gas allowance (about 0.4 NEAR), and a fresh passkey costs nothing to make, so the
 * relayer creates only accounts the API vouched for: an ed25519 signature by the API's ticket key
 * over the owner key, the account it derives to, the network and an expiry.
 */

export const ACTIVATION_TICKET_TTL_SEC = 600;

export interface ActivationTicket {
  ownerKey: string;
  account: string;
  expiresAt: number;
  /** base64 ed25519 signature over `activationTicketMessage`. */
  signature: string;
}

/** The bytes a ticket's signature covers. */
export function activationTicketMessage(t: { network: "testnet" | "mainnet"; ownerKey: string; account: string; expiresAt: number }): Uint8Array {
  return new TextEncoder().encode(`tredio-activation:v1:${canonicalJson({ account: t.account, expiresAt: t.expiresAt, network: t.network, ownerKey: t.ownerKey })}`);
}
