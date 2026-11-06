import type { Outcome } from "@tredio/contracts";

/**
 * The portfolio's arithmetic, mirroring the contracts: USDC and outcome tokens carry 6 decimals,
 * a complete set (one UP plus one DOWN) mints and redeems for exactly 1 USDC, and after settlement
 * a winning token pays 1 USDC, a losing one nothing, and every token of a void series 0.50.
 */

export const USDC_UNIT = 1e6;
export const toUsdc = (raw: bigint) => Number(raw) / USDC_UNIT;
export const toTokens = (raw: bigint, decimals = 6) => Number(raw) / 10 ** decimals;

/** Raw USDC that `redeem_winnings` pays for these balances (void pays half of each, rounded down). */
export function winningsRaw(outcome: Outcome, up: bigint, down: bigint): bigint {
  if (outcome === "up") return up;
  if (outcome === "down") return down;
  if (outcome === "void") return up / 2n + down / 2n;
  return 0n;
}

export interface OutcomeValue {
  /** USDC, or null when part of the holding has no price yet. */
  value: number | null;
  /** Complete sets held (raw): each redeems for 1 USDC. */
  sets: bigint;
}

/** Complete sets at 1.00 each, the unpaired rest at the side's mid while open, or at the payout once known. */
export function outcomeValue(p: { up: bigint; down: bigint; outcome: Outcome; upMid: number | null; downMid: number | null }): OutcomeValue {
  const sets = p.up < p.down ? p.up : p.down;
  if (p.outcome !== "open") return { value: toUsdc(winningsRaw(p.outcome, p.up, p.down)), sets };
  const upLeft = p.up - sets;
  const downLeft = p.down - sets;
  let value = toUsdc(sets);
  if (upLeft > 0n) {
    if (p.upMid === null) return { value: null, sets };
    value += toTokens(upLeft) * p.upMid;
  }
  if (downLeft > 0n) {
    if (p.downMid === null) return { value: null, sets };
    value += toTokens(downLeft) * p.downMid;
  }
  return { value, sets };
}

/** The closing fee the perps charge: 0.1% of notional at the exit index. */
export const closeFee = (notional: number) => notional * 0.001;
