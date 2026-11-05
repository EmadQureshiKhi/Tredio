"use client";
import { useSyncExternalStore } from "react";

/**
 * The Testnet faucet pays each account once per 24 hours, but its public endpoint only says
 * whether the faucet runs at all. So this browser remembers each account's last claim: the time
 * of a claim made here, or, when the faucet refused because the account already claimed
 * elsewhere, that refusal (whose claim time is unknown).
 */

const KEY = "tredio.faucet-claims";
const EVENT = "tredio-faucet-claims";
export const CLAIM_EVERY_MS = 24 * 3_600_000;
/** After a refusal with no known claim time, how long the button waits before offering a retry. */
export const RETRY_AFTER_REFUSAL_MS = 3_600_000;

export interface Claim {
  at: number;
  /** False when the faucet refused: `at` is when it refused, not when the account claimed. */
  known: boolean;
}

export type FaucetState = { kind: "ready" } | { kind: "claimed"; nextAt: number } | { kind: "refused"; retryAt: number };

/** What the faucet button offers an account at `now` (ms), given its last claim. */
export function faucetState(claim: Claim | null, now: number): FaucetState {
  if (!claim) return { kind: "ready" };
  if (claim.known) return claim.at + CLAIM_EVERY_MS > now ? { kind: "claimed", nextAt: claim.at + CLAIM_EVERY_MS } : { kind: "ready" };
  return claim.at + RETRY_AFTER_REFUSAL_MS > now ? { kind: "refused", retryAt: claim.at + RETRY_AFTER_REFUSAL_MS } : { kind: "ready" };
}

/**
 * The faucet button: a success state right after a claim (`justClaimed` names the amount), then
 * the wait until the next one, or a refusal's note; ready otherwise.
 */
export function faucetButton(state: FaucetState, now: number, justClaimed: string | null): { label: string; tone: "ready" | "success" | "waiting" } {
  if (justClaimed) return { label: `Claimed ${justClaimed} USDC`, tone: "success" };
  if (state.kind === "claimed") return { label: `Claimed today, next in ${untilText(state.nextAt - now)}`, tone: "waiting" };
  if (state.kind === "refused") return { label: "Claimed today", tone: "waiting" };
  return { label: "Get test USDC", tone: "ready" };
}

/** "5h 12m", "45m", "1m": the wait until the next claim, rounded up to the minute. */
export function untilText(ms: number): string {
  const m = Math.max(1, Math.ceil(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

/** True for the faucet's refusal of an account that already claimed in the last 24 hours. */
export const isAlreadyClaimed = (status: number, reason: string | undefined) => status === 429 && /already received/i.test(reason ?? "");

function readAll(): Record<string, Claim> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, Claim>) : {};
  } catch {
    return {};
  }
}

let cache: { raw: string | null; all: Record<string, Claim> } | null = null;
function snapshot(): Record<string, Claim> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    // Storage blocked: nothing remembered.
  }
  if (!cache || cache.raw !== raw) cache = { raw, all: readAll() };
  return cache.all;
}

export function recordClaim(account: string, claim: Claim) {
  const all = readAll();
  // Claims older than a day mean nothing; drop them so the store never grows.
  for (const [k, c] of Object.entries(all)) if (c.at + CLAIM_EVERY_MS < Date.now()) delete all[k];
  all[account.toLowerCase()] = claim;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Storage blocked: the faucet's own refusal still guards it.
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(notify: () => void) {
  window.addEventListener(EVENT, notify);
  window.addEventListener("storage", notify);
  return () => {
    window.removeEventListener(EVENT, notify);
    window.removeEventListener("storage", notify);
  };
}

const EMPTY: Record<string, Claim> = {};

/** The account's last claim remembered in this browser, or null. */
export function useFaucetClaim(account: string | undefined): Claim | null {
  const all = useSyncExternalStore(subscribe, snapshot, () => EMPTY);
  return account ? (all[account.toLowerCase()] ?? null) : null;
}
