"use client";
import { useSyncExternalStore } from "react";
import { BACKEND_URL } from "@/src/lib/config";
import { signMessage } from "@/src/lib/wallet/near";
import { ADMIN_RECIPIENT, adminMessage, randomNonce } from "./message";

/**
 * Admin session. The NEAR wallet signs one request (NEP-413), POST /v1/admin/session, and the
 * backend checks it against the account's full-access keys and its allowlist, then answers with a
 * 12 hour bearer token; every later call sends that token instead of a new signature. The
 * token lives in memory and in sessionStorage, so a reload in the same tab keeps the session and
 * a new tab signs in again. The backend checks its allowlist on every request, so any 401 ends
 * the session here too. Signing out revokes the token on the backend, not just in this tab.
 */

export interface Session {
  token: string;
  account: string;
  /** Unix seconds. */
  expiresAt: number;
}

export type SignInProblem =
  | { kind: "not-admin"; account: string; message: string }
  | { kind: "rejected"; message: string }
  | { kind: "clock"; message: string }
  | { kind: "network"; message: string }
  | { kind: "other"; message: string };

export interface SessionState {
  /** False until stored sessions have been read (and always on the server). */
  ready: boolean;
  session: Session | null;
  signingIn: boolean;
  /** A sign-out is revoking the token on the backend. */
  signingOut: boolean;
  problem: SignInProblem | null;
  /** Why the previous session ended, shown on the sign-in screen. */
  notice: string | null;
}

const STORAGE_KEY = "tredio-admin:session";
const SESSION_PATH = "/v1/admin/session";
/** Treat a token as expired slightly early so a request never races its expiry. */
const EXPIRY_MARGIN_SEC = 30;
const SERVER_STATE: SessionState = { ready: false, session: null, signingIn: false, signingOut: false, problem: null, notice: null };
/** Sign-out waits this long for the backend before forgetting the token anyway. */
const REVOKE_TIMEOUT_MS = 5000;

let state: SessionState = SERVER_STATE;
let initialized = false;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function setState(patch: Partial<SessionState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

const nowSec = () => Math.floor(Date.now() / 1000);

function isSession(value: unknown): value is Session {
  const s = value as Partial<Session> | null;
  return (
    typeof s?.token === "string" &&
    s.token.length > 0 &&
    typeof s.account === "string" &&
    /^[a-z0-9._-]{2,64}$/.test(s.account) &&
    typeof s.expiresAt === "number" &&
    Number.isFinite(s.expiresAt)
  );
}

function readStored(): Session | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return isSession(parsed) && parsed.expiresAt - EXPIRY_MARGIN_SEC > nowSec() ? parsed : null;
  } catch {
    return null;
  }
}

function store(session: Session | null) {
  try {
    if (session) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private mode); the session then lasts until a reload.
  }
}

function scheduleExpiry(session: Session | null) {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  if (!session) return;
  const ms = (session.expiresAt - EXPIRY_MARGIN_SEC) * 1000 - Date.now();
  expiryTimer = setTimeout(() => endSession("Your 12 hour session ended. Sign in again to continue."), Math.max(0, ms));
}

function init() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  const session = readStored();
  if (!session) store(null);
  scheduleExpiry(session);
  setState({ ready: true, session });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  init();
  return () => {
    listeners.delete(listener);
  };
}

/** The bearer token for admin requests, or null when signed out. */
export function sessionToken(): string | null {
  return state.session?.token ?? null;
}

/** Forgets the session in this tab, without telling the backend (it already refused or expired the token). */
export function endSession(notice: string | null = null): void {
  store(null);
  scheduleExpiry(null);
  setState({ session: null, signingIn: false, signingOut: false, problem: null, notice });
}

/**
 * Signs out: the backend revokes the token everywhere (POST /v1/admin/session/revoke), then this
 * tab forgets it. A backend that cannot be reached does not keep anyone signed in here.
 */
export async function signOut(notice: string | null = null): Promise<void> {
  const session = state.session;
  if (!session || state.signingOut) return;
  setState({ signingOut: true });
  try {
    await fetch(`${BACKEND_URL}/v1/admin/session/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    });
  } catch {
    // Unreachable or slow: the token is still dropped below and expires on its own.
  }
  // Only the session that was signed out; a sign-in that raced this keeps its new one.
  if (state.session?.token === session.token) endSession(notice);
  else setState({ signingOut: false });
}

/** Ends the session after the backend refused its token. */
export function sessionRejected(reason: string): void {
  if (!state.session) return;
  const account = state.session.account;
  if (/not an admin/i.test(reason)) endSession(`The backend no longer accepts ${account} as an admin account.`);
  else if (/expired/i.test(reason)) endSession("Your session expired. Sign in again to continue.");
  else endSession(`The backend ended your session (${reason}). Sign in again to continue.`);
}

export function clearSignInProblem(): void {
  if (state.problem || state.notice) setState({ problem: null, notice: null });
}

/** The path as the backend sees it, which is what the signature covers. */
function signedPath(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

/** Asks the wallet to sign the session request (NEP-413) and exchanges the signature for a bearer token. */
export async function signIn(account: string): Promise<boolean> {
  if (state.signingIn) return false;
  setState({ signingIn: true, problem: null, notice: null });
  const fail = (problem: SignInProblem) => {
    setState({ signingIn: false, problem });
    return false;
  };

  const url = `${BACKEND_URL}${SESSION_PATH}`;
  const timestamp = nowSec();
  const nonce = randomNonce();
  let signed: { accountId: string; publicKey: string; signature: string };
  try {
    signed = await signMessage(await adminMessage("POST", signedPath(url), timestamp, nonce.base64, ""), ADMIN_RECIPIENT, nonce.bytes);
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : "The wallet could not sign the message.";
    if (/reject|cancel|denied/i.test(message)) return fail({ kind: "rejected", message });
    return fail({ kind: "other", message });
  }
  const signer = signed.accountId || account;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "x-tredio-account": signer, "x-tredio-public-key": signed.publicKey, "x-tredio-timestamp": String(timestamp), "x-tredio-nonce": nonce.base64, "x-tredio-signature": signed.signature },
      cache: "no-store",
    });
  } catch {
    return fail({
      kind: "network",
      message: `Could not reach the backend at ${BACKEND_URL}. Check that it is running and that its FRONTEND_URL lists this origin.`,
    });
  }

  const body: unknown = await res.json().catch(() => null);
  const reason = typeof (body as { error?: unknown } | null)?.error === "string" ? (body as { error: string }).error : null;
  if (res.status === 401) {
    if (reason === "not an admin account") return fail({ kind: "not-admin", account: signer, message: reason });
    if (reason?.startsWith("signature expired")) {
      return fail({ kind: "clock", message: "The backend refused the signature's timestamp. Check that this computer's clock is within 5 minutes of the right time." });
    }
    return fail({ kind: "other", message: `The backend refused the signature: ${reason ?? "unauthorized"}.` });
  }
  if (!res.ok || !isSession(body)) {
    return fail({ kind: "other", message: `The backend could not start a session (${reason ?? `HTTP ${res.status}`}).` });
  }

  store(body);
  scheduleExpiry(body);
  setState({ session: body, signingIn: false, problem: null, notice: null });
  return true;
}

export function useSession(): SessionState {
  return useSyncExternalStore(subscribe, () => state, () => SERVER_STATE);
}
