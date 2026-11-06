import type { EvmSignature, SessionAction } from "@tredio/contracts";
import { formatPrice, formatSize, type HlOrder, leverageAction, orderAction, orderOutcome, postAction } from "@tredio/hyperliquid";
import type { TxResult } from "@/lib/account/service";
import { TxFailed } from "@/lib/chain/outcome";
import { HL_NETWORK } from "@/lib/config";
import { session } from "./calls";

/**
 * Hyperliquid orders from a passkey account: the session asks the account to sign the action
 * (its contract checks the order against the oracle's mark and asks NEAR Chain Signatures to sign
 * for the account's derived address); the transaction returns the signature, and the very same
 * action then goes to Hyperliquid.
 */

export type HlTrade = (action: SessionAction) => Promise<TxResult<EvmSignature>>;

/** How far past the market an immediate order may fill, well inside the account's 2% band. */
export const HL_SLIPPAGE = 0.01;

function signatureOf(sent: TxResult<EvmSignature>): EvmSignature {
  const sig = sent.value;
  if (!sig || typeof sig !== "object" || typeof sig.r !== "string" || typeof sig.s !== "string") throw new TxFailed("the account did not return a signature", sent.hash);
  return sig;
}

/** Signs `order` through the session and posts it to Hyperliquid. */
export async function signOrder(trade: HlTrade, order: HlOrder) {
  const nonce = Date.now();
  const sent = await trade(session.hlOrder(order, nonce));
  return { sent, answer: await postAction(HL_NETWORK, orderAction(order), nonce, signatureOf(sent)) };
}

/** The same for a leverage change (the account allows up to 10x). */
export async function signLeverage(trade: HlTrade, assetIndex: number, isCross: boolean, leverage: number) {
  const nonce = Date.now();
  const sent = await trade(session.hlLeverage(assetIndex, isCross, leverage, nonce));
  return { sent, answer: await postAction(HL_NETWORK, leverageAction(assetIndex, isCross, leverage), nonce, signatureOf(sent)) };
}

/** Closes a position with an immediate reduce-only order a little through the market; resolves the exchange's refusal, if any. */
export async function closePosition(trade: HlTrade, p: { asset: string; assetIndex: number; szDecimals: number; size: number; long: boolean; reference: number }): Promise<{ sent: TxResult<EvmSignature>; refused: string | null }> {
  const order: HlOrder = {
    asset: p.asset,
    asset_index: p.assetIndex,
    is_buy: !p.long,
    price: formatPrice(p.reference * (p.long ? 1 - HL_SLIPPAGE : 1 + HL_SLIPPAGE), p.szDecimals, p.long ? "up" : "down"),
    size: formatSize(p.size, p.szDecimals),
    reduce_only: true,
    tif: "Ioc",
  };
  const o = await signOrder(trade, order);
  const out = orderOutcome(o.answer);
  return { sent: o.sent, refused: out.ok ? null : out.error };
}
