/**
 * Owner approvals for backend actions. A few records keep acting for an account after the session
 * that created them is gone: following a leader (and resuming a follow), enabling an Autopilot
 * rule, and linking a caller identity. The backend accepts those only with a fresh assertion from
 * the account's passkey, checked against the account contract's `owner_key`, so a stolen session
 * key cannot make them.
 *
 * The passkey signs, as its WebAuthn challenge, SHA-256 of the canonical JSON of the approval
 * (action, account, network, parameters, a single-use nonce the backend issued and its expiry),
 * prefixed with a domain tag distinct from the account's own owner requests, so an approval can
 * never pass for an on-chain owner request, and the reverse.
 */

export const OWNER_ACTIONS = ["follow", "enable-rule", "link-identity"] as const;
export type OwnerApprovalAction = (typeof OWNER_ACTIONS)[number];

/** One action to approve: its kind and exactly the parameters the backend will act on. */
export interface OwnerApprovalRequest {
  action: OwnerApprovalAction;
  params: unknown;
}

/** What the backend issues before the prompt. */
export interface OwnerChallenge {
  nonce: string;
  expiresAt: number;
  network: "testnet" | "mainnet";
}

/** What an approved request carries: the nonce and the passkey's assertion (signature as r || s hex). */
export interface OwnerApproval {
  nonce: string;
  authenticator_data: string;
  client_data_json: string;
  signature: string;
}

/** The request each action's approval covers. The backend builds the same from what it receives. */
export const ownerRequests = {
  /** Starting a follow or changing its caps: the leader and the settings exactly as sent. */
  follow: (leader: string, settings: unknown): OwnerApprovalRequest => ({ action: "follow", params: { leader: leader.toLowerCase(), settings } }),
  /** Resuming a paused follow. */
  resumeFollow: (followId: number): OwnerApprovalRequest => ({ action: "follow", params: { follow: followId, status: "active" } }),
  /** Enabling (or resuming) a rule, pinned to the exact rule that was backtested. */
  enableRule: (ruleId: number, ruleHash: string): OwnerApprovalRequest => ({ action: "enable-rule", params: { rule: ruleId, ruleHash: ruleHash.toLowerCase() } }),
  /** Linking a caller identity to the account. */
  linkIdentity: (identity: string): OwnerApprovalRequest => ({ action: "link-identity", params: { identity: identity.toLowerCase() } }),
};

/** JSON with object keys sorted at every level, so both ends hash the same bytes for the same value. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson: numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  throw new Error(`canonicalJson: cannot encode a ${typeof value}`);
}

const DOMAIN = "tredio-api-approval:v1:";

/** The 32-byte challenge the passkey signs to approve `request` for `account`. */
export async function ownerApprovalDigest(a: {
  network: "testnet" | "mainnet";
  account: string;
  request: OwnerApprovalRequest;
  nonce: string;
  expiresAt: number;
}): Promise<Uint8Array> {
  const text = DOMAIN + canonicalJson({ account: a.account.toLowerCase(), action: a.request.action, expiresAt: a.expiresAt, network: a.network, nonce: a.nonce, params: a.request.params });
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
