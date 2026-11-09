/**
 * What the Autopilot executor needs from a policy wallet: send `session_call(action)` to the
 * account it trades for, signed in the custody enclave, and say whether the account has frozen it.
 * OutLayer custody on testnet (`OutLayerSigner`) and the NEAR Intents Agent API on mainnet
 * (`AgentApiSigner` in `./agent-api`) both fit it.
 */
import { custodyKeyOf, nearKeyOf } from "./keys";
import { walletPolicyProblem } from "./autopilot";
import { type CustodyWallet, onChainPolicy, type ViewFn } from "./outlayer";

export interface SessionCallResult {
  hash: string;
  /** The session call's return value (an EVM signature for a Hyperliquid action). */
  value: unknown;
}

export interface WalletState {
  frozen: boolean;
  /** The account that controls the wallet's policy, or null when none is stored. */
  controller: string | null;
}

export interface WalletSigner {
  readonly kind: "outlayer" | "agent-api";
  /** The wallet's NEAR account: an implicit account, which sends every call and pays its gas. */
  readonly accountId: string;
  /** The wallet's key as NEAR spells it: the key Autopilot's session on the account is for. */
  readonly sessionKey: string;
  /** Asks the enclave to sign and send `session_call({ action })` to `owner` with `tgas` attached and no NEAR. */
  sessionCall(owner: string, action: unknown, tgas: number): Promise<SessionCallResult>;
  /** The freeze and the controller, as the enclave will see them on the next signature. */
  state(): Promise<WalletState>;
  /** Why the wallet's policy, as its enclave reads it, allows more than Autopilot's for `owner`, or null. */
  policyProblem(owner: string): Promise<string | null>;
}

/** Reads a transaction's return value by hash, for when the signing service reports only the hash. */
export type ReadValue = (txHash: string, sender: string) => Promise<unknown>;

/** A value OutLayer's call result carries, when it does: the decoded `SuccessValue`. */
export function valueFromResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  for (const k of ["return_value", "value", "result"]) if (k in r && r[k] !== null && r[k] !== undefined) return r[k];
  const success = (r.status as { SuccessValue?: unknown } | undefined)?.SuccessValue ?? r.SuccessValue;
  if (typeof success === "string" && success.length > 0) {
    try {
      const text = new TextDecoder().decode(Uint8Array.from(atob(success), (c) => c.charCodeAt(0)));
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Autopilot's session calls through an OutLayer custody wallet (testnet), with the freeze read on chain. */
export class OutLayerSigner implements WalletSigner {
  readonly kind = "outlayer" as const;
  readonly sessionKey: string;

  constructor(
    private readonly wallet: CustodyWallet,
    readonly accountId: string,
    private readonly chain: { view: ViewFn; contract: string; readValue: ReadValue },
  ) {
    this.sessionKey = nearKeyOf(accountId);
  }

  async sessionCall(owner: string, action: unknown, tgas: number): Promise<SessionCallResult> {
    const r = await this.wallet.call({ receiverId: owner, methodName: "session_call", args: { action }, gas: (BigInt(tgas) * 10n ** 12n).toString(), deposit: "0" });
    const value = valueFromResult(r.result) ?? (await this.chain.readValue(r.txHash, this.accountId));
    return { hash: r.txHash, value };
  }

  async state(): Promise<WalletState> {
    const p = await onChainPolicy(this.chain.view, this.chain.contract, custodyKeyOf(this.accountId));
    return { frozen: p?.frozen ?? false, controller: p?.owner ?? null };
  }

  async policyProblem(owner: string): Promise<string | null> {
    return walletPolicyProblem(await this.wallet.policy(), owner);
  }
}
