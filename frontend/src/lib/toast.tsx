"use client";
import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { EXPLORER_NAME, explorerTx } from "@/lib/config";

/**
 * Every toast the app shows, so they read alike: short confirmations, backend errors, and one
 * toast per transaction that moves through pending, filled and final (or failed) in place.
 */

const INFO_MS = 4_000;
const ERROR_MS = 8_000;
const COPIED_MS = 1_800;
const TX_MS = 4_000;
/** The final update restarts the timer, so it stays only briefly: the fill was already shown. */
const FINAL_MS = 2_500;
const CANCELLED_MS = 3_000;

/**
 * The glowing bar along a toast's foot: it fills from edge to edge over the toast's life (`ms`), so it
 * reaches the far edge as the toast closes, or sweeps back and forth while a transaction is pending.
 * A fresh key restarts it whenever the toast is updated in place, as the timer restarts too.
 */
let barKey = 0;
function Bar({ ms }: { ms: number | null }) {
  return <span aria-hidden data-toast-bar={ms === null ? "wait" : "timed"} style={ms === null ? undefined : { animationDuration: `${ms}ms` }} />;
}

/** A toast's description with its bar: the bar sits inside it but is drawn along the toast's foot. */
function body(description: ReactNode, ms: number | null): ReactNode {
  return (
    <>
      {description}
      <Bar key={++barKey} ms={ms} />
    </>
  );
}

/** The compact explorer link a toast carries on its right. */
export function ToastLink({ href, label = EXPLORER_NAME }: { href: string; label?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={`View on ${EXPLORER_NAME}`}
      className="ml-auto inline-flex h-7 shrink-0 items-center gap-1.5 self-center rounded-lg border border-line bg-surface-2 px-2.5 font-strong text-[12px] text-text-2 transition-colors hover:border-line-strong hover:text-text"
    >
      <ExternalLink className="size-3.5" aria-hidden />
      {label}
    </a>
  );
}

/** `href` adds the explorer link: the transaction or account the toast is about. */
export const notify = {
  success: (title: string, description?: ReactNode, href?: string) =>
    toast.success(title, { description: body(description, INFO_MS), duration: INFO_MS, action: href ? <ToastLink href={href} /> : undefined }),
  info: (title: string, description?: ReactNode) => toast.info(title, { description: body(description, INFO_MS), duration: INFO_MS }),
  /** A failure the user should read: stays a little longer. */
  error: (title: string, description?: ReactNode) => toast.error(title, { description: body(description, ERROR_MS), duration: ERROR_MS }),
  /** A short "Copied", replacing the previous one rather than stacking. */
  copied: (title = "Copied") => toast.success(title, { id: "copied", description: body(undefined, COPIED_MS), duration: COPIED_MS }),
};

/** Copies text and confirms it with a toast; says so when the browser refuses. */
export async function copyText(text: string, title = "Copied"): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    notify.copied(title);
    return true;
  } catch {
    notify.error("Could not copy", "Your browser blocked the clipboard. Select the text and copy it instead.");
    return false;
  }
}

/** Toasts still on screen: a finality update never brings back one the user dismissed. */
const open = new Set<string>();
const track = { onDismiss: (t: { id: string | number }) => open.delete(String(t.id)), onAutoClose: (t: { id: string | number }) => open.delete(String(t.id)) };

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** One transaction's toast, updated in place by its id. */
export const txToast = {
  pending(id: string, action: string, note = "Sending to NEAR") {
    open.add(id);
    toast.loading(action, { id, description: body(note, null), duration: Number.POSITIVE_INFINITY, ...track });
  },
  filled(id: string, { done, fillMs, hash, final }: { done: string; fillMs: number | null; hash: string; final: boolean }) {
    // A finality update only refreshes a toast that is still showing.
    if (final && !open.has(id)) return;
    open.add(id);
    const ms = final ? FINAL_MS : TX_MS;
    toast.success(done, {
      id,
      description: body(`Filled${fillMs === null ? "" : ` in ${seconds(fillMs)}`}, ${final ? "final" : "finalizing"}`, ms),
      action: hash ? <ToastLink href={explorerTx(hash)} /> : undefined,
      duration: ms,
      ...track,
    });
  },
  failed(id: string, { action, reason, hash }: { action: string; reason: string; hash: string | null }) {
    open.delete(id);
    toast.error(`${action} failed`, { id, description: body(reason, ERROR_MS), action: hash ? <ToastLink href={explorerTx(hash)} /> : undefined, duration: ERROR_MS });
  },
  cancelled(id: string, action: string) {
    open.delete(id);
    toast(`${action} cancelled`, { id, description: body("Nothing was sent.", CANCELLED_MS), duration: CANCELLED_MS });
  },
  dismiss(id: string) {
    open.delete(id);
    toast.dismiss(id);
  },
};
