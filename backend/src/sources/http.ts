/** HTTP helpers shared by the source clients. */

/** Fetch options, plus Bun's per-request `proxy` (an http(s) proxy URL, credentials included). */
export type FetchInit = RequestInit & { proxy?: string };

export type Fetch = (input: string, init?: FetchInit) => Promise<Response>;

export class HttpError extends Error {
  constructor(
    readonly source: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${source}: HTTP ${status}${body ? ` ${body.slice(0, 160)}` : ""}`);
  }
}

/** No key has credits left for this call today. */
export class BudgetError extends Error {
  constructor(readonly source: string) {
    super(`${source}: no API budget left today`);
  }
}

/** Fetches with a timeout and returns the body, throwing HttpError on a non-2xx status. */
export async function fetchText(fetchImpl: Fetch, source: string, url: string, init: FetchInit = {}, timeoutMs = 15_000): Promise<string> {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.text();
  if (!res.ok) throw new HttpError(source, res.status, body);
  return body;
}

export async function fetchJson<T>(fetchImpl: Fetch, source: string, url: string, init: FetchInit = {}, timeoutMs = 15_000): Promise<T> {
  const body = await fetchText(fetchImpl, source, url, init, timeoutMs);
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`${source}: response is not JSON: ${body.slice(0, 160)}`);
  }
}

/** True when a provider refused the key for quota rather than the request itself. */
export function isQuotaError(e: unknown): boolean {
  if (!(e instanceof HttpError)) return false;
  if (e.status === 402) return true;
  return (e.status === 403 || e.status === 429) && /credit|quota|limit|exceeded|insufficient/i.test(e.body);
}

/** True when a provider refused the key itself (invalid, expired or revoked), not the request. */
export function isKeyRejected(e: unknown): boolean {
  if (!(e instanceof HttpError) || isQuotaError(e)) return false;
  return e.status === 401 || (e.status === 403 && /invalid|expired|revoked|unauthori[sz]ed|api key/i.test(e.body));
}

/**
 * True when a provider throttled the request (429 without a quota or credit message): the key is
 * fine, so it rests briefly and the next key takes the call.
 */
export function isThrottled(e: unknown): boolean {
  return e instanceof HttpError && e.status === 429 && !isQuotaError(e);
}

export function query(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter((p): p is [string, string | number] => p[1] !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}
