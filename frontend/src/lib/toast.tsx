"use client";
import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { EXPLORER_NAME } from "@/lib/config";

/** Every toast the app shows, so they read alike: short confirmations and backend errors. */

const INFO_MS = 4_000;
const ERROR_MS = 8_000;
const COPIED_MS = 1_800;

/**
 * The glowing bar along a toast's foot: it fills from edge to edge over the toast's life (`ms`), so it
 * reaches the far edge as the toast closes, or sweeps back and forth while it waits.
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
