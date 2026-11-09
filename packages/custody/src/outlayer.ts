/**
 * OutLayer custody: a NEAR key made and kept in OutLayer's enclave (Intel TDX), which signs only
 * what its owner's policy allows. The holder of the wallet's API key (`wk_...`) asks for a call; the
 * enclave checks the policy, then signs and sends it from the wallet's own implicit account, which
 * pays the gas. That is the only NEAR account it signs for: OutLayer's keystore builds every
 * transaction with the implicit account as the signer.
 *
 * The owner's side lives on chain at `outlayer.<network>`: the policy, encrypted to the enclave,
 * is stored with `store_wallet_policy` by the account that becomes its only controller, and that
 * account alone can `freeze_wallet` (no wallet signature needed) and `unfreeze_wallet`. The enclave
 * reads the freeze on every signature.
 *
 * What the enclave checks for a contract call: the wallet is not frozen, `call` is an allowed type,
 * the receiver is on the allowlist, and the NEAR attached is within the per-call cap. With usage
 * counts the coordinator (outside the enclave) supplies, it also applies the hourly, daily and
 * monthly NEAR caps and the calls-per-hour limit. It does not decode a call's arguments, so token
 * amounts inside a call are not its business: for Autopilot the account contract's session does that.
 */

export type CustodyNetwork = "testnet" | "mainnet";

/** OutLayer's HTTPS API per network. */
export const CUSTODY_API: Record<CustodyNetwork, string> = { testnet: "https://testnet-api.outlayer.ai", mainnet: "https://api.outlayer.ai" };
/** OutLayer's contract per network, where policies are stored and frozen (the oracle's runs go through the same contract). */
export const CUSTODY_CONTRACT: Record<CustodyNetwork, string> = { testnet: "outlayer.testnet", mainnet: "outlayer.near" };

/** The rules OutLayer's policy engine evaluates; amounts are in the token's smallest unit (`native`: yoctoNEAR). */
export interface PolicyRules {
  transaction_types?: ("call" | "transfer" | "withdraw" | "cross_chain_withdraw" | "limit_order" | "deposit" | "swap" | "confidential")[];
  allowed_tokens?: string[];
  addresses?: { mode: "whitelist" | "blacklist" | "none"; list: string[] };
  limits?: { per_transaction?: Record<string, string>; hourly?: Record<string, string>; daily?: Record<string, string>; monthly?: Record<string, string> };
  rate_limit?: { max_per_hour: number };
  time_restrictions?: { timezone: "UTC"; allowed_hours?: [number, number]; allowed_days?: number[] };
}

/** Opt-ins for the primitives outside plain calls; every one is denied under a policy except `sign_message`, which must be closed explicitly. */
export interface PolicyCapabilities {
  sign_message?: { allowed: boolean; allowed_recipients?: string[] };
  raw_sign?: { allowed: boolean };
  swap?: { allowed: boolean };
  intents_call?: { allowed: boolean };
}

/** The wallet's policy as its own API key reads it (decrypted by the enclave), with usage counters. */
export interface WalletPolicyView {
  wallet_id: string;
  /** OutLayer's controller of the wallet (for an anonymous wallet, its own key); the policy's owner is `get_wallet_policy`'s `owner` on chain. */
  controller: string;
  frozen: boolean;
  version?: number;
  locked?: boolean;
  policy?: "none" | "stored";
  rules?: PolicyRules;
  capabilities?: PolicyCapabilities;
  usage?: Record<string, unknown>;
}

/** What `sign-policy` answers: the payload `store_wallet_policy` must be called with, exactly. */
export interface SignedPolicy {
  signatureHex: string;
  publicKeyHex: string;
  version: number;
  locked: boolean;
  /** Unix seconds after which the contract refuses this signature (seven days from signing). */
  validUntil: number;
  policyHash: string;
}

/**
 * The enclave or OutLayer said no before anything was signed: the policy (`policy_denied`), the
 * owner's freeze (`wallet_frozen`), another operation in flight (`wallet_busy`) or a rate limit.
 */
export class PolicyRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PolicyRefusal";
  }

  /** Another try may pass later with nothing changed (a busy wallet, a rate window, an outage). */
  get retryable(): boolean {
    return this.code === "wallet_busy" || this.code === "rate_limited" || this.code === "operation_limit_reached" || this.status >= 500;
  }
}

/** The enclave signed and sent the call and the chain ran it, but it failed there (`onchain_tx_failed`): the transaction is real. */
export class CustodyCallFailed extends Error {
  constructor(
    message: string,
    readonly txHash: string,
    readonly failure: unknown,
  ) {
    super(message);
    this.name = "CustodyCallFailed";
  }
}

/** One function call for the wallet to send; `gas` in gas units and `deposit` in yoctoNEAR, as decimal strings. */
export interface WalletCall {
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  gas: string;
  deposit: string;
}

export interface WalletCallResult {
  txHash: string;
  /** What OutLayer reports of the outcome; the call's return value when it includes one. */
  result: unknown;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: Fetch = (input, init) => fetch(input, init);

const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/** One policy wallet as its API key holder sees it. */
export class CustodyWallet {
  constructor(
    readonly apiKey: string,
    readonly api: string = CUSTODY_API.testnet,
    private readonly fetchImpl: Fetch = defaultFetch,
  ) {}

  /**
   * A new wallet with no policy. Until a policy is stored anyone holding the key may sign, and the
   * first account to store one controls it: store the owner's policy before the key goes anywhere.
   */
  static async register(api: string = CUSTODY_API.testnet, fetchImpl: Fetch = defaultFetch): Promise<{ wallet: CustodyWallet; walletId: string; accountId: string }> {
    const r = await fetchImpl(`${api}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(30_000) });
    const body = (await r.json().catch(() => ({}))) as { api_key?: string; wallet_id?: string; near_account_id?: string; message?: string; error?: string };
    if (!r.ok || !body.api_key || !body.wallet_id || !body.near_account_id) throw new Error(`OutLayer did not create a wallet: ${body.message ?? body.error ?? `HTTP ${r.status}`}`);
    return { wallet: new CustodyWallet(body.api_key, api, fetchImpl), walletId: body.wallet_id, accountId: body.near_account_id };
  }

  private async req<T>(path: string, init: { method?: string; body?: unknown; idempotent?: boolean } = {}): Promise<T> {
    const r = await this.fetchImpl(`${this.api}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", ...(init.idempotent ? { "x-idempotency-key": uuid() } : {}) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(90_000),
    });
    const text = await r.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = { message: text.slice(0, 200) };
    }
    const code = typeof body.error === "string" ? body.error : String(r.status);
    const message = typeof body.message === "string" ? body.message : code;
    if (r.status === 422 && typeof body.tx_hash === "string") throw new CustodyCallFailed(message, body.tx_hash, body.failure);
    if (r.status === 403 || r.status === 409 || r.status === 429) throw new PolicyRefusal(code, message, r.status);
    if (!r.ok) throw r.status >= 500 ? new PolicyRefusal(code, `OutLayer answered ${r.status}: ${message}`, r.status) : new Error(`OutLayer answered ${r.status}: ${message}`);
    return body as T;
  }

  /** The wallet's NEAR account (an implicit account, which signs and pays gas) and its key as OutLayer spells it. */
  async address(): Promise<{ walletId: string; accountId: string; custodyKey: string }> {
    const a = await this.req<{ wallet_id: string; address: string; public_key: string }>("/wallet/v1/address?chain=near");
    return { walletId: a.wallet_id, accountId: a.address, custodyKey: a.public_key };
  }

  policy(): Promise<WalletPolicyView> {
    return this.req("/wallet/v1/policy");
  }

  /** Asks the enclave to sign and send one function call from the wallet's account; it checks the policy first. */
  async call(c: WalletCall): Promise<WalletCallResult> {
    const r = await this.req<{ status: string; tx_hash: string | null; result: unknown; approval_id?: string | null }>("/wallet/v1/call", {
      method: "POST",
      idempotent: true,
      body: { receiver_id: c.receiverId, method_name: c.methodName, args: c.args, gas: c.gas, deposit: c.deposit },
    });
    if (r.status === "pending_approval") throw new PolicyRefusal("pending_approval", "the call waits for the policy's approvers", 202);
    if ((r.status !== "success" && r.status !== "completed") || !r.tx_hash) throw new Error(`the wallet's call ${c.receiverId}.${c.methodName} ended ${r.status}`);
    return { txHash: r.tx_hash, result: r.result };
  }

  /** Step 1 of storing a policy: the enclave encrypts the rules to itself. */
  async encryptPolicy(walletId: string, rules: PolicyRules, capabilities?: PolicyCapabilities): Promise<{ encrypted: string; policyHash: string }> {
    const r = await this.req<{ encrypted_base64: string; policy_hash: string }>("/wallet/v1/encrypt-policy", { method: "POST", body: { wallet_id: walletId, rules, ...(capabilities ? { capabilities } : {}) } });
    return { encrypted: r.encrypted_base64, policyHash: r.policy_hash };
  }

  /** Step 2: the enclave signs the encrypted policy for the one account that will store it (the owner). */
  async signPolicy(encrypted: string, owner: string): Promise<SignedPolicy> {
    const r = await this.req<{ signature_hex?: string; public_key_hex?: string; version?: number; locked?: boolean; valid_until?: number; policy_hash?: string; status?: string }>("/wallet/v1/sign-policy", {
      method: "POST",
      body: { encrypted_data: encrypted, caller: owner },
    });
    if (!r.signature_hex || !r.public_key_hex || r.version === undefined || r.valid_until === undefined) throw new Error(`OutLayer did not sign the policy (${r.status ?? "no signature"})`);
    return { signatureHex: r.signature_hex, publicKeyHex: r.public_key_hex, version: r.version, locked: r.locked ?? false, validUntil: r.valid_until, policyHash: r.policy_hash ?? "" };
  }

  /** Step 4, after the owner's transaction: the coordinator reads the new policy now instead of after its cache expires. */
  async refresh(walletId: string): Promise<void> {
    await this.req("/wallet/v1/invalidate-cache", { method: "POST", body: { wallet_id: walletId } });
  }
}

/** What anyone can read on chain about a policy wallet: its controller, the freeze and the version (the rules stay encrypted). */
export interface OnChainPolicy {
  owner: string;
  frozen: boolean;
  version: number;
  locked: boolean;
  updatedAtMs: number;
}

export type ViewFn = <T>(contractId: string, method: string, args: object) => Promise<T>;

/** `get_wallet_policy` on `outlayer.<network>`, or null when no policy is stored for the key. */
export async function onChainPolicy(view: ViewFn, contract: string, custodyKey: string): Promise<OnChainPolicy | null> {
  const v = await view<{ owner: string; frozen: boolean; updated_at: number; version?: number; locked?: boolean } | null>(contract, "get_wallet_policy", { wallet_pubkey: custodyKey });
  return v ? { owner: v.owner, frozen: v.frozen, version: v.version ?? 0, locked: v.locked ?? false, updatedAtMs: Math.floor(Number(v.updated_at) / 1e6) } : null;
}

/** The storage deposit (yoctoNEAR) `store_wallet_policy` needs for this encrypted policy. */
export async function policyCost(view: ViewFn, contract: string, custodyKey: string, encrypted: string): Promise<bigint> {
  return BigInt(await view<string>(contract, "estimate_wallet_policy_cost", { wallet_pubkey: custodyKey, encrypted_data: encrypted }));
}
