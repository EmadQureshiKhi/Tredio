/**
 * Autopilot's policy wallet on OutLayer custody, from the account's side.
 *
 * Two independent limits stand between Autopilot and an account. The account contract's session
 * (Hyperliquid scope only, an expiry, a daily USDC cap, the 2% price guard, at most 10x) checks
 * every action on chain. The wallet's enclave signs only `session_call`s to the account itself,
 * attaching no NEAR, at most so many an hour, never while the account has frozen it. The account
 * owns both: its passkey adds and revokes the session, stores the wallet's policy (which makes the
 * account its only controller) and flips the freeze, each with an owner request.
 *
 * The session is added for the wallet's own key (`gas_key: false`). The enclave signs only as the
 * wallet's implicit account, so that key never signs for the account itself; the account code
 * must accept a `session_call` sent directly by the implicit account of one of its session keys.
 */
import { custodyKeyOf, nearKeyOf } from "./keys";
import type { PolicyCapabilities, PolicyRules, SignedPolicy, WalletCall, WalletPolicyView } from "./outlayer";

/** The session label the executor trades through (the same as a sealed-key grant's). */
export const AUTOPILOT_LABEL = "autopilot";
/** Calls an hour the enclave signs for Autopilot by default: an order and a leverage change a minute, with room. */
export const DEFAULT_CALLS_PER_HOUR = 120;
/**
 * NEAR the account moves into a new wallet for gas: 0.2. OutLayer sends a call only while the wallet
 * holds the gas it attaches at 1e9 yocto a gas unit (0.15 NEAR for a 150 Tgas `session_call`);
 * unused gas comes back, and each call burns a few thousandths.
 */
export const DEFAULT_GAS_FUNDING = 2n * 10n ** 23n;
/** Above the storage deposit `estimate_wallet_policy_cost` names, so a policy a few bytes longer still fits; the contract refunds the rest. */
export const POLICY_DEPOSIT_MARGIN = 10n ** 21n;

const TGAS = 10n ** 12n;

export interface AutopilotPolicyOptions {
  /** The account Autopilot trades for: the only receiver the enclave signs for. */
  account: string;
  /** Calls an hour, at most. */
  callsPerHour?: number;
  /** UTC hours (inclusive) the enclave signs in; every hour when unset. */
  hours?: [number, number];
}

/**
 * The rules: contract calls only, to the account alone, with no NEAR attached (per call and per
 * day), at most `callsPerHour` an hour. The wallet's NEAR then only ever pays gas for Autopilot's
 * session calls; it cannot be sent anywhere, and no other contract can be called.
 */
export function autopilotRules(o: AutopilotPolicyOptions): PolicyRules {
  return {
    transaction_types: ["call"],
    allowed_tokens: ["native"],
    addresses: { mode: "whitelist", list: [o.account] },
    limits: { per_transaction: { native: "0" }, daily: { native: "0" } },
    rate_limit: { max_per_hour: o.callsPerHour ?? DEFAULT_CALLS_PER_HOUR },
    ...(o.hours ? { time_restrictions: { timezone: "UTC" as const, allowed_hours: o.hours } } : {}),
  };
}

/** Message signing is open by default under a policy; Autopilot's wallet signs no messages (a NEP-413 signature could sign in as its key). */
export const AUTOPILOT_CAPABILITIES: PolicyCapabilities = { sign_message: { allowed: false } };

/**
 * Why a wallet's policy, as its enclave reads it, is not Autopilot's for `account`, or null: it must
 * allow nothing beyond calls to the account without NEAR. Who controls the policy is the chain's to
 * say (`get_wallet_policy`'s owner; this view's `controller` names the wallet's own key).
 */
export function walletPolicyProblem(p: WalletPolicyView, account: string): string | null {
  if (p.policy === "none") return "the wallet has no policy stored, so its enclave would sign anything";
  if (p.policy !== "stored" || !p.rules) return "OutLayer could not read the wallet's policy just now";
  const r = p.rules;
  if (r.transaction_types?.length !== 1 || r.transaction_types[0] !== "call") return "the policy allows more than contract calls";
  if (r.addresses?.mode !== "whitelist" || r.addresses.list.length === 0 || r.addresses.list.some((a) => a !== account)) return "the policy lets the wallet call contracts other than the account";
  if (r.limits?.per_transaction?.native !== "0") return "the policy lets the wallet attach NEAR to a call";
  if (p.capabilities?.sign_message?.allowed !== false) return "the policy lets the wallet sign messages";
  if (p.capabilities?.raw_sign?.allowed || p.capabilities?.intents_call?.allowed || p.capabilities?.swap?.allowed) return "the policy opens signing beyond contract calls";
  return null;
}

/** `store_wallet_policy`, sent by the owner: the first account to store a wallet's policy becomes its only controller. */
export function storePolicyCall(contract: string, walletAccount: string, encrypted: string, signed: SignedPolicy, deposit: bigint): WalletCall {
  return {
    receiverId: contract,
    methodName: "store_wallet_policy",
    args: { wallet_pubkey: custodyKeyOf(walletAccount), encrypted_data: encrypted, wallet_signature: signed.signatureHex, version: signed.version, locked: signed.locked, valid_until: signed.validUntil },
    gas: (50n * TGAS).toString(),
    deposit: deposit.toString(),
  };
}

/** The owner freezes the wallet: the enclave refuses every signature until it is unfrozen. No wallet signature is needed, so it works with a stolen API key too. */
export const freezeCall = (contract: string, walletAccount: string): WalletCall => ({ receiverId: contract, methodName: "freeze_wallet", args: { wallet_pubkey: custodyKeyOf(walletAccount) }, gas: (30n * TGAS).toString(), deposit: "0" });
export const unfreezeCall = (contract: string, walletAccount: string): WalletCall => ({ receiverId: contract, methodName: "unfreeze_wallet", args: { wallet_pubkey: custodyKeyOf(walletAccount) }, gas: (30n * TGAS).toString(), deposit: "0" });

/** The owner actions this package builds, in the account contract's JSON (`call` args as base64 of the JSON). */
export type CustodyOwnerAction =
  | { call: { receiver_id: string; method_name: string; args: string; deposit: string; gas: string } }
  | { transfer: { receiver_id: string; amount: string } }
  | {
      add_session: {
        public_key: string;
        label: string;
        scope: { outcomes: boolean; perps: boolean; hyperliquid: boolean };
        expires_at: number;
        daily_limit: string;
        gas_key: boolean;
        gas_funding: string;
      };
    };

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** A call the account makes through its passkey (an owner request's `call` action). */
export const ownerCall = (c: WalletCall): CustodyOwnerAction => ({ call: { receiver_id: c.receiverId, method_name: c.methodName, args: base64(JSON.stringify(c.args)), deposit: c.deposit, gas: c.gas } });

export interface WalletSessionTerms {
  walletAccount: string;
  /** Unix seconds; the account contract allows at most 30 days ahead. */
  expiresAt: number;
  /** USDC (6 decimals) the session may move out per UTC day. */
  dailyLimit: bigint;
}

/** Autopilot's session for the wallet's key: Hyperliquid only, a plain key (the wallet pays its own gas), never a gas key. */
export const walletSession = (t: WalletSessionTerms): CustodyOwnerAction => ({
  add_session: {
    public_key: nearKeyOf(t.walletAccount),
    label: AUTOPILOT_LABEL,
    scope: { outcomes: false, perps: false, hyperliquid: true },
    expires_at: t.expiresAt,
    daily_limit: t.dailyLimit.toString(),
    gas_key: false,
    gas_funding: "0",
  },
});

export interface WalletSetup extends WalletSessionTerms {
  /** OutLayer's contract (`external.outlayer` in the deployment). */
  contract: string;
  encrypted: string;
  signed: SignedPolicy;
  /** `estimate_wallet_policy_cost` for `encrypted`. */
  policyCost: bigint;
  /** NEAR (yoctoNEAR) the account sends the wallet for gas; nothing when 0. */
  gasFunding: bigint;
}

/**
 * Everything one passkey prompt does to put Autopilot on a policy wallet: store the policy (the
 * account becomes its controller), fund the wallet's gas, and add Autopilot's session for the
 * wallet's key. The actions run independently, so a failed store leaves a session the executor
 * refuses to use until the account controls the wallet's policy.
 */
export function walletSetupActions(s: WalletSetup): CustodyOwnerAction[] {
  return [
    ownerCall(storePolicyCall(s.contract, s.walletAccount, s.encrypted, s.signed, s.policyCost + POLICY_DEPOSIT_MARGIN)),
    ...(s.gasFunding > 0n ? [{ transfer: { receiver_id: s.walletAccount, amount: s.gasFunding.toString() } }] : []),
    walletSession(s),
  ];
}
