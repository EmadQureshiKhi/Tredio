import { base64Decode } from "./encoding";

/** Reading a transaction's outcome: whether every receipt succeeded, and what it returned. */

/** The part of a final execution outcome the app reads (near-kit's and wallets' shapes agree on it). */
export interface Outcome {
  status?: unknown;
  transaction?: { hash?: string };
  transaction_outcome?: { id?: string; outcome?: { status?: unknown } };
  receipts_outcome?: Array<{ id?: string; outcome: { status?: unknown; logs?: string[]; executor_id?: string } }>;
}

/** A transaction that was sent and failed, or never went out; `hash` is set once it reached the chain. */
export class TxFailed extends Error {
  constructor(
    message: string,
    readonly hash: string | null = null,
  ) {
    super(message);
    this.name = "TxFailed";
  }
}

const PANIC = /Smart contract panicked: (.*?)(?:"|$)/s;

/** A failure status as readable text: the contract's panic message when there is one. */
export function failureText(failure: unknown): string {
  const text = typeof failure === "string" ? failure : JSON.stringify(failure);
  const panic = PANIC.exec(text)?.[1];
  if (panic) return panic.replace(/\\n/g, " ").trim();
  const exec = /ExecutionError":"([^"]+)"/.exec(text)?.[1];
  if (exec) return exec;
  if (/NotEnoughBalance|LackBalanceForState/.test(text)) return "the account does not hold enough NEAR for this";
  if (/GasKeyBalance|NotEnoughGasKeyBalance|InsufficientGasKeyBalance/i.test(text)) return "the session's gas balance ran low";
  return text.slice(0, 240);
}

const failureOfStatus = (status: unknown): string | null =>
  status && typeof status === "object" && "Failure" in status ? failureText((status as { Failure: unknown }).Failure) : null;

/** The first failure in an outcome (the transaction or any receipt), or null when all succeeded. */
export function failureOf(o: Outcome): string | null {
  return (
    failureOfStatus(o.status) ??
    failureOfStatus(o.transaction_outcome?.outcome?.status) ??
    (o.receipts_outcome ?? []).map((r) => failureOfStatus(r.outcome.status)).find((x): x is string => x !== null) ??
    null
  );
}

export const hashOf = (o: Outcome): string => o.transaction?.hash ?? o.transaction_outcome?.id ?? "";

/** The decoded return value of a successful transaction (JSON or text), if any. */
export function returnValue<T>(o: Outcome): T | undefined {
  const s = o.status as { SuccessValue?: string } | undefined;
  if (!s?.SuccessValue) return undefined;
  const text = new TextDecoder().decode(base64Decode(s.SuccessValue));
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

/** Every NEP-297 event the outcome's receipts logged. */
export function eventsOf(o: Outcome): Array<{ standard: string; event: string; data: unknown }> {
  const out: Array<{ standard: string; event: string; data: unknown }> = [];
  for (const r of o.receipts_outcome ?? []) {
    for (const log of r.outcome.logs ?? []) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      try {
        out.push(JSON.parse(log.slice("EVENT_JSON:".length)) as { standard: string; event: string; data: unknown });
      } catch {
        // Not an event.
      }
    }
  }
  return out;
}

/**
 * A refusal the contracts log instead of failing (the funds go back and the transaction succeeds):
 * an attention perp the perps contract would not open, a coin trade the curve refused, an order the
 * account's Hyperliquid guard rejected. Null when nothing was refused.
 */
export function refusalOf(o: Outcome): string | null {
  for (const e of eventsOf(o)) {
    if (!/(_refused|_rejected)$/.test(e.event)) continue;
    const reason = (Array.isArray(e.data) ? e.data[0] : e.data) as { reason?: string } | undefined;
    return reason?.reason ?? e.event.replace(/_/g, " ");
  }
  return null;
}
