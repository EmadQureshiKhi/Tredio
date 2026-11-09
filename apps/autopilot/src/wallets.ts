import { returnValue, toNear, type Viewer } from "@tredio/chain";
import { type AccountVersions, type Session, type SessionAction, sessionCallTgas } from "@tredio/contracts";
import { CUSTODY_API, CUSTODY_CONTRACT, CustodyWallet, OutLayerSigner, type ReadValue, type WalletSigner } from "@tredio/custody";
import type { SessionChain, VenueWallet } from "./venue";

/**
 * Policy wallets on the executor's side. A grant can be backed by a wallet instead of a session key:
 * the account added Autopilot's session for the wallet's own key, and the executor holds only the
 * wallet's credential (an OutLayer API key on testnet, an Agent API grant token on mainnet), sealed
 * to it like a session key. Every session call is then signed in the custody enclave, which checks
 * the account's policy and freeze first; the account contract checks the session after it.
 */

export type WalletKind = "outlayer" | "agent-api";

/** A grant's policy wallet, as the backend recorded it for the grant's session key. */
export interface GrantWallet {
  kind: WalletKind;
  /** The wallet's NEAR account (implicit), whose key the session is for. */
  account: string;
  /** The Agent API agent (mainnet); null for OutLayer custody. */
  agentId: string | null;
}

/** A wallet's credential as the app seals it: an OutLayer API key or an Agent API grant token. */
export const credentialProblem = (kind: WalletKind, secret: string): string | null =>
  kind === "outlayer" ? (/^wk_[0-9a-f]{32,128}$/.test(secret) ? null : "the grant does not open to an OutLayer wallet key") : /^ngt_[A-Za-z0-9_-]{43}$/.test(secret) ? null : "the grant does not open to an Agent API grant token";

/** A transaction's return value, read by hash from the chain (for signers that report only the hash). */
export function txValue(viewer: Viewer): ReadValue {
  return async (hash, sender) => returnValue(await viewer.rpc<Parameters<typeof returnValue>[0]>("tx", { tx_hash: hash, sender_account_id: sender, wait_until: "EXECUTED_OPTIMISTIC" }));
}

/** An OutLayer custody signer for a grant's wallet (testnet). */
export function outLayerSigner(viewer: Viewer, network: "testnet" | "mainnet", account: string, apiKey: string, apiUrl?: string): WalletSigner {
  return new OutLayerSigner(new CustodyWallet(apiKey, apiUrl ?? CUSTODY_API[network]), account, {
    view: (contract, method, args) => viewer.view(contract, method, args),
    contract: CUSTODY_CONTRACT[network],
    readValue: txValue(viewer),
  });
}

/** NEAR for a policy wallet's venue: the account's views, and `session_call` through the wallet with the gas the account's code needs. */
export function walletSessionChain(viewer: Viewer, signer: WalletSigner, owner: string, versions: AccountVersions): SessionChain {
  return {
    session: (a, publicKey) => viewer.view<Session | null>(a, "session", { public_key: publicKey }),
    // The wallet pays its gas from its own account; there is no gas key to read.
    gasBalance: async () => null,
    version: (a) => versions.of(a),
    sessionCall: async (action: SessionAction) => signer.sessionCall(owner, action, sessionCallTgas(await versions.of(owner))),
  };
}

/** The last check of a wallet, for /health. */
export interface WalletCheck {
  owner: string;
  kind: WalletKind;
  account: string;
  frozen: boolean | null;
  /** NEAR the wallet holds for gas. */
  balance: string | null;
  /** Why it cannot sign now, or null. */
  problem: string | null;
  checkedAt: number;
}

export interface WalletGateOptions {
  /** The wallet's NEAR balance (yoctoNEAR), or null when it could not be read. */
  balance: (account: string) => Promise<bigint | null>;
  /** Below this the wallet waits for the account to fund it. */
  minBalance: bigint;
  /** Whether the account's code accepts session calls from the wallet's account (`acceptsWalletSessions` of its version). */
  accepts?: () => Promise<boolean>;
  ttlMs?: number;
  now?: () => number;
}

/**
 * The executor's own gate in front of a policy wallet, read at most every `ttlMs`: the wallet's
 * policy must be the account's and exactly Autopilot's, the account must not have frozen it, its
 * code must accept the wallet's calls, and the wallet must hold NEAR for gas. The enclave checks the
 * policy and the freeze itself on every signature, and the account contract the session; this gate
 * makes the executor wait instead of recording orders either would refuse.
 */
export class WalletGate implements VenueWallet {
  readonly kind: WalletKind;
  readonly account: string;
  last: WalletCheck | null = null;
  private pending: Promise<{ reason: string; pause: boolean } | null> | null = null;
  private result: { at: number; value: { reason: string; pause: boolean } | null } | null = null;
  private readonly now: () => number;

  constructor(
    private readonly signer: WalletSigner,
    readonly owner: string,
    private readonly o: WalletGateOptions,
  ) {
    this.kind = signer.kind;
    this.account = signer.accountId;
    this.now = o.now ?? Date.now;
  }

  check(): Promise<{ reason: string; pause: boolean } | null> {
    if (this.result && this.now() - this.result.at < (this.o.ttlMs ?? 15_000)) return Promise.resolve(this.result.value);
    this.pending ??= this.read().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** Forgets the last reading, so the next check reads the chain again (after a refusal). */
  forget(): void {
    this.result = null;
  }

  private async read(): Promise<{ reason: string; pause: boolean } | null> {
    let frozen: boolean | null = null;
    let balance: bigint | null = null;
    let value: { reason: string; pause: boolean } | null;
    try {
      const [state, held] = await Promise.all([this.signer.state(), this.o.balance(this.account).catch(() => null)]);
      frozen = state.frozen;
      balance = held;
      value =
        state.controller !== this.owner
          ? { reason: `the policy wallet's policy is controlled by ${state.controller ?? "no one"}, not the account; grant Autopilot again`, pause: true }
          : state.frozen
            ? { reason: "the account froze Autopilot's policy wallet, so its enclave signs nothing until the account unfreezes it", pause: false }
            : null;
      if (!value && this.o.accepts && !(await this.o.accepts())) {
        value = { reason: "the account's code takes session calls only from its own keys, so it would refuse the policy wallet's; Autopilot waits until the account runs code that accepts them", pause: false };
      }
      if (!value) {
        const wider = await this.signer.policyProblem(this.owner);
        if (wider) value = { reason: `the policy wallet is not Autopilot's: ${wider}`, pause: true };
      }
      if (!value && balance !== null && balance < this.o.minBalance) {
        value = { reason: `the policy wallet holds ${toNear(balance)} NEAR for gas, below ${toNear(this.o.minBalance)}; send it NEAR from the account`, pause: false };
      }
    } catch (e) {
      // An unreadable wallet waits: the enclave would refuse anyway if it were frozen.
      value = { reason: `could not check the policy wallet: ${e instanceof Error ? e.message : String(e)}`, pause: false };
    }
    const at = this.now();
    this.result = { at, value };
    this.last = { owner: this.owner, kind: this.kind, account: this.account, frozen, balance: balance === null ? null : toNear(balance), problem: value?.reason ?? null, checkedAt: Math.floor(at / 1000) };
    return value;
  }
}
