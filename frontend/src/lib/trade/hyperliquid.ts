import type { EvmSignature, OwnerAction, SessionAction } from "@tredio/contracts";
import {
  formatPrice,
  formatSize,
  HL_PATH,
  type HlOrder,
  isEvmAddress,
  leverageAction,
  orderAction,
  orderOutcome,
  postAction,
  postUserSigned,
  type UserSignedAction,
  userSignedDigestHex,
  WITHDRAW_FEE,
} from "@tredio/hyperliquid";
import type { TxResult } from "@/lib/account/service";
import { TxFailed } from "@/lib/chain/outcome";
import { HL_NETWORK } from "@/lib/config";
import { tokenAmount } from "@/lib/format";
import { ownerActions, session } from "./calls";

/**
 * Hyperliquid orders from a passkey account: the session asks the account to sign the action
 * (its contract checks the order against the oracle's mark and asks NEAR Chain Signatures to sign
 * for the account's derived address); the transaction returns the signature, and the very same
 * action then goes to Hyperliquid.
 *
 * Moving USDC out of Hyperliquid is an owner action instead: no session may sign a transfer, so
 * the passkey approves an `mpc_sign` of the transfer's EIP-712 digest and the relayer submits it.
 */

export type HlTrade = (action: SessionAction) => Promise<TxResult<EvmSignature>>;
export type OwnerExecute = (actions: OwnerAction[]) => Promise<TxResult>;

/** How far past the market an immediate order may fill, well inside the account's 2% band. */
export const HL_SLIPPAGE = 0.01;

function signatureOf(sent: TxResult<unknown>): EvmSignature {
  const sig = sent.value as Partial<EvmSignature> | undefined;
  if (!sig || typeof sig !== "object" || typeof sig.r !== "string" || typeof sig.s !== "string" || typeof sig.v !== "number") throw new TxFailed("the account did not return a signature", sent.hash);
  return { r: sig.r, s: sig.s, v: sig.v };
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

/** One passkey prompt: the account's Chain Signatures key signs the withdrawal or send, then it goes to Hyperliquid. */
export async function signTransfer(execute: OwnerExecute, action: UserSignedAction, fetchImpl: typeof fetch = fetch) {
  const sent = await execute([ownerActions.mpcSign(HL_PATH, userSignedDigestHex(action))]);
  return { sent, answer: await postUserSigned(HL_NETWORK, action, signatureOf(sent), fetchImpl) };
}

// --- Moving USDC out ----------------------------------------------------------------------------

/**
 * Where USDC can go from the account's Hyperliquid balance:
 * - `near`: back to the account on NEAR through NEAR Intents, the way it came in (mainnet only):
 *   a `usdSend` to a 1Click deposit address on Hyperliquid;
 * - `arbitrum`: a `withdraw3` through Hyperliquid's bridge to an address on Arbitrum (Arbitrum Sepolia on testnet);
 * - `hyperliquid`: a `usdSend` to another Hyperliquid address.
 */
export type HlRoute = "near" | "arbitrum" | "hyperliquid";

/**
 * NEAR Intents on a transfer from Hyperliquid (docs.near-intents.org, 1Click API, Hyperliquid;
 * mirrored in @tredio/intents): 0.2 USDC from every deposit (inside the quote), 1 USDC more from a
 * perps `usdSend` (outside it, so the account sends the quote's amount plus that), and at least
 * 0.5 USDC arriving.
 */
export const INTENTS_DEPOSIT_FEE = 200_000n;
export const INTENTS_USD_SEND_SURCHARGE = 1_000_000n;
export const INTENTS_MIN_DEPOSIT = 500_000n;

export interface TransferPlan {
  /** What leaves the Hyperliquid balance (raw USDC). */
  send: bigint;
  /** What the route keeps on the way. */
  fee: bigint;
  /** About what arrives, before any swap slippage. */
  receive: bigint;
}

/** What a route keeps of the amount (raw USDC). */
export const routeFee = (route: HlRoute): bigint => (route === "near" ? INTENTS_USD_SEND_SURCHARGE + INTENTS_DEPOSIT_FEE : route === "arbitrum" ? WITHDRAW_FEE : 0n);

/**
 * Checks a transfer before anything is signed: the amount (raw USDC, null while empty) against the
 * balance and the route's fee, and the destination off the `near` route. The plan is null until
 * both are complete and valid; each field has its own error.
 */
export function transferPlan(t: { route: HlRoute; amount: bigint | null; withdrawable: bigint | null; destination: string; own: string | null }): { plan: TransferPlan | null; amountError: string | null; destinationError: string | null } {
  const fee = routeFee(t.route);
  const amountError = (() => {
    if (t.amount === null) return null;
    if (t.amount <= 0n) return "Enter an amount";
    if (t.withdrawable !== null && t.amount > t.withdrawable) return `More than the ${tokenAmount(t.withdrawable, 6)} USDC free to withdraw`;
    if (t.route === "near" && t.amount < INTENTS_USD_SEND_SURCHARGE + INTENTS_MIN_DEPOSIT) return `At least ${tokenAmount(INTENTS_USD_SEND_SURCHARGE + INTENTS_MIN_DEPOSIT, 6)} USDC: NEAR Intents keeps ${tokenAmount(fee, 6)} USDC of a transfer from Hyperliquid`;
    if (t.route === "arbitrum" && t.amount <= fee) return `More than ${tokenAmount(fee, 6)} USDC: Hyperliquid's bridge keeps that much`;
    return null;
  })();
  const to = t.destination.trim();
  const destinationError =
    t.route === "near" || to === "" ? null : !isEvmAddress(to) ? "Enter a 0x address" : t.route === "hyperliquid" && t.own && to.toLowerCase() === t.own.toLowerCase() ? "That is this account's own Hyperliquid address" : null;
  const complete = t.amount !== null && (t.route === "near" || to !== "");
  return { plan: complete && !amountError && !destinationError ? { send: t.amount!, fee, receive: t.amount! - fee } : null, amountError, destinationError };
}

/** What the account sends by `usdSend` for a 1Click quote whose `amountIn` is Hyperliquid USDC (8 decimals): that, rounded up to micro-USDC, plus the surcharge. */
export const intentsSendAmount = (amountIn8: string): bigint => (BigInt(amountIn8) + 99n) / 100n + INTENTS_USD_SEND_SURCHARGE;
