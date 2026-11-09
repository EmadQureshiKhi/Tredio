import type { Viewer } from "@tredio/chain";

/**
 * USDC transfers read back from a transaction, for the two payments signals rest on: the leader's
 * commitment (a micro-USDC transfer to the treasury whose memo carries the signal's hash) and a
 * viewing key purchase (a transfer to the leader's account). The proof is the NEP-141 `ft_transfer`
 * event the USDC contract itself logged, so it holds however the transaction was sent: from a
 * wallet, or through the relayer for a passkey account (where the signer is the relayer).
 */

export interface UsdcTransfer {
  from: string;
  to: string;
  amount: bigint;
  memo: string | null;
  /** Block time of the receipt that moved it, unix seconds. */
  at: number;
}

interface Outcome {
  status: Record<string, unknown>;
  receipts_outcome: Array<{ block_hash: string; outcome: { logs: string[]; executor_id: string; status: Record<string, unknown> } }>;
}

const succeeded = (s: Record<string, unknown>) => "SuccessValue" in s || "SuccessReceiptId" in s;

/** The USDC transfers `tx` (sent by `sender`) made, in receipt order; none when it failed. */
export async function usdcTransfers(viewer: Pick<Viewer, "rpc">, usdc: string, tx: string, sender: string): Promise<UsdcTransfer[]> {
  const o = await viewer.rpc<Outcome>("EXPERIMENTAL_tx_status", { tx_hash: tx, sender_account_id: sender, wait_until: "EXECUTED_OPTIMISTIC" });
  if (!succeeded(o.status)) return [];
  const out: UsdcTransfer[] = [];
  const times = new Map<string, number>();
  for (const r of o.receipts_outcome) {
    if (r.outcome.executor_id !== usdc || !succeeded(r.outcome.status)) continue;
    for (const line of r.outcome.logs) {
      if (!line.startsWith("EVENT_JSON:")) continue;
      let e: { standard?: string; event?: string; data?: Array<{ old_owner_id?: string; new_owner_id?: string; amount?: string; memo?: string | null }> };
      try {
        e = JSON.parse(line.slice("EVENT_JSON:".length));
      } catch {
        continue;
      }
      if (e.standard !== "nep141" || e.event !== "ft_transfer" || !Array.isArray(e.data)) continue;
      if (!times.has(r.block_hash)) {
        const b = await viewer.rpc<{ header: { timestamp_nanosec: string } }>("block", { block_id: r.block_hash });
        times.set(r.block_hash, Number(BigInt(b.header.timestamp_nanosec) / 1_000_000_000n));
      }
      for (const d of e.data) {
        if (!d.old_owner_id || !d.new_owner_id || !d.amount || !/^\d+$/.test(d.amount)) continue;
        out.push({ from: d.old_owner_id, to: d.new_owner_id, amount: BigInt(d.amount), memo: d.memo ?? null, at: times.get(r.block_hash)! });
      }
    }
  }
  return out;
}

/** The first transfer that pays at least `min` from `from` to `to` with exactly `memo`, or null. */
export const findTransfer = (transfers: readonly UsdcTransfer[], m: { from: string; to: string; min: bigint; memo: string }) =>
  transfers.find((t) => t.from === m.from && t.to === m.to && t.amount >= m.min && t.memo === m.memo) ?? null;
