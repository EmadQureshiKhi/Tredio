"use client";
import { useSyncExternalStore } from "react";
import { WAITLIST_KEY as KEY, waitlistTokens } from "./hint";

/**
 * What this browser knows about the Mainnet waitlist: the emails it joined with (and the account
 * each linked), whether the phone row under the Home hero was dismissed, and whether the desktop
 * sidebar card was collapsed to a button. The backend never says whether an email is listed, so this
 * is the only memory of a join. A pre-paint script copies it to <html data-waitlist> (hint.ts), so
 * the first paint already shows the right card and row; elements marked `when-waitlist-open`,
 * `when-waitlist-collapsed`, `when-waitlist-joined` or `when-waitlist-row` (globals.css) show for
 * their case only until the store is read.
 */

const EVENT = "tredio-waitlist";

export interface Joined {
  email: string;
  /** The account linked to the email, lowercase, or null. */
  account: string | null;
  at: number;
}

export interface WaitlistMemory {
  joined: Joined[];
  rowDismissed: boolean;
  cardCollapsed: boolean;
}

const EMPTY: WaitlistMemory = { joined: [], rowDismissed: false, cardCollapsed: false };

/** The stored memory, tolerant of anything malformed (an older or hand-edited value). */
export function readMemory(raw: string | null): WaitlistMemory {
  if (!raw) return EMPTY;
  try {
    const v = JSON.parse(raw) as Partial<WaitlistMemory>;
    const joined = Array.isArray(v.joined) ? v.joined.filter((j): j is Joined => typeof j?.email === "string" && typeof j.at === "number") : [];
    return { joined: joined.map((j) => ({ email: j.email, account: typeof j.account === "string" ? j.account : null, at: j.at })), rowDismissed: v.rowDismissed === true, cardCollapsed: v.cardCollapsed === true };
  } catch {
    return EMPTY;
  }
}

let cache: { raw: string | null; memory: WaitlistMemory } | null = null;
function snapshot(): WaitlistMemory {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    // Storage blocked: nothing remembered, the card offers the waitlist again.
  }
  if (!cache || cache.raw !== raw) cache = { raw, memory: readMemory(raw) };
  return cache.memory;
}

function write(memory: WaitlistMemory) {
  const html = document.documentElement;
  const tokens = waitlistTokens(memory);
  if (tokens) html.dataset.waitlist = tokens;
  else delete html.dataset.waitlist;
  try {
    localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    // Storage blocked: the join still happened; this browser just forgets it on reload.
    cache = { raw: null, memory };
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Remembers a join; joining again with the same email updates its account. */
export function rememberJoin(email: string, account: string | null) {
  const memory = snapshot();
  const key = email.trim().toLowerCase();
  const before = memory.joined.find((j) => j.email === key);
  const entry: Joined = { email: key, account: account?.toLowerCase() ?? before?.account ?? null, at: before?.at ?? Date.now() };
  write({ ...memory, joined: [entry, ...memory.joined.filter((j) => j.email !== key)] });
}

export function dismissRow() {
  write({ ...snapshot(), rowDismissed: true });
}

/** Folds the desktop sidebar card down to a "Join the waitlist" button. */
export function collapseCard() {
  write({ ...snapshot(), cardCollapsed: true });
}

function subscribe(notify: () => void) {
  window.addEventListener(EVENT, notify);
  window.addEventListener("storage", notify);
  return () => {
    window.removeEventListener(EVENT, notify);
    window.removeEventListener("storage", notify);
  };
}

/** This browser's waitlist memory, or null while the server renders and the page hydrates. */
export function useWaitlistMemory(): WaitlistMemory | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

/** The email this browser joined with that `account` linked, else the latest one. */
export function joinedFor(memory: WaitlistMemory | null, account: string | undefined): Joined | null {
  if (!memory || memory.joined.length === 0) return null;
  const a = account?.toLowerCase();
  return (a && memory.joined.find((j) => j.account === a)) || memory.joined[0]!;
}
