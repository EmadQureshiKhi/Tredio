import { z } from "zod";
import type { Holding } from "./copy";
import { AUTOPILOT_MARKETS, autopilotMarketProblem } from "./markets";

/**
 * Paid private trade signals (WebCrypto only, so the same code runs in the browser, the API and
 * the executor). A leader is a caller identity linked to a trading account. Each signal is a trade
 * in one of Autopilot's markets, signed by the caller key, committed on chain from the leader's
 * account before anyone can read it (its SHA-256 in the memo of a 0.000001 USDC transfer), stored
 * encrypted, and readable early only with that week's viewing key for the leader, which followers
 * buy in USDC on NEAR. After the leader's delay the API publishes it to everyone.
 *
 * What stays public: positions on chain, and the copies Autopilot places. What is private is the
 * signal itself and its timing until the reveal. Tredio's server derives the viewing keys (it sells
 * them), so the server can read every signal; the on-chain commitment proves the leader posted the
 * signal before its reveal and that nobody changed it since.
 */

/** Viewing keys rotate weekly, so a lapsed subscription reads nothing new. */
export const SIGNAL_EPOCH_SEC = 7 * 86_400;
/** The memo of the commitment transfer: `tredio-signal:<sha256 hex of the signed message>`. */
export const COMMIT_MEMO_PREFIX = "tredio-signal:";
/** The memo of a viewing key purchase: `tredio-signals:<leader identity>`. */
export const ACCESS_MEMO_PREFIX = "tredio-signals:";
/** The commitment transfer's amount: one micro-USDC, to the treasury. */
export const COMMIT_AMOUNT = 1n;
/** The leader whose signals a follow copies: `signals:<identity>`. */
export const signalLeader = (identity: string) => `signals:${identity}`;
export const identityOfLeader = (leader: string): string | null => (/^signals:[0-9a-f]{64}$/.test(leader) ? leader.slice(8) : null);

/** A signal as the leader writes it. */
export const signalInputSchema = z
  .object({
    kind: z.enum(["open", "close"]),
    market: z.string().refine((m) => AUTOPILOT_MARKETS.includes(m as (typeof AUTOPILOT_MARKETS)[number]), { message: `one of ${AUTOPILOT_MARKETS.join(", ")}` }),
    side: z.enum(["long", "short"]),
    /** Openings: margin the leader commits to the trade, USDC; copies scale it by their own settings. */
    marginUsdc: z.number().positive().max(100_000).optional(),
    /** Openings: leverage, at most 10 (the account guard's limit). */
    leverage: z.number().min(1).max(10).optional(),
    note: z.string().max(280).default(""),
  })
  .refine((s) => s.kind === "close" || (s.marginUsdc !== undefined && s.leverage !== undefined), { message: "an opening names its margin and leverage", path: ["marginUsdc"] });
export type SignalInput = z.input<typeof signalInputSchema>;

/** A signal as stored and revealed: what the leader signed, plus the mark the API stamped when it took it. */
export interface Signal {
  leader: string;
  kind: "open" | "close";
  market: string;
  side: "long" | "short";
  marginUsdc: number | null;
  leverage: number | null;
  note: string;
  issuedAt: number;
  /** The market's mark when the API accepted the signal: the price copies are held to. */
  price: number;
}

// Plain byte helpers (no Buffer: this runs in the browser too).
const bytes = (b: ArrayBuffer | Uint8Array) => (b instanceof Uint8Array ? b : new Uint8Array(b));
const hex = (b: ArrayBuffer | Uint8Array) => Array.from(bytes(b), (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string): Uint8Array<ArrayBuffer> => {
  if (!/^(?:[0-9a-f]{2})*$/.test(h)) throw new Error("not hex");
  return new Uint8Array(h.match(/../g)?.map((x) => Number.parseInt(x, 16)) ?? []);
};
const b64url = (b: ArrayBuffer | Uint8Array) => {
  let s = "";
  for (const x of bytes(b)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64url = (s: string): Uint8Array<ArrayBuffer> => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const text = (s: string) => new TextEncoder().encode(s);
async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", text(s)));
}

/** The text the caller key signs (ed25519 over its UTF-8), in the same form as calls and posts. */
export async function signalMessage(leader: string, s: Omit<Signal, "leader" | "price">): Promise<string> {
  const amounts = s.kind === "open" ? `margin: ${s.marginUsdc}\nleverage: ${s.leverage}\n` : "";
  return `Tredio signal\nleader: ${leader}\nkind: ${s.kind}\nmarket: ${s.market}\nside: ${s.side}\n${amounts}note: ${await sha256Hex(s.note)}\nissued: ${s.issuedAt}`;
}

/** The text a leader's caller key signs to open or change its channel: price (atomic USDC), period (days), reveal delay (seconds). */
export const channelMessage = (c: { priceUsdc: string; periodDays: number; revealDelaySec: number; issuedAt: number }) =>
  `Tredio signals channel\nprice: ${c.priceUsdc}\nperiod: ${c.periodDays}\ndelay: ${c.revealDelaySec}\nissued: ${c.issuedAt}`;

/** The on-chain commitment of a signal: SHA-256 of its signed message, as hex. */
export const signalCommitment = async (leader: string, s: Omit<Signal, "leader" | "price">) => sha256Hex(await signalMessage(leader, s));

export const epochOf = (sec: number) => Math.floor(sec / SIGNAL_EPOCH_SEC);

/** The viewing key for `leader`'s signals of week `epoch`: HMAC-SHA256 of the server's secret, as hex. */
export async function viewingKey(secret: Uint8Array, leader: string, epoch: number): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new Uint8Array(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, text(`tredio-signals:v1:${leader}:${epoch}`)));
}

const aesKey = (keyHex: string, use: KeyUsage) => crypto.subtle.importKey("raw", fromHex(keyHex), { name: "AES-GCM" }, false, [use]);

/** Encrypts a signal under its week's viewing key; the commitment is the associated data, so a box moved to another signal does not open. */
export async function sealSignal(keyHex: string, signal: Signal, commitment: string): Promise<{ iv: string; ciphertext: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: text(commitment) }, await aesKey(keyHex, "encrypt"), text(JSON.stringify(signal)));
  return { iv: b64url(iv), ciphertext: b64url(ct) };
}

/** Opens a sealed signal with a viewing key; throws when the key or the commitment is wrong. */
export async function openSignal(keyHex: string, box: { iv: string; ciphertext: string }, commitment: string): Promise<Signal> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(box.iv), additionalData: text(commitment) }, await aesKey(keyHex, "decrypt"), fromB64url(box.ciphertext));
  return JSON.parse(new TextDecoder().decode(pt)) as Signal;
}

/** Whether `signal` still says what was committed: anyone can check a revealed signal against the chain. */
export async function matchesCommitment(signal: Signal, commitment: string): Promise<boolean> {
  return (await signalCommitment(signal.leader, signal)) === commitment;
}

/**
 * The positions a leader's signals add up to, in issue order: an opening on the same side adds to
 * the position (size at the signal's mark, average entry), one on the other side replaces it, and a
 * close ends it. Copy-trading diffs these like a trader's positions, so each new signal becomes a
 * copy for every follower within their own settings.
 */
export function signalHoldings(signals: readonly Signal[]): Map<string, Holding> {
  const held = new Map<string, Holding>();
  for (const s of [...signals].sort((a, b) => a.issuedAt - b.issuedAt)) {
    if (autopilotMarketProblem(s.market)) continue;
    if (s.kind === "close") {
      if (held.get(s.market)?.side === s.side) held.delete(s.market);
      continue;
    }
    if (!s.marginUsdc || !s.leverage || !(s.price > 0)) continue;
    const size = (s.marginUsdc * s.leverage) / s.price;
    const prev = held.get(s.market);
    if (prev && prev.side === s.side) {
      const total = prev.size + size;
      held.set(s.market, { side: s.side, size: total, marginUsdc: prev.marginUsdc + s.marginUsdc, entryPrice: ((prev.entryPrice ?? s.price) * prev.size + s.price * size) / total });
    } else {
      held.set(s.market, { side: s.side, size, marginUsdc: s.marginUsdc, entryPrice: s.price });
    }
  }
  return held;
}
