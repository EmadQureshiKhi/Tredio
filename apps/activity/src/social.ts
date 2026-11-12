import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";

/**
 * Calls, thread posts and profiles signed by a caller identity, in the messages the API checks
 * (backend/src/social/routes.ts): ed25519 over the UTF-8 text, base64, with the public key in hex as
 * the caller's address.
 */

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export const callMessage = (c: { identifier: string; direction: string; horizonSec: number; note: string; issuedAt: number }) =>
  `Tredio call\ntrend: ${c.identifier}\ndirection: ${c.direction}\nhorizon: ${c.horizonSec}\nnote: ${sha256(c.note)}\nissued: ${c.issuedAt}`;
export const postMessage = (p: { identifier: string; body: string; replyTo: number | null; callId: number | null; issuedAt: number }) =>
  `Tredio post\ntrend: ${p.identifier}\nreply: ${p.replyTo ?? "none"}\ncall: ${p.callId ?? "none"}\nbody: ${sha256(p.body)}\nissued: ${p.issuedAt}`;
export const profileMessage = (p: { handle: string; bio: string; issuedAt: number }) => `Tredio profile\nhandle: ${p.handle}\nbio: ${sha256(p.bio)}\nissued: ${p.issuedAt}`;

export function identityOf(seedHex: string): string {
  return Buffer.from(ed25519.getPublicKey(Buffer.from(seedHex, "hex"))).toString("hex");
}

export function sign(seedHex: string, message: string): string {
  return Buffer.from(ed25519.sign(new TextEncoder().encode(message), Buffer.from(seedHex, "hex"))).toString("base64");
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Posts signed social writes to the API as one caller. */
export class Caller {
  readonly address: string;
  constructor(
    private readonly seedHex: string,
    private readonly api: string,
    private readonly fetchImpl: Fetch = fetch,
    private readonly nowSec: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.address = identityOf(seedHex);
  }

  private async send<T>(method: "POST" | "PUT", path: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(`${this.api}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${json.error ?? ""}`.trim());
    return json;
  }

  profile(handle: string, bio: string) {
    const issuedAt = this.nowSec();
    return this.send("PUT", "/v1/callers/me", { caller: this.address, handle, bio, issuedAt, signature: sign(this.seedHex, profileMessage({ handle, bio, issuedAt })) });
  }

  call(c: { identifier: string; direction: "up" | "down"; horizonSec: number; note: string }) {
    const issuedAt = this.nowSec();
    return this.send<{ call: { id: number } }>("POST", "/v1/calls", { caller: this.address, ...c, issuedAt, signature: sign(this.seedHex, callMessage({ ...c, issuedAt })) });
  }

  post(p: { identifier: string; body: string; callId: number | null }) {
    const issuedAt = this.nowSec();
    const m = { identifier: p.identifier, body: p.body, replyTo: null, callId: p.callId, issuedAt };
    return this.send<{ post: { id: number } }>("POST", "/v1/posts", { caller: this.address, ...m, signature: sign(this.seedHex, postMessage(m)) });
  }
}
