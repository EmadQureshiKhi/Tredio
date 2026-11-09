/**
 * Autopilot's policy wallet on mainnet, through the NEAR Intents Agent API
 * (`@near-intents-agent-api/sdk`, a partner key from partners.near-intents.org). Each account gets
 * one agent: an OutLayer custody wallet whose owner is the account's own passkey (the API's
 * `passkey` owner type), so the same passkey that owns the Tredio account signs the agent's policy,
 * its grant, and its freeze, as WebAuthn assertions the API verifies.
 *
 * The policy opens one thing: native NEAR calls to the account itself (`native.near.call`). No
 * swaps, transfers or withdrawals, no assets, no NEAR attached, no message signing. The executor
 * holds a grant token sealed to it and asks the API for `session_call`s, which the agent's NEAR
 * account sends; the account contract's session is the second limit, exactly as on testnet.
 *
 * Server side only: the partner key never reaches a browser (the app imports this package's root,
 * never this module).
 */
import { type AgentApi, createAgentApi, type GenerateIntentResponse, type IdempotentResult, type OwnerWallet, type Policy, type StatusResponse } from "@near-intents-agent-api/sdk";

export type { AgentApi, GenerateIntentResponse, Policy as AgentPolicy } from "@near-intents-agent-api/sdk";
import { p256 } from "@noble/curves/nist.js";
import { base58Decode, nearKeyOf } from "./keys";

export { grantCommitment, newGrantCredential } from "./grant";
import type { ReadValue, SessionCallResult, WalletSigner, WalletState } from "./signer";

/** The Agent API runs on mainnet only. */
export const AGENT_API_NETWORK = "mainnet";

/** The API client under the partner key (`baseUrl` only for a self-hosted deployment or a test). */
export function agentApi(apiKey: string, opts: { baseUrl?: string; fetch?: typeof fetch } = {}): AgentApi {
  return createAgentApi({ apiKey, ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
}

const b64url = (b: Uint8Array) => {
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** DER header of a P-256 SubjectPublicKeyInfo with an uncompressed point. */
const P256_SPKI = Uint8Array.from([0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00]);

export interface AccountPasskey {
  /** The account contract's `owner_key` (`p256:<base58>`) or the same key as SEC1 hex. */
  ownerKeyHex: string;
  /** The WebAuthn credential id (base64url). */
  credentialId: string;
  /** The relying party the passkey was made for, and the app origin that asks for assertions. */
  rpId: string;
  origin: string;
}

/** A passkey's P-256 key (`p256:<base58>`, as the account's `owner_key` view returns it, or SEC1 hex) as the Agent API spells it: SPKI DER of the uncompressed point, base64url. */
export function passkeySpki(ownerKey: string): string {
  const raw = ownerKey.startsWith("p256:") ? hex(base58Decode(ownerKey.slice(5))) : ownerKey.replace(/^0x/, "").toLowerCase();
  const point = p256.Point.fromHex(raw).toBytes(false);
  const spki = new Uint8Array(P256_SPKI.length + point.length);
  spki.set(P256_SPKI);
  spki.set(point, P256_SPKI.length);
  return b64url(spki);
}

/** The account's passkey as the Agent API names an owner. */
export const passkeyOwner = (p: AccountPasskey): OwnerWallet => ({ type: "passkey", credential_id: p.credentialId, public_key: passkeySpki(p.ownerKeyHex), rp_id: p.rpId, origin: p.origin });

export interface AgentPolicyOptions {
  account: string;
  callsPerHour?: number;
}

/** Calls only to the account itself, with nothing else open. */
export function autopilotAgentPolicy(o: AgentPolicyOptions): Policy {
  return {
    frozen: false,
    actions: [],
    confidential: false,
    owner_approval: false,
    assets: [],
    limits: {},
    max_actions_per_hour: o.callsPerHour ?? 120,
    destinations: { mode: "only", list: [] },
    budget: { daily_usd: null, weekly_usd: null, monthly_usd: null },
    timelock_ms: 0,
    native: {
      near: { sign_message: [], transfer: false, call: [o.account] },
      evm: { sign_typed_data: [], sign_message: false, sign_transaction: false },
      solana: { sign_message: false, sign_transaction: false },
    },
  };
}

/** Why an agent's policy is not Autopilot's for `account`, or null. */
export function agentPolicyProblem(p: Policy | null, account: string): string | null {
  if (!p) return "the agent has no policy applied yet";
  if (p.actions.length > 0) return "the agent's policy allows swaps, transfers or withdrawals";
  const near = p.native?.near;
  if (!near || near.call.length !== 1 || near.call[0] !== account) return "the agent's policy lets it call contracts other than the account";
  if (near.transfer || near.sign_message.length > 0) return "the agent's policy lets it send NEAR or sign messages";
  const evm = p.native?.evm;
  const sol = p.native?.solana;
  if (evm && (evm.sign_typed_data.length > 0 || evm.sign_message || evm.sign_transaction || evm.sign_intent)) return "the agent's policy opens its EVM key";
  if (sol && (sol.sign_message || sol.sign_transaction || sol.sign_intent || sol.sign_transfer || (sol.sign_in?.length ?? 0) > 0)) return "the agent's policy opens its Solana key";
  return null;
}

const TERMINAL = new Set<StatusResponse["status"]>(["SUCCESS", "FAILED", "REFUNDED", "UNCERTAIN", "NEEDS_REVIEW"]);

/** Follows an operation to its end; `getStatus` long-polls up to 30 s a call. */
export async function settled(api: AgentApi, correlationId: string, timeoutMs = 3 * 60_000, now: () => number = Date.now): Promise<StatusResponse> {
  const start = now();
  for (;;) {
    const s = await api.getStatus(correlationId, { waitMs: 30_000 });
    if (TERMINAL.has(s.status) || s.status === "PENDING_SIGNATURE") return s;
    if (now() - start > timeoutMs) throw new Error(`${correlationId} is still ${s.status}`);
  }
}

/** The owner actions the backend prepares for the passkey to sign (the API's `generateIntent`). */
export const ownerIntents = {
  create: (api: AgentApi, account: string, owner: OwnerWallet, policy: Policy) => api.generateIntent({ type: "agent_create", name: "Tredio Autopilot", external_user_id: account, owner, policy }),
  grant: (api: AgentApi, agentId: string, commitment: string, expiresAt: Date) => api.generateIntent({ type: "grant_issue", agent_id: agentId, label: "Tredio Autopilot executor", credential: commitment, expires_at: expiresAt.toISOString() }),
  freeze: (api: AgentApi, agentId: string) => api.generateIntent({ type: "agent_freeze", agent_id: agentId }),
  unfreeze: (api: AgentApi, agentId: string) => api.generateIntent({ type: "agent_unfreeze", agent_id: agentId }),
};

/** What the browser hands back after the passkey signed a generated intent: the WebAuthn credential as JSON. */
export interface PasskeyCredential {
  id: string;
  rawId: string;
  type: "public-key";
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string };
  clientExtensionResults: Record<string, unknown>;
  authenticatorAttachment?: "platform" | "cross-platform";
}

/** Submits the passkey's assertion for a generated owner intent and waits for its outcome. */
export async function submitOwnerIntent(api: AgentApi, generated: Pick<GenerateIntentResponse, "type" | "correlation_id" | "intent">, credential: PasskeyCredential): Promise<StatusResponse> {
  if (generated.intent.standard !== "webauthn") throw new Error(`the account's passkey signs WebAuthn intents, not ${generated.intent.standard}`);
  await api.submitIntent({ type: generated.type, correlation_id: generated.correlation_id, signed_data: { standard: "webauthn", payload: generated.intent.payload, credential } });
  const status = await settled(api, generated.correlation_id);
  if (status.status !== "SUCCESS") throw new Error(`${generated.type} ended ${status.status}${status.failure_code ? `: ${status.failure_code}` : ""}`);
  return status;
}

export interface AgentApiSignerOptions {
  api: AgentApi;
  agentId: string;
  /** The executor's grant token (`ngt_...`). */
  grantToken: string;
  /** The agent's NEAR account (`wallet.near_account_id`): an implicit account. */
  accountId: string;
  /** The account Autopilot trades for, and its passkey as the API names an owner (`passkeySpki` of the account's `owner_key`). */
  owner: { account: string; spki: () => Promise<string> };
  readValue: ReadValue;
  timeoutMs?: number;
}

/** Autopilot's session calls through an Agent API agent (mainnet): a native NEAR call under the executor's grant. */
export class AgentApiSigner implements WalletSigner {
  readonly kind = "agent-api" as const;
  readonly accountId: string;
  readonly sessionKey: string;
  private readonly api: AgentApi;
  private readonly granted: AgentApi;

  constructor(private readonly o: AgentApiSignerOptions) {
    this.api = o.api;
    this.accountId = o.accountId;
    this.sessionKey = nearKeyOf(o.accountId);
    this.granted = o.api.forGrant(o.grantToken);
  }

  get agentId(): string {
    return this.o.agentId;
  }

  async sessionCall(owner: string, action: unknown, tgas: number): Promise<SessionCallResult> {
    const sent: IdempotentResult<StatusResponse> = await this.granted.nativeNearCall(this.agentId, {
      receiver_id: owner,
      method_name: "session_call",
      args: { action },
      gas: (BigInt(tgas) * 10n ** 12n).toString(),
      deposit: "0",
    });
    const s = TERMINAL.has(sent.status) ? sent : await settled(this.api, sent.correlation_id, this.o.timeoutMs ?? 3 * 60_000);
    const details = (s as { details?: { tx_hash?: string | null; failure_reason?: string | null } }).details;
    if (s.status !== "SUCCESS") throw new Error(`the agent's call ended ${s.status}${details?.failure_reason ? `: ${details.failure_reason}` : s.failure_code ? `: ${s.failure_code}` : ""}`);
    if (!details?.tx_hash) throw new Error("the Agent API reported no transaction for the call");
    return { hash: details.tx_hash, value: await this.o.readValue(details.tx_hash, this.accountId) };
  }

  /** Frozen unless the applied policy says otherwise; controlled by the account only while the agent's owner is the account's passkey. */
  async state(): Promise<WalletState> {
    const [agent, policy, spki] = await Promise.all([this.api.getAgent(this.o.agentId), this.api.getPolicy(this.o.agentId), this.o.owner.spki()]);
    const owned = agent.owner?.type === "passkey" && agent.owner.public_key === spki;
    return { frozen: policy.policy?.frozen ?? true, controller: owned ? this.o.owner.account : null };
  }

  async policyProblem(owner: string): Promise<string | null> {
    return agentPolicyProblem((await this.api.getPolicy(this.o.agentId)).policy, owner);
  }
}
