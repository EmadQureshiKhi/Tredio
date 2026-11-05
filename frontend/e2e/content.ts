/**
 * Public text the live specs write: caller handles, call notes and thread posts land on real
 * Testnet pages (leaderboards, threads, caller profiles), so they read like a person wrote them.
 * Each still carries the time to the second, which keeps it unique for the assertion that finds it.
 */

const NAMES = ["mila", "owen", "ruby", "leo", "nina", "sam", "iris", "jonah", "tara", "eli"];

const clock = (d = new Date()) => d.toISOString().slice(11, 19);

/** A caller handle: a first name and a short unique tail, 3 to 20 of a-z, 0-9 and _. */
export function callerHandle(now = Date.now()): string {
  return `${NAMES[now % NAMES.length]}_${now.toString(36).slice(-5)}`;
}

export const CALLER_BIO = "Calls on where attention goes next.";

/** A call note, unique to the second. */
export function callNote(d = new Date()): string {
  return `Watching this into the ${clock(d)} UTC update. Attention looks set to hold its level.`;
}

/** A thread post, unique to the second. */
export function threadPost(d = new Date()): string {
  return `Index check at ${clock(d)} UTC: readers still coming in, keeping my position for now.`;
}

/** A call made from one device and found again from another, unique to the second. */
export function deviceNote(d = new Date()): string {
  return `Called from my laptop at ${clock(d)} UTC, checking it again from my phone later.`;
}
