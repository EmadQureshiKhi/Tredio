"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { describeError } from "@/lib/account/errors";
import type { TxResult } from "@/lib/account/service";
import { PasskeyCancelled } from "@/lib/account/webauthn";
import { TxFailed } from "@/lib/chain/outcome";
import { isFinal } from "@/lib/chain/sender";
import { txToast } from "@/lib/toast";

/**
 * One transaction's progress. The send resolves once every receipt ran on NEAR, which the app
 * shows as "Filled"; it turns "Final" once its block is final, a second or two later.
 *
 * Every run also has one toast: the fill (updated in place when final) and any failure, each with
 * its NearBlocks link. The pending stage toasts only when nothing on screen shows it: the inline
 * status scrolled away or its screen closed while the transaction was still in flight.
 */

export type TxStage = "idle" | "pending" | "filled" | "final" | "failed";

interface State {
  stage: TxStage;
  hash: string | null;
  error: string | null;
  /** Milliseconds from sending to the fill. */
  fillMs: number | null;
}

const IDLE: State = { stage: "idle", hash: null, error: null, fillMs: null };

/** How a run names itself in its toasts. */
export interface TxLabels {
  /** The action, as its button names it ("Buy Up"): titles the pending and failed toasts. */
  action: string;
  /** What it did, past tense ("Bought Up"): titles the success toast. */
  done: string;
  /** What the pending toast says while it waits (a passkey prompt, a wallet, NEAR). */
  pending?: string;
}

const GENERIC: TxLabels = { action: "Transaction", done: "Transaction filled" };
/** How long a run may stay pending, out of sight, before it gets its own toast. */
const PENDING_CHECK_MS = 1_200;
const FINAL_POLL_MS = 1_200;
const FINAL_WAIT_MS = 30_000;

export interface Tx extends Omit<State, "stage"> {
  stage: TxStage;
  busy: boolean;
  /** Sends and tracks one transaction; resolves with its result, or null when it failed. */
  run<T>(send: () => Promise<TxResult<T>>, labels?: TxLabels): Promise<TxResult<T> | null>;
  reset(): void;
  /** Ref for the inline status: while it is in view, the pending stage needs no toast. */
  inline(el: HTMLElement | null): void;
}

/** True while `el` is attached, visible and at least partly inside the viewport. */
function inView(el: HTMLElement | null): boolean {
  if (!el?.isConnected) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
}

/** Resolves true once the transaction's block is final, false if it is not within the wait. */
async function whenFinal(hash: string, sender: string): Promise<boolean> {
  const until = Date.now() + FINAL_WAIT_MS;
  while (Date.now() < until) {
    if (await isFinal(hash, sender)) return true;
    await new Promise((r) => setTimeout(r, FINAL_POLL_MS));
  }
  return false;
}

let runs = 0;

interface Flight {
  id: string;
  action: string;
  note: string;
  toasted: boolean;
}

export function useTx(): Tx {
  const [s, setS] = useState<State>(IDLE);
  const inlineEl = useRef<HTMLElement | null>(null);
  const flight = useRef<Flight | null>(null);
  const mounted = useRef(true);

  // A screen that closes mid-flight hands the transaction to a toast.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const f = flight.current;
      if (f && !f.toasted) {
        f.toasted = true;
        txToast.pending(f.id, f.action, f.note);
      }
    };
  }, []);

  const set = useCallback((next: State) => {
    if (mounted.current) setS(next);
  }, []);

  const run = useCallback(
    async <T,>(send: () => Promise<TxResult<T>>, labels: TxLabels = GENERIC): Promise<TxResult<T> | null> => {
      const f: Flight = { id: `tx-${++runs}`, action: labels.action, note: labels.pending ?? "Sending to NEAR", toasted: false };
      flight.current = f;
      const started = performance.now();
      set({ ...IDLE, stage: "pending" });
      const watch = setInterval(() => {
        if (f.toasted || flight.current !== f || inView(inlineEl.current)) return;
        f.toasted = true;
        txToast.pending(f.id, f.action, f.note);
      }, PENDING_CHECK_MS);
      try {
        const r = await send();
        const fillMs = performance.now() - started;
        set({ stage: "filled", hash: r.hash, error: null, fillMs });
        txToast.filled(f.id, { done: labels.done, fillMs, hash: r.hash, final: false });
        if (r.sender && r.hash) {
          void whenFinal(r.hash, r.sender).then((final) => {
            if (!final) return;
            txToast.filled(f.id, { done: labels.done, fillMs, hash: r.hash, final: true });
            if (flight.current === null || flight.current === f) setS((x) => (mounted.current && x.hash === r.hash && x.stage === "filled" ? { ...x, stage: "final" } : x));
          });
        }
        return r;
      } catch (e) {
        const error = describeError(e);
        const hash = e instanceof TxFailed ? e.hash : null;
        set({ ...IDLE, stage: "failed", error, hash });
        // A cancelled passkey prompt is the user's own choice: the inline note is enough when in view.
        if (e instanceof PasskeyCancelled) {
          if (f.toasted || !inView(inlineEl.current)) txToast.cancelled(f.id, labels.action);
        } else {
          txToast.failed(f.id, { action: labels.action, reason: error, hash });
        }
        return null;
      } finally {
        clearInterval(watch);
        if (flight.current === f) flight.current = null;
      }
    },
    [set],
  );
  const reset = useCallback(() => setS(IDLE), []);
  const inline = useCallback((el: HTMLElement | null) => {
    inlineEl.current = el;
  }, []);
  return { ...s, busy: s.stage === "pending", run, reset, inline };
}
