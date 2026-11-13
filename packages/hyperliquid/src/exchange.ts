import type { L1Action } from "./actions";
import { API_URL, type HlNetwork } from "./info";
import { type UserSignedAction, userSignedNonce } from "./transfers";

/** An EVM signature as the account contract returns it from Chain Signatures (r and s hex, no 0x). */
export interface EvmSignature {
  r: string;
  s: string;
  v: number;
}

export type ExchangeResponse =
  | { status: "ok"; response: { type: string; data?: { statuses?: Array<Record<string, unknown>> } } }
  | { status: "err"; response: string };

/** What /exchange takes: the action, its nonce, and the signature with 0x-prefixed 32-byte r and s. */
export interface ExchangeBody {
  action: L1Action | UserSignedAction;
  nonce: number;
  signature: { r: string; s: string; v: number };
  vaultAddress: null;
}

const word = (hex: string) => `0x${hex.replace(/^0x/, "").padStart(64, "0")}`;

/** The /exchange body for a signed action. */
export function exchangeBody(action: L1Action | UserSignedAction, nonce: number, sig: EvmSignature): ExchangeBody {
  return { action, nonce, signature: { r: word(sig.r), s: word(sig.s), v: sig.v }, vaultAddress: null };
}

/** The same for a withdrawal or USDC send, whose nonce is its own `time`. */
export const userSignedBody = (action: UserSignedAction, sig: EvmSignature): ExchangeBody => exchangeBody(action, userSignedNonce(action), sig);

async function post(network: HlNetwork, body: ExchangeBody, fetchImpl: typeof fetch): Promise<ExchangeResponse> {
  const res = await fetchImpl(`${API_URL[network]}/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Hyperliquid exchange: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as ExchangeResponse;
}

/**
 * Posts a signed L1 action to Hyperliquid. The signature comes from the account contract (the
 * account's own Chain Signatures key), so whoever relays it cannot change the action.
 */
export function postAction(network: HlNetwork, action: L1Action, nonce: number, sig: EvmSignature, fetchImpl: typeof fetch = fetch): Promise<ExchangeResponse> {
  return post(network, exchangeBody(action, nonce, sig), fetchImpl);
}

/** Posts a signed withdrawal or USDC send (transfers.ts) to Hyperliquid. */
export function postUserSigned(network: HlNetwork, action: UserSignedAction, sig: EvmSignature, fetchImpl: typeof fetch = fetch): Promise<ExchangeResponse> {
  return post(network, userSignedBody(action, sig), fetchImpl);
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

/** Whether Hyperliquid took a withdrawal or send (`{ status: "ok", response: { type: "default" } }`), or its error text. */
export function transferOutcome(r: ExchangeResponse): { ok: true } | { ok: false; error: string } {
  return r.status === "ok" ? { ok: true } : { ok: false, error: r.response };
}
