import type { PrivateIdentity } from "@/lib/account/service";

/**
 * The messages a caller identity signs for calls, posts, its profile, links and sign-in, exactly as
 * the backend rebuilds them (backend/src/social/routes.ts). Free text is committed as its SHA-256
 * so the signed message stays one line per field. The identity signs the UTF-8 text with ed25519.
 */

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const HORIZONS = [86_400, 604_800] as const;
export type Horizon = (typeof HORIZONS)[number];

export async function callMessage(c: { identifier: string; direction: "up" | "down"; horizonSec: Horizon; note: string; issuedAt: number }): Promise<string> {
  return `Tredio call\ntrend: ${c.identifier}\ndirection: ${c.direction}\nhorizon: ${c.horizonSec}\nnote: ${await sha256Hex(c.note)}\nissued: ${c.issuedAt}`;
}

export async function postMessage(p: { identifier: string; body: string; replyTo: number | null; callId: number | null; issuedAt: number }): Promise<string> {
  return `Tredio post\ntrend: ${p.identifier}\nreply: ${p.replyTo ?? "none"}\ncall: ${p.callId ?? "none"}\nbody: ${await sha256Hex(p.body)}\nissued: ${p.issuedAt}`;
}

export async function profileMessage(p: { handle: string; bio: string; issuedAt: number }): Promise<string> {
  return `Tredio profile\nhandle: ${p.handle}\nbio: ${await sha256Hex(p.bio)}\nissued: ${p.issuedAt}`;
}

export const linkMessage = (identity: string, account: string, issuedAt: number) => `Tredio link\nidentity: ${identity.toLowerCase()}\naccount: ${account.toLowerCase()}\nissued: ${issuedAt}`;
export const identitySignInMessage = (identity: string, issuedAt: number) => `Tredio identity sign-in\nidentity: ${identity.toLowerCase()}\nissued: ${issuedAt}`;

/** Signs `message` with the caller identity, stamped now. */
export async function signAsCaller(identity: PrivateIdentity, build: (issuedAt: number) => Promise<string> | string): Promise<{ caller: string; issuedAt: number; signature: string }> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const signature = await identity.sign(await build(issuedAt));
  return { caller: identity.id, issuedAt, signature };
}
