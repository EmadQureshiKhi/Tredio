import { ADMIN_RECIPIENT, adminMessage, randomNonce } from "../../src/lib/auth/message";
import { type NearKey, signNep413 } from "./wallet";
import type { Candidate, CandidateStatus, DecisionRequest, Health, SystemReport, WaitlistPage } from "../../src/types/admin";

/** The real local backend the panel talks to. */
export const BACKEND_URL = (process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000").replace(/\/+$/, "");

/**
 * Admin API access from the test process, signed with the same message builder the panel uses.
 * Tests use it to find fixtures, to check what the UI did, and to put rows back afterwards.
 */
export class AdminApi {
  private token: string | null = null;

  constructor(private readonly account: NearKey) {}

  /** A fresh bearer token, as the panel gets one when the wallet signs in. */
  async freshSession(): Promise<{ token: string; account: string; expiresAt: number }> {
    const path = "/v1/admin/session";
    const ts = Math.floor(Date.now() / 1000);
    const nonce = randomNonce();
    const signature = signNep413(this.account, await adminMessage("POST", path, ts, nonce.base64, ""), ADMIN_RECIPIENT, nonce.bytes);
    const res = await fetch(`${BACKEND_URL}${path}`, {
      method: "POST",
      headers: { "x-tredio-account": this.account.accountId, "x-tredio-public-key": this.account.publicKey, "x-tredio-timestamp": String(ts), "x-tredio-nonce": nonce.base64, "x-tredio-signature": signature },
    });
    if (!res.ok) throw new Error(`admin session failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as { token: string; account: string; expiresAt: number };
  }

  private async session(): Promise<string> {
    this.token ??= (await this.freshSession()).token;
    return this.token;
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown, okStatus = (s: number) => s >= 200 && s < 300): Promise<T> {
    const res = await fetch(`${BACKEND_URL}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.session()}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!okStatus(res.status)) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  /** The full report from /v1/admin/health (503 still carries it). */
  health(): Promise<Health> {
    return this.call<Health>("GET", "/v1/admin/health", undefined, (s) => s === 200 || s === 503);
  }

  /** The system report from /v1/admin/system (it spends no Elfa credits). */
  system(): Promise<SystemReport> {
    return this.call<SystemReport>("GET", "/v1/admin/system");
  }

  candidates(status: CandidateStatus | null): Promise<Candidate[]> {
    return this.call<{ candidates: Candidate[] }>("GET", `/v1/admin/candidates${status ? `?status=${status}` : ""}`).then((r) => r.candidates);
  }

  async candidate(id: number): Promise<Candidate> {
    const row = (await this.candidates(null)).find((c) => c.id === id);
    if (!row) throw new Error(`candidate ${id} not found`);
    return row;
  }

  decide(id: number, body: DecisionRequest): Promise<Candidate> {
    return this.call<{ candidate: Candidate }>("POST", `/v1/admin/candidates/${id}/decision`, body).then((r) => r.candidate);
  }

  /** Waitlist signups whose email or account contains `q`. */
  waitlist(q: string): Promise<WaitlistPage> {
    return this.call<WaitlistPage>("GET", `/v1/admin/waitlist?q=${encodeURIComponent(q)}`);
  }

  /** Erases signups by id: a test removes only the rows it made. */
  deleteWaitlist(ids: number[]): Promise<number> {
    return this.call<{ deleted: number }>("POST", "/v1/admin/waitlist/delete", { ids }).then((r) => r.deleted);
  }

  /** Puts a candidate's status and editable fields back to a snapshot taken before a test. */
  restore(snapshot: Candidate): Promise<Candidate> {
    if (snapshot.status !== "approved" && snapshot.status !== "rejected") throw new Error(`cannot restore a ${snapshot.status} candidate through the API`);
    return this.decide(snapshot.id, {
      decision: snapshot.status === "approved" ? "approve" : "reject",
      identifier: snapshot.identifier,
      displayName: snapshot.displayName,
      keywords: snapshot.keywords,
      article: snapshot.article,
      ...(snapshot.summary !== null ? { summary: snapshot.summary } : {}),
    });
  }
}

/** Signs a session token out on the backend. */
export async function revokeToken(token: string): Promise<void> {
  await fetch(`${BACKEND_URL}/v1/admin/session/revoke`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
}

/** What the backend answers for a bearer token, e.g. after the panel signed out. */
export async function tokenStatus(token: string): Promise<{ status: number; error?: string }> {
  const res = await fetch(`${BACKEND_URL}/v1/admin/candidates?status=live`, { headers: { authorization: `Bearer ${token}` } });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return { status: res.status, error: body.error };
}

/** Base identifiers of every trend on chain, live or not. */
export async function liveIdentifiers(): Promise<Set<string>> {
  const res = await fetch(`${BACKEND_URL}/v1/trends?all=1`);
  const body = (await res.json()) as { trends: Array<{ identifier: string }> };
  return new Set(body.trends.map((t) => t.identifier.replace(/\.([2-9])$/, "")));
}

/** Joins the waitlist as the website does, from the test process. */
export async function joinWaitlist(email: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/v1/waitlist`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, source: "landing", consent: true }) });
  if (!res.ok) throw new Error(`joining the waitlist failed: ${res.status} ${await res.text()}`);
}
