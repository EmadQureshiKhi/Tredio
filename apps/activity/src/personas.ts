import { readFileSync } from "node:fs";

/**
 * How a persona trades and talks:
 * - momentum: sides with the last day's move;
 * - contrarian: fades it;
 * - perps: mostly attention perps, both ways;
 * - caller: mostly calls and thread posts, small trades;
 * - swing: a bit of everything, holds longer.
 */
export type Style = "momentum" | "contrarian" | "perps" | "caller" | "swing";

export interface RosterEntry {
  name: string;
  /** The caller handle: 3 to 20 of a-z, 0-9 and _. */
  handle: string;
  bio: string;
  style: Style;
  /** Hours from UTC of the persona's day: it acts between 08:00 and 24:00 there. */
  utcOffset: number;
}

/** Invented people, none of them real, run by Tredio to keep the testnet market moving (JUDGES.md says so). */
export const ROSTER: readonly RosterEntry[] = [
  { name: "Mila Kovac", handle: "mila_k", bio: "Trading what the timeline cannot stop talking about.", style: "momentum", utcOffset: 1 },
  { name: "Owen Hartley", handle: "owenh", bio: "Fading the hype, one index at a time.", style: "contrarian", utcOffset: 0 },
  { name: "Ruby Okafor", handle: "rubyreads", bio: "News first, positions second.", style: "caller", utcOffset: 1 },
  { name: "Leo Tanaka", handle: "leo_onchain", bio: "Attention perps, small size, tight stops.", style: "perps", utcOffset: 9 },
  { name: "Nina Alvarez", handle: "nina_sats", bio: "Patient. Mostly.", style: "swing", utcOffset: -5 },
  { name: "Sam Whitfield", handle: "sam_w", bio: "If it trends, I trade it.", style: "momentum", utcOffset: -8 },
  { name: "Iris Novak", handle: "irisn", bio: "Calls with receipts.", style: "caller", utcOffset: 2 },
  { name: "Jonah Reyes", handle: "jonah_r", bio: "Long attention, short noise.", style: "perps", utcOffset: -6 },
  { name: "Tara Lindqvist", handle: "tara_index", bio: "Charts the index, ignores the headlines.", style: "momentum", utcOffset: 1 },
  { name: "Eli Brandt", handle: "eli_macro", bio: "Macro brain, attention market hands.", style: "contrarian", utcOffset: -5 },
  { name: "Priya Raman", handle: "priya_trends", bio: "Tracking how fast a story cools.", style: "caller", utcOffset: 5.5 },
  { name: "Marco Bellini", handle: "marco_b", bio: "Two positions at a time, never more.", style: "swing", utcOffset: 1 },
];

/** One persona as the setup script writes it: public profile, account and keys. */
export interface Persona extends RosterEntry {
  account: string;
  /** The passkey's P-256 secret (hex): owner actions only, never needed by the runner. */
  passkeySecret: string;
  /** The trading session: a gas key on the account. */
  sessionPublicKey: string;
  sessionSecretKey: string;
  /** The caller identity: an ed25519 seed (hex) whose public key is the caller's address. */
  identitySecret: string;
  identity: string;
}

export function loadPersonas(file: string): Persona[] {
  const personas = JSON.parse(readFileSync(file, "utf8")) as Persona[];
  if (!Array.isArray(personas) || personas.length === 0) throw new Error(`${file} holds no personas`);
  return personas;
}
