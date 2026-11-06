import { isTransient, type Sender, TxError, type Viewer } from "@tredio/chain";
import { parseEvents } from "@tredio/contracts";
import { decodeSignedDelegateAction, type FinalExecutionOutcome } from "near-kit";
import type { AccessKeyKind, NearSnapshot, NearState } from "./scheme";

/**
 * The chain side of x402 payments: `NearState` reads, pinned to a final block, through the API's
 * RPC failover, and settlement, where the relayer wraps the payer's signed delegate action in its
 * own transaction and waits for every receipt to finish.
 */

const UNKNOWN = /UNKNOWN_ACCOUNT|UNKNOWN_ACCESS_KEY|does not exist/i;

export class NearReads implements NearState {
  constructor(private readonly viewer: Viewer) {}

  async final(): Promise<NearSnapshot> {
    const b = await this.viewer.rpc<{ header: { height: number; hash: string } }>("block", { finality: "final" });
    return new PinnedReads(this.viewer, BigInt(b.header.height), b.header.hash);
  }
}

/** Every read at one block (by hash), as the spec asks, so no check sees a different state. */
class PinnedReads implements NearSnapshot {
  constructor(
    private readonly viewer: Viewer,
    readonly height: bigint,
    private readonly blockHash: string,
  ) {}

  private query<T>(params: Record<string, unknown>): Promise<T> {
    return this.viewer.rpc<T>("query", { ...params, block_id: this.blockHash });
  }

  async accessKey(accountId: string, publicKey: string): Promise<{ nonce: bigint; kind: AccessKeyKind } | null> {
    try {
      const k = await this.query<{ nonce: number | string; permission: unknown }>({ request_type: "view_access_key", account_id: accountId, public_key: publicKey });
      const p = k.permission;
      const kind: AccessKeyKind = p === "FullAccess" ? "FullAccess" : typeof p === "object" && p !== null && "FunctionCall" in p ? "FunctionCall" : "Unknown";
      return { nonce: BigInt(String(k.nonce)), kind };
    } catch (e) {
      if (UNKNOWN.test(String((e as Error).message))) return null;
      throw e;
    }
  }

  async account(accountId: string): Promise<{ codeHash: string } | null> {
    try {
      const a = await this.query<{ code_hash: string }>({ request_type: "view_account", account_id: accountId });
      return { codeHash: a.code_hash };
    } catch (e) {
      if (UNKNOWN.test(String((e as Error).message))) return null;
      throw e;
    }
  }

  private async call<T>(contract: string, method: string, args: object): Promise<T> {
    const r = await this.query<{ result: number[] }>({ request_type: "call_function", account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
    return JSON.parse(Buffer.from(r.result).toString("utf8")) as T;
  }

  async ftBalance(token: string, accountId: string): Promise<bigint> {
    const v = await this.call<unknown>(token, "ft_balance_of", { account_id: accountId });
    if (typeof v !== "string" || !/^\d+$/.test(v)) throw new Error("ft_balance_of did not answer a U128");
    return BigInt(v);
  }

  async storageBalance(token: string, accountId: string): Promise<{ supported: boolean; registered: boolean }> {
    try {
      const v = await this.call<unknown>(token, "storage_balance_of", { account_id: accountId });
      if (v !== null && (typeof v !== "object" || typeof (v as { total?: unknown }).total !== "string")) throw new Error("storage_balance_of did not answer a balance");
      return { supported: true, registered: v !== null };
    } catch (e) {
      // A token without NEP-145 has no such method; anything else is a failed read.
      if (/MethodNotFound|MethodResolveError/i.test(String((e as Error).message))) return { supported: false, registered: false };
      throw e;
    }
  }
}

export type Settlement =
  | { status: "settled"; transaction: string }
  /** The transaction ran and the transfer did not happen. */
  | { status: "failed"; transaction: string; error: string }
  /** Broadcast, but its outcome could not be learned: it may still land. */
  | { status: "pending"; transaction: string; error: string };

export interface Settler {
  readonly relayers: readonly string[];
  settle(signedDelegateAction: string, expect: { asset: string; payTo: string; amount: string; payer: string }): Promise<Settlement>;
}

/** Whether the outcome holds a successful `ft_transfer` of exactly `amount` from payer to payTo. */
export function transferred(o: FinalExecutionOutcome, expect: { asset: string; payTo: string; amount: string; payer: string }): boolean {
  return (o.receipts_outcome ?? []).some((r) => {
    const status = r.outcome.status as { SuccessValue?: string } | string;
    if (r.outcome.executor_id !== expect.asset || typeof status !== "object" || !("SuccessValue" in status)) return false;
    return parseEvents(r.outcome.logs).some(
      (e) =>
        e.standard === "nep141" &&
        e.event === "ft_transfer" &&
        Array.isArray(e.data) &&
        (e.data as Array<{ old_owner_id?: string; new_owner_id?: string; amount?: string }>).some((t) => t.old_owner_id === expect.payer && t.new_owner_id === expect.payTo && t.amount === expect.amount),
    );
  });
}

/** Settles through one relayer account; its key sends one transaction at a time (or one per gas-key lane). */
export class RelayerSettler implements Settler {
  constructor(private readonly relayer: Sender) {}

  get relayers(): readonly string[] {
    return [this.relayer.accountId];
  }

  async settle(signedDelegateAction: string, expect: { asset: string; payTo: string; amount: string; payer: string }): Promise<Settlement> {
    const delegate = decodeSignedDelegateAction(signedDelegateAction);
    try {
      // FINAL: the outcome is known for every receipt, the inner ft_transfer included.
      const o = await this.relayer.sendTx((tx) => tx.signedDelegateAction(delegate), "FINAL");
      const hash = o.transaction?.hash ?? o.transaction_outcome?.id ?? "";
      return transferred(o, expect) ? { status: "settled", transaction: hash } : { status: "failed", transaction: hash, error: "the transaction holds no matching ft_transfer" };
    } catch (e) {
      const hash = e instanceof TxError ? (e.hash ?? "") : "";
      const message = String((e as Error).message ?? e).slice(0, 500);
      // A transient error after the broadcast leaves the outcome unknown; anything else ran and failed.
      if (hash && isTransient(e)) return { status: "pending", transaction: hash, error: message };
      return { status: "failed", transaction: hash, error: message };
    }
  }
}
