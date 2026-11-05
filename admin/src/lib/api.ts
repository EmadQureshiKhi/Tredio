import { sessionRejected, sessionToken } from "@/src/lib/auth/session";
import { BACKEND_URL } from "@/src/lib/config";
import type { Candidate, CandidateStatus, DecisionRequest, ElfaReport, Health, JobName, RotationBoard, SystemReport, TrendsResponse, WaitlistPage } from "@/src/types/admin";

/** A failed backend call. `status` is 0 when the backend could not be reached at all. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const unreachable = () => new ApiError(0, `Could not reach the backend at ${BACKEND_URL}.`);

async function errorFrom(res: Response): Promise<ApiError> {
  const body: unknown = await res.json().catch(() => null);
  const reason = (body as { error?: unknown } | null)?.error;
  return new ApiError(res.status, typeof reason === "string" ? reason : `HTTP ${res.status}`);
}

const ok2xx = (status: number) => status >= 200 && status < 300;

/** An admin call with the session's bearer token. A 401 ends the session. */
async function admin<T>(method: "GET" | "POST", path: string, body?: unknown, acceptStatus: (status: number) => boolean = ok2xx): Promise<T> {
  const token = sessionToken();
  if (!token) throw new ApiError(401, "not signed in");
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw unreachable();
  }
  if (res.status === 401) {
    const err = await errorFrom(res);
    sessionRejected(err.message);
    throw err;
  }
  if (!acceptStatus(res.status)) throw await errorFrom(res);
  return (await res.json()) as T;
}

/** An admin file download (CSV) with the session's bearer token, as a blob and its file name. */
async function adminFile(path: string): Promise<{ blob: Blob; name: string }> {
  const token = sessionToken();
  if (!token) throw new ApiError(401, "not signed in");
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}${path}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  } catch {
    throw unreachable();
  }
  if (res.status === 401) {
    const err = await errorFrom(res);
    sessionRejected(err.message);
    throw err;
  }
  if (!res.ok) throw await errorFrom(res);
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "download";
  return { blob: await res.blob(), name };
}

async function publicGet<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}${path}`, { cache: "no-store" });
  } catch {
    throw unreachable();
  }
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()) as T;
}

export const api = {
  candidates: (status: CandidateStatus | null) =>
    admin<{ candidates: Candidate[] }>("GET", `/v1/admin/candidates${status ? `?status=${status}` : ""}`).then((r) => r.candidates),

  decide: (id: number, body: DecisionRequest) => admin<{ candidate: Candidate }>("POST", `/v1/admin/candidates/${id}/decision`, body).then((r) => r.candidate),

  /** Starts a job in the background; false when a run is already in progress. */
  runJob: (job: JobName) => admin<{ started: boolean }>("POST", `/v1/admin/jobs/${job}/run`).then((r) => r.started),

  /** The full health report (public /health only says up or down). A 503 carries the same body: still a reading. */
  health: () => admin<Health>("GET", "/v1/admin/health", undefined, (s) => s === 200 || s === 503),

  /** Everything at once, with what is wrong ranked first. Spends no Elfa credits. */
  system: () => admin<SystemReport>("GET", "/v1/admin/system"),

  /** Checks every Elfa key's status: one credit each, at most once a minute. */
  checkElfaKeys: () => admin<{ check: ElfaReport["lastCheck"] }>("POST", "/v1/admin/system/elfa-check").then((r) => r.check),

  trends: () => publicGet<TrendsResponse>("/v1/trends"),

  /** A page of the Mainnet waitlist, newest first; `q` matches part of an email or account. */
  waitlist: (q: string, offset: number, limit: number) =>
    admin<WaitlistPage>("GET", `/v1/admin/waitlist?${new URLSearchParams({ ...(q ? { q } : {}), offset: String(offset), limit: String(limit) })}`),

  /** Marks signups invited to the beta; returns how many were not invited yet. */
  inviteWaitlist: (ids: number[]) => admin<{ invited: number }>("POST", "/v1/admin/waitlist/invite", { ids }).then((r) => r.invited),

  /** Erases signups for good (deletion requests). */
  deleteWaitlist: (ids: number[]) => admin<{ deleted: number }>("POST", "/v1/admin/waitlist/delete", { ids }).then((r) => r.deleted),

  /** Every signup as CSV. */
  waitlistCsv: () => adminFile("/v1/admin/waitlist.csv"),

  /** The live board: rotation rules, the running rotation, recent ones and each live trend. */
  rotation: () => admin<RotationBoard>("GET", "/v1/admin/rotation"),

  /** Keeps a trend live (rotation never picks it), or lets it rotate again. */
  pin: (identifier: string, pinned: boolean) => admin<{ identifier: string; pinned: boolean }>("POST", "/v1/admin/pins", { identifier, pinned }),

  /** Calls off the running rotation; the oracle resumes updating the trend. */
  cancelRotation: () => admin<{ cancelled: string }>("POST", "/v1/admin/rotation/cancel"),
};
