import type { Target } from "./targets";

export interface TargetMemory {
  /** Unix ms of the last transfer and its outcome. */
  lastTransfer: { at: number; amount: string; hash: string | null; status: "sent" | "failed" } | null;
  /** Transfers in the last day (unix ms, raw amount), for the daily cap. */
  sent: Array<{ at: number; amount: string }>;
  /** Consecutive failures and when to try again. */
  failures: number;
  retryAt: number;
  /** Balance samples for the burn estimate (unix ms, raw). */
  samples: Array<{ at: number; balance: string }>;
}

export interface Decision {
  target: Target;
  amount: bigint;
  /** Why nothing is sent, when nothing is. */
  skip: string | null;
}

export interface PlanOptions {
  cooldownMs: number;
  /** The most one target receives in a day (raw, per kind's unit). */
  dailyCap: (t: Target) => bigint;
  /** What the paying account may spend now, per kind: NEAR above the treasury floor, or USDC the minter may mint. */
  spendable: (kind: Target["kind"]) => bigint;
}

export const DAY_MS = 86_400_000;
export const MIN_BURN_SPAN_MS = 6 * 3_600_000;

export const freshMemory = (): TargetMemory => ({ lastTransfer: null, sent: [], failures: 0, retryAt: 0, samples: [] });

/**
 * Decides each target's refill, in priority order (the order the targets are listed): a target
 * below its minimum is brought back to its target, within its daily cap, after its cooldown and
 * any failure backoff, and while the payer can afford it. Pure, so it is tested without a chain.
 */
export function plan(targets: readonly Target[], balances: ReadonlyMap<string, bigint | null>, memory: ReadonlyMap<string, TargetMemory>, nowMs: number, o: PlanOptions): Decision[] {
  const left = new Map<Target["kind"], bigint>();
  const budget = (k: Target["kind"]) => left.get(k === "gasKey" ? "near" : k) ?? o.spendable(k);
  return targets.map((t) => {
    const balance = balances.get(t.name);
    const m = memory.get(t.name) ?? freshMemory();
    if (balance === null || balance === undefined) return { target: t, amount: 0n, skip: "balance unknown" };
    if (balance >= t.min) return { target: t, amount: 0n, skip: null };
    if (m.retryAt > nowMs) return { target: t, amount: 0n, skip: "backing off after a failure" };
    if (m.lastTransfer && m.lastTransfer.status === "sent" && nowMs - m.lastTransfer.at < o.cooldownMs) return { target: t, amount: 0n, skip: "cooling down" };
    const today = m.sent.filter((s) => nowMs - s.at < DAY_MS).reduce((a, s) => a + BigInt(s.amount), 0n);
    const capLeft = o.dailyCap(t) - today;
    let amount = t.target - balance;
    if (amount > capLeft) amount = capLeft;
    if (amount <= 0n) return { target: t, amount: 0n, skip: "daily cap reached" };
    const have = budget(t.kind);
    if (amount > have) return { target: t, amount: 0n, skip: "the treasury cannot afford it" };
    left.set(t.kind === "gasKey" ? "near" : t.kind, have - amount);
    return { target: t, amount, skip: null };
  });
}

/**
 * NEAR (or USDC) a target used over the last day, from its balance samples and what it received:
 * the drop in balance plus the refills, over the time the samples span, scaled to a day. Null
 * until the samples span six hours, so a one-off spend (an account creation) is not read as a
 * day's pace.
 */
export function burnPerDay(m: TargetMemory, nowMs: number): bigint | null {
  const samples = m.samples.filter((s) => nowMs - s.at <= DAY_MS);
  if (samples.length < 2) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const span = last.at - first.at;
  if (span < MIN_BURN_SPAN_MS) return null;
  const received = m.sent.filter((s) => s.at > first.at && s.at <= last.at).reduce((a, s) => a + BigInt(s.amount), 0n);
  const used = BigInt(first.balance) + received - BigInt(last.balance);
  return used <= 0n ? 0n : (used * BigInt(DAY_MS)) / BigInt(span);
}
