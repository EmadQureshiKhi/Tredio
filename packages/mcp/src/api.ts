/**
 * The Tredio public API (`TREDIO_API_URL`, the backend in `backend/src/api/app.ts`): JSON over
 * HTTP, read with a timeout. Errors carry the API's own message.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class TredioApi {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 20_000,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /** GET `path`; a 503 from /v1/status still carries the status body, so it is returned. */
  async get<T>(path: string, opts: { okStatuses?: number[] } = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new ApiError(0, `the Tredio API at ${this.baseUrl} is unreachable: ${String((e as Error).message ?? e)}`);
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new ApiError(res.status, `the Tredio API answered ${res.status} with a body that is not JSON`);
    }
    if (!res.ok && !(opts.okStatuses ?? []).includes(res.status)) {
      const message = (body as { error?: unknown } | null)?.error;
      throw new ApiError(res.status, typeof message === "string" ? message : `the Tredio API answered ${res.status}`);
    }
    return body as T;
  }
}
