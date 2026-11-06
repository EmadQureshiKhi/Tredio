/**
 * The testnet faucet: the test USDC contract pays each account once per cooldown, and the API's
 * `GET /v1/faucet?account=` says what it pays and when this account may draw again (read on chain
 * from the contract's `faucet_info`), so the button can count down without guessing.
 */

export type FaucetState = { kind: "ready" } | { kind: "waiting"; nextAt: number };

/** What the faucet offers at `nowMs`, given when the account may draw next (unix seconds, or null). */
export function faucetState(nextAt: number | null | undefined, nowMs: number): FaucetState {
  return nextAt && nextAt * 1000 > nowMs ? { kind: "waiting", nextAt: nextAt * 1000 } : { kind: "ready" };
}

/** The faucet button: a success state right after a draw, then the wait until the next one. */
export function faucetButton(state: FaucetState, nowMs: number, justClaimed: string | null): { label: string; tone: "ready" | "success" | "waiting" } {
  if (justClaimed) return { label: `Claimed ${justClaimed} USDC`, tone: "success" };
  if (state.kind === "waiting") return { label: `Claimed, next in ${untilText(state.nextAt - nowMs)}`, tone: "waiting" };
  return { label: "Get test USDC", tone: "ready" };
}

/** "5h 12m", "45m", "1m": the wait until the next draw, rounded up to the minute. */
export function untilText(ms: number): string {
  const m = Math.max(1, Math.ceil(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

/** The contract's refusal of an account still inside its cooldown. */
export const isCooldown = (reason: string | null | undefined) => /faucet cooldown|drew test USDC a short while ago/i.test(reason ?? "");
