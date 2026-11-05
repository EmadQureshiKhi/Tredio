/**
 * Readable text for a refused request (HTTP 429): the service's own reason when it gives one, and
 * when to try again from its Retry-After header.
 */

/** Seconds a Retry-After header asks to wait (delta seconds or an HTTP date), or null without one. */
export function retryAfterSec(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

/** "a few seconds", "40 seconds", "3 minutes", "2 hours". */
export function waitText(sec: number): string {
  if (sec <= 5) return "a few seconds";
  if (sec < 90) return `${Math.round(sec)} seconds`;
  if (sec < 90 * 60) return `${Math.round(sec / 60)} minutes`;
  return `${Math.round(sec / 3600)} hours`;
}

/** Reasons that say nothing beyond the status itself. */
const GENERIC = /^(too many requests|slow down|rate[ _]?limited|request failed \(429\))\.?$/i;

/** The message for a 429 from the backend or the relayer, written for the person using the app. */
export function rateLimitMessage(reason: string | null | undefined, retryAfter: number | null): string {
  const text = (reason ?? "").trim();
  const generic = !text || GENERIC.test(text);
  const base = generic ? "Too many requests." : sentence(text);
  if (/try again/i.test(base)) return base;
  if (retryAfter !== null) return `${base} Try again in ${waitText(retryAfter)}.`;
  // A specific reason ("daily link limit reached") already says how long; a bare refusal is short-lived.
  return generic ? `${base} Wait a moment and try again.` : base;
}

function sentence(text: string): string {
  const t = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(t) ? t : `${t}.`;
}
