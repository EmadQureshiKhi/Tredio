import { BACKEND_URL } from "@/lib/config";
import { rateLimitMessage, retryAfterSec } from "@/lib/rate-limit";

/** The backend's JSON API. Errors carry the backend's own message. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The response body, for endpoints that explain a failure in it (status answers 503 with details). */
    readonly body: unknown = null,
    /** Seconds the backend asked to wait (Retry-After), on a 429. */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
  }
}

let userToken: string | null = null;
/** Set by the account layer after signing in to the backend. */
export function setUserToken(token: string | null) {
  userToken = token;
}
export const hasUserToken = () => userToken !== null;

/**
 * How the account layer signs in again without a prompt (with the trading session key). A signed-in
 * call that gets 401 (the token's session key was revoked or replaced, or the token expired) signs
 * in once more and retries; concurrent failures share one sign-in.
 */
let reauth: (() => Promise<string | null>) | null = null;
let reauthing: Promise<string | null> | null = null;
export function setReauth(fn: (() => Promise<string | null>) | null) {
  reauth = fn;
}
async function freshToken(): Promise<string | null> {
  if (!reauth) return null;
  reauthing ??= reauth()
    .catch(() => null)
    .finally(() => {
      reauthing = null;
    });
  return reauthing;
}

const toJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

type Init = { method?: string; body?: unknown; auth?: boolean; token?: string; signal?: AbortSignal };

export async function api<T>(path: string, init: Init = {}): Promise<T> {
  try {
    return await request<T>(path, init);
  } catch (e) {
    // A user token the backend no longer accepts: sign in again once, then retry.
    if (!(e instanceof ApiError) || e.status !== 401 || !init.auth || init.token) throw e;
    const token = await freshToken();
    if (!token) throw e;
    return request<T>(path, init);
  }
}

async function request<T>(path: string, init: Init): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const token = init.token ?? (init.auth ? userToken : null);
  if (init.auth && !token) throw new ApiError(401, "Sign in first.");
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}${path}`, { method: init.method ?? (init.body === undefined ? "GET" : "POST"), headers, body: init.body === undefined ? undefined : toJson(init.body), signal: init.signal });
  } catch {
    throw new ApiError(0, "Tredio is unreachable. Check your connection and try again.");
  }
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (res.status === 429) {
    // Limits are per address and per account; say why and when to try again, in plain words.
    const wait = retryAfterSec(res.headers.get("retry-after"));
    throw new ApiError(429, rateLimitMessage(body?.error, wait), body, wait);
  }
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`, body);
  return body as T;
}
