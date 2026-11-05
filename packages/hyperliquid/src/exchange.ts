import type { L1Action } from "./actions";
import { API_URL, type HlNetwork } from "./info";

/** An EVM signature as the account contract returns it from Chain Signatures (r and s hex, no 0x). */
export interface EvmSignature {
  r: string;
  s: string;
  v: number;
}

export type ExchangeResponse =
  | { status: "ok"; response: { type: string; data?: { statuses?: Array<Record<string, unknown>> } } }
  | { status: "err"; response: string };

/**
 * Posts a signed L1 action to Hyperliquid. The signature comes from the account contract (the
 * account's own Chain Signatures key), so whoever relays it cannot change the action.
 */
export async function postAction(network: HlNetwork, action: L1Action, nonce: number, sig: EvmSignature, fetchImpl: typeof fetch = fetch): Promise<ExchangeResponse> {
  const signature = { r: `0x${sig.r.replace(/^0x/, "").padStart(64, "0")}`, s: `0x${sig.s.replace(/^0x/, "").padStart(64, "0")}`, v: sig.v };
  const res = await fetchImpl(`${API_URL[network]}/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, nonce, signature, vaultAddress: null }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Hyperliquid exchange: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as ExchangeResponse;
}

/** The first order status of an order response: resting, filled, or the exchange's error text. */
export function orderOutcome(r: ExchangeResponse): { ok: true; oid: number | null; filled: { totalSz: number; avgPx: number } | null } | { ok: false; error: string } {
  if (r.status === "err") return { ok: false, error: r.response };
  const s = r.response.data?.statuses?.[0];
  if (!s) return { ok: true, oid: null, filled: null };
  if (typeof s.error === "string") return { ok: false, error: s.error };
  const filled = s.filled as { totalSz: string; avgPx: string; oid: number } | undefined;
  const resting = s.resting as { oid: number } | undefined;
  return { ok: true, oid: filled?.oid ?? resting?.oid ?? null, filled: filled ? { totalSz: Number(filled.totalSz), avgPx: Number(filled.avgPx) } : null };
}
