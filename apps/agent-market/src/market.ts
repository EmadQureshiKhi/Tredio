import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The NEAR AI Agent Market's worker API (https://market.near.ai, `/openapi.json` tags `worker`
 * and `jobs`; the worker skill at `/skill/SKILL.md`). An agent token (`aat_`) pins one agent and
 * can never move money: escrow is the buyer's, and the payout goes to the agent owner's account.
 *
 * - `GET /v1/agents/me/assignments`: the work, each row with its job brief and latest message.
 * - `POST /v1/assignments/{id}/start`: declare the work started (the buyer can no longer cancel).
 * - `POST /v1/assignments/{id}/submit`: the deliverable as Markdown (an A2A call settles then).
 * - `POST /v1/assignments/{id}/decline`: hand it back, `rejected` before any work or `failed`
 *   after; the buyer is refunded in full.
 * - Webhooks (`/skill/reference/webhooks.md`): HMAC-SHA256 over `<timestamp>.<raw body>`.
 */

export type AssignmentStatus = "in_progress" | "submitted" | "accepted" | "disputed" | "dispute_resolved" | "cancelled";
export type JobKind = "standard" | "instant" | "competition";
export type MessageOrigin = "direct" | "axi" | "mcp" | "platform";
export type WorkerCancelReason = "rejected" | "failed";

export interface AttachmentBrief {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  createdAt: string;
  downloadUrl: string;
}

export interface JobAssignment {
  assignmentId: string;
  jobId: string;
  workerAgentId: string;
  status: AssignmentStatus;
  /** Decimal string, for example "25.000000000000". */
  escrowAmount: string;
  escrowToken: string;
  slaSeconds: number;
  slaDeadlineAt: string;
  acceptanceWindowDays: number;
  createdAt: string;
  updatedAt: string;
  bidId?: string | null;
  cancelDetail?: string | null;
  cancelReason?: string | null;
  deliverableHash?: string | null;
  deliverableUrl?: string | null;
  finalizedAt?: string | null;
  startedAt?: string | null;
  submittedAt?: string | null;
}

export interface WorkerJobBrief {
  jobId: string;
  title: string;
  description: string;
  tags: string[];
  jobKind: JobKind;
  status: string;
  attachments: AttachmentBrief[];
  entriesCloseAt?: string | null;
}

export interface LatestMessageBrief {
  senderSide: string;
  origin: MessageOrigin;
  body: string;
  truncated: boolean;
  attachments: AttachmentBrief[];
  createdAt: string;
}

export interface MyAssignmentItem {
  assignment: JobAssignment;
  job: WorkerJobBrief;
  latestMessage?: LatestMessageBrief | null;
  autoAcceptAt?: string | null;
}

/** A refusal of the market's: the HTTP status and its `error` code (`invalid_state_transition`, `unauthorized`...). */
export class MarketError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MarketError";
  }

  /** 5xx, 429 and network failures are worth another try; a 4xx is ours to fix. */
  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export interface MarketApi {
  assignments(status?: AssignmentStatus | "all", limit?: number, offset?: number): Promise<MyAssignmentItem[]>;
  start(assignmentId: string): Promise<{ startedAt: string }>;
  submit(assignmentId: string, deliverableMarkdown: string, files?: string[]): Promise<JobAssignment>;
  decline(assignmentId: string, reason: WorkerCancelReason, detail: string): Promise<JobAssignment>;
}

/** The longest deliverable the market stores (256 KiB). */
export const MAX_DELIVERABLE_BYTES = 256 * 1024;
/** The longest decline detail the buyer is shown. */
export const MAX_DECLINE_DETAIL = 1000;

export class MarketClient implements MarketApi {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 20_000,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new MarketError(0, "unreachable", `the market at ${this.baseUrl} is unreachable: ${String((e as Error).message ?? e)}`);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // A plain-text refusal (the thread routes' 429 answers so); the status says enough.
    }
    if (!res.ok) {
      const e = (json ?? {}) as { error?: unknown; message?: unknown };
      const code = typeof e.error === "string" ? e.error : `http_${res.status}`;
      throw new MarketError(res.status, code, `${method} ${path}: ${res.status} ${code}${typeof e.message === "string" ? `: ${e.message}` : ""}`);
    }
    return json as T;
  }

  async assignments(status: AssignmentStatus | "all" = "in_progress", limit = 50, offset = 0): Promise<MyAssignmentItem[]> {
    const q = new URLSearchParams({ status, limit: String(limit), offset: String(offset) });
    return (await this.call<{ assignments: MyAssignmentItem[] }>("GET", `/v1/agents/me/assignments?${q}`)).assignments;
  }

  start(assignmentId: string): Promise<{ startedAt: string }> {
    return this.call("POST", `/v1/assignments/${encodeURIComponent(assignmentId)}/start`);
  }

  submit(assignmentId: string, deliverableMarkdown: string, files: string[] = []): Promise<JobAssignment> {
    return this.call("POST", `/v1/assignments/${encodeURIComponent(assignmentId)}/submit`, { deliverableMarkdown, files });
  }

  decline(assignmentId: string, reason: WorkerCancelReason, detail: string): Promise<JobAssignment> {
    return this.call("POST", `/v1/assignments/${encodeURIComponent(assignmentId)}/decline`, { reason, detail: detail.slice(0, MAX_DECLINE_DETAIL) });
  }
}

/** What kind of work an `in_progress` row is, read from the row alone as the worker skill says. */
export type RowKind = "fresh" | "rework" | "redo" | "competition";

export function classify(row: MyAssignmentItem): RowKind {
  if (row.job.jobKind === "competition") return "competition";
  const a = row.assignment;
  if (!a.deliverableUrl) return "fresh";
  return a.submittedAt ? "rework" : "redo";
}

/** The webhook headers, lower-cased as HTTP delivers them. */
export const WEBHOOK_HEADERS = { event: "x-market-event", delivery: "x-market-delivery", timestamp: "x-market-timestamp", signature: "x-market-signature" } as const;

/** `sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`, as the market signs a delivery. */
export function webhookSignature(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex")}`;
}

/** Whether a delivery is the market's: the signature over the exact raw body, and a timestamp within `toleranceSec`. */
export function verifyWebhook(secret: string, h: { timestamp: string | null | undefined; signature: string | null | undefined }, rawBody: string, nowSec: number, toleranceSec = 300): boolean {
  if (!h.timestamp || !h.signature || !/^\d{1,12}$/.test(h.timestamp)) return false;
  if (Math.abs(nowSec - Number(h.timestamp)) > toleranceSec) return false;
  const expected = Buffer.from(webhookSignature(secret, h.timestamp, rawBody));
  const given = Buffer.from(h.signature.trim());
  return expected.length === given.length && timingSafeEqual(expected, given);
}
