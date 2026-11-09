/**
 * A local stand-in for the NEAR AI Agent Market, for trial hires without a live listing: the
 * market has no testnet or sandbox (its x402 payee list, `GET /.well-known/x402`, names only
 * `near:mainnet`). It follows the documented shapes exactly, for the parts this agent touches:
 *
 * - The agent's A2A host (`/skill/x402-caller/SKILL.md`): `/.well-known/agent-card.json`,
 *   `/.well-known/x402`, and JSON-RPC at `/a2a/v1` (`SendMessage`, `GetTask`, `CancelTask`). An
 *   unpaid `SendMessage` answers HTTP 402 with the x402 v2 `exact` row; a paid one (`X-PAYMENT`)
 *   is verified, held as the escrow, opens an instant hire, and waits up to 60 s for the result.
 * - The worker REST API (`/openapi.json`, tag `worker`): `GET /v1/agents/me/assignments`,
 *   `POST /v1/assignments/{id}/start|submit|decline`, behind `Authorization: Bearer aat_...`.
 * - Signed webhooks (`/skill/reference/webhooks.md`): `hire.created`, `hire.accepted`,
 *   `hire.refunded`, HMAC-SHA256 over `<timestamp>.<raw body>`.
 *
 * Payment is settled only when the agent delivers, as the market does for an A2A call. Where the
 * real market pays the caller's USDC on NEAR mainnet into its treasury, `nearFacilitator` settles
 * on NEAR testnet: a relayer submits the caller's signed `ft_transfer` (NEP-366 delegate action)
 * of test USDC, and the transfer is checked in the receipts.
 *
 * Differences from the real market, by design: one agent, its A2A host and the REST API on one
 * origin (the market serves the A2A host at `<handle>.market.near.ai`), webhooks to any URL (the
 * market refuses loopback addresses), and no accounts, bids, threads or files.
 *
 *   STANDIN_PORT=4890 bun scripts/standin.ts   # prints the agent token to give the worker
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { failureOf, type Sender, TxError, timeoutBlocks, type Viewer } from "@tredio/chain";
import { deployment, parseEvents } from "@tredio/contracts";
import { type Context, Hono } from "hono";
import { DELEGATE_ACTION_PREFIX, decodeSignedDelegateAction, type FinalExecutionOutcome } from "near-kit";
import { microUsdc } from "../src/config";
import { type JobAssignment, type LatestMessageBrief, MAX_DELIVERABLE_BYTES, type MyAssignmentItem, webhookSignature, type WorkerJobBrief } from "../src/market";

/** One `accepts[]` row of a 402, as the caller must sign it verbatim. */
export interface PaymentRow {
  scheme: "exact";
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
}

/** The `X-PAYMENT` header's JSON (base64 on the wire). */
export interface PaymentHeader {
  x402Version: number;
  accepted: PaymentRow;
  payload: { signedDelegateAction: string };
  resource?: unknown;
}

export type Verified = { ok: true; payer: string } | { ok: false; reason: string };
export type Settled = { ok: true; transaction: string; payer: string } | { ok: false; reason: string; transaction?: string };

/** The market's payment facilitator: checks a payment when the call comes in, moves the money at delivery. */
export interface Facilitator {
  verify(p: PaymentHeader, row: PaymentRow): Promise<Verified>;
  settle(p: PaymentHeader, row: PaymentRow): Promise<Settled>;
}

export type TaskState = "TASK_STATE_SUBMITTED" | "TASK_STATE_WORKING" | "TASK_STATE_COMPLETED" | "TASK_STATE_REJECTED" | "TASK_STATE_FAILED" | "TASK_STATE_CANCELED";

export interface Task {
  id: string;
  contextId: string;
  /** `message`: the agent's word on a refusal (A2A TaskStatus). */
  status: { state: TaskState; timestamp: string; message?: { role: "ROLE_AGENT"; parts: Array<{ text: string }> } };
  artifacts?: Array<{ artifactId: string; name: string; parts: Array<{ text: string }> }>;
}

export interface StandinOptions {
  /** The agent's API token (`aat_` and 32 hex characters). */
  token: string;
  agent: { agentId: string; handle: string; name: string; description: string; tags: string[] };
  /** The default pricing plan: price in USD (paid 1:1 in USDC) and its window. */
  plan: { priceAmount: string; slaSeconds: number };
  payment: { network: string; asset: string; payTo: string };
  facilitator: Facilitator;
  /** The origin the card names. */
  baseUrl: string;
  webhook?: { url: string; secret: string } | null;
  /** How long a paid `SendMessage` waits for the result (the market: about 60 s). */
  holdMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  log?: (fields: Record<string, unknown>, msg: string) => void;
}

interface Hire {
  hireId: string;
  job: WorkerJobBrief;
  assignment: JobAssignment;
  latestMessage: LatestMessageBrief | null;
  task: Task | null;
  payment: { header: PaymentHeader; row: PaymentRow; payer: string } | null;
  deliverable: string | null;
  settlement: Settled | null;
  waiters: Array<() => void>;
}

export interface SettlementRecord {
  assignmentId: string;
  taskId: string | null;
  payer: string;
  amount: string;
  asset: string;
  payTo: string;
  transaction: string;
}

const TERMINAL: readonly TaskState[] = ["TASK_STATE_COMPLETED", "TASK_STATE_REJECTED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED"];
const STATUSES = ["in_progress", "submitted", "accepted", "disputed", "dispute_resolved", "cancelled"];
/** The A2A window: the plan's SLA plus 10 minutes, so the payment stays valid until delivery. */
export const TIMEOUT_MARGIN_SEC = 600;

/** "0.05" as the market writes an escrow amount: "0.050000000000" (12 decimals). */
export function escrowString(priceAmount: string): string {
  const m = microUsdc(priceAmount);
  return `${m / 1_000_000n}.${(m % 1_000_000n).toString().padStart(6, "0")}000000`;
}

/** Stable JSON for comparing a signed row with the quoted one. */
const canonical = (v: unknown): string => (Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v));

export function createStandin(o: StandinOptions) {
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});
  const fetchImpl = o.fetchImpl ?? fetch;
  const hires = new Map<string, Hire>();
  const tasks = new Map<string, string>();
  const usedPayments = new Set<string>();
  const settlements: SettlementRecord[] = [];
  const webhooks: Array<{ event: string; body: Record<string, unknown>; status: number | null }> = [];
  let webhook = o.webhook ?? null;
  const iso = () => new Date(now()).toISOString();

  const row = (): PaymentRow => ({
    scheme: "exact",
    network: o.payment.network,
    asset: o.payment.asset,
    amount: microUsdc(o.plan.priceAmount).toString(),
    payTo: o.payment.payTo,
    maxTimeoutSeconds: o.plan.slaSeconds + TIMEOUT_MARGIN_SEC,
  });

  const send = async (event: string, body: Record<string, unknown>) => {
    if (!webhook) return;
    const raw = JSON.stringify({ event, ...body });
    const ts = String(Math.floor(now() / 1000));
    const record = { event, body: { event, ...body }, status: null as number | null };
    webhooks.push(record);
    try {
      const res = await fetchImpl(webhook.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-market-event": event, "x-market-delivery": randomUUID(), "x-market-timestamp": ts, "x-market-signature": webhookSignature(webhook.secret, ts, raw) },
        body: raw,
        signal: AbortSignal.timeout(10_000),
      });
      record.status = res.status;
    } catch (e) {
      log({ event, error: String((e as Error).message ?? e) }, "webhook delivery failed");
    }
  };

  const wake = (h: Hire) => {
    for (const w of h.waiters.splice(0)) w();
  };
  const setTask = (h: Hire, state: TaskState) => {
    if (!h.task) return;
    h.task.status = { state, timestamp: iso() };
    if (TERMINAL.includes(state)) wake(h);
  };
  const touch = (h: Hire) => (h.assignment.updatedAt = iso());

  /** Opens a hire: from a paid A2A call, or directly (a board award or an owner's free test run). */
  const open = (brief: { title: string; description: string; tags?: string[]; escrowAmount?: string; escrowToken?: string; message?: string | null }, payment: Hire["payment"], withTask: boolean): Hire => {
    const at = iso();
    const hireId = randomUUID();
    const jobId = randomUUID();
    const assignmentId = randomUUID();
    const sla = o.plan.slaSeconds;
    const h: Hire = {
      hireId,
      job: { jobId, title: brief.title, description: brief.description, tags: brief.tags ?? [], jobKind: "instant", status: "in_progress", attachments: [], entriesCloseAt: null },
      assignment: {
        assignmentId,
        jobId,
        workerAgentId: o.agent.agentId,
        status: "in_progress",
        escrowAmount: brief.escrowAmount ?? escrowString(o.plan.priceAmount),
        escrowToken: brief.escrowToken ?? "USDC",
        slaSeconds: sla,
        slaDeadlineAt: new Date(now() + sla * 1000).toISOString(),
        acceptanceWindowDays: 3,
        createdAt: at,
        updatedAt: at,
        bidId: null,
        cancelDetail: null,
        cancelReason: null,
        deliverableHash: null,
        deliverableUrl: null,
        finalizedAt: null,
        startedAt: null,
        submittedAt: null,
      },
      latestMessage: brief.message ? { senderSide: "buyer", origin: "direct", body: brief.message.slice(0, 4000), truncated: brief.message.length > 4000, attachments: [], createdAt: at } : null,
      task: withTask ? { id: randomUUID(), contextId: hireId, status: { state: "TASK_STATE_SUBMITTED", timestamp: at } } : null,
      payment,
      deliverable: null,
      settlement: null,
      waiters: [],
    };
    hires.set(assignmentId, h);
    if (h.task) tasks.set(h.task.id, assignmentId);
    void send("hire.created", {
      job_id: jobId,
      assignment_id: assignmentId,
      bid_id: null,
      hire_id: hireId,
      title: brief.title,
      description: brief.description,
      tags: brief.tags ?? [],
      amount: h.assignment.escrowAmount,
      token: h.assignment.escrowToken,
      sla_seconds: sla,
      sla_deadline_at: h.assignment.slaDeadlineAt,
      attachments: [],
      kind: "instant",
    });
    return h;
  };

  const app = new Hono();

  // --- The agent's A2A host -------------------------------------------------------------------
  app.get("/.well-known/x402", (c) => c.json({ x402Version: 2, recipients: [{ network: o.payment.network, asset: o.payment.asset, payTo: o.payment.payTo }] }));
  app.get("/.well-known/agent-card.json", (c) =>
    c.json({
      name: o.agent.name,
      description: `${o.agent.description}\n\nPaid per call with x402: SendMessage answers 402 with the price, or a JSON-RPC error saying why it cannot take the call; payees are published at ${o.baseUrl}/.well-known/x402.`,
      version: iso(),
      supportedInterfaces: [{ url: `${o.baseUrl}/a2a/v1`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
      capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/markdown", "application/json"],
      skills: [{ id: o.agent.handle, name: o.agent.name, description: o.agent.description, tags: o.agent.tags }],
      provider: { organization: "Tredio", url: `${o.baseUrl}/a/${o.agent.handle}` },
      documentationUrl: `${o.baseUrl}/a/${o.agent.handle}`,
    }),
  );

  const rpcError = (c: Context, id: unknown, code: number, message: string) => c.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  app.post("/a2a/v1", async (c) => {
    const raw = await c.req.text();
    if (raw.length > 256 * 1024) return c.json({ error: "body over 256 KiB" }, 413);
    let req: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      req = JSON.parse(raw) as typeof req;
    } catch {
      return rpcError(c, null, -32700, "parse error");
    }
    const p = req.params ?? {};
    if (req.method === "GetTask") {
      const h = hires.get(tasks.get(String(p.id)) ?? "");
      return h?.task ? c.json({ jsonrpc: "2.0", id: req.id, result: h.task }) : rpcError(c, req.id, -32001, "task not found");
    }
    if (req.method === "CancelTask") {
      const h = hires.get(tasks.get(String(p.id)) ?? "");
      if (!h?.task) return rpcError(c, req.id, -32001, "task not found");
      if (h.task.status.state !== "TASK_STATE_SUBMITTED") return rpcError(c, req.id, -32002, "task not cancelable");
      Object.assign(h.assignment, { status: "cancelled", cancelReason: "buyer_cancelled", finalizedAt: iso() });
      touch(h);
      setTask(h, "TASK_STATE_CANCELED");
      void send("hire.refunded", { job_id: h.job.jobId, assignment_id: h.assignment.assignmentId, amount: h.assignment.escrowAmount, token: h.assignment.escrowToken, reason: "buyer_cancelled" });
      return c.json({ jsonrpc: "2.0", id: req.id, result: h.task });
    }
    if (req.method === "SendStreamingMessage" || req.method === "ListTasks") return rpcError(c, req.id, -32004, "not supported: use SendMessage and GetTask");
    if (req.method !== "SendMessage") return rpcError(c, req.id, -32601, "method not found");
    const message = (p.message ?? {}) as { parts?: Array<{ text?: unknown }>; taskId?: unknown };
    const text = (message.parts ?? []).flatMap((part) => (typeof part.text === "string" ? [part.text] : [])).join("\n").trim();
    if (!text) return rpcError(c, req.id, -32602, "message.parts holds no text");
    if (message.taskId !== undefined) return rpcError(c, req.id, -32602, "a task cannot be continued: send a new message");
    const quote = row();
    const required = (error: string) => c.json({ x402Version: 2, error, accepts: [quote] }, 402);
    const header = c.req.header("x-payment");
    if (!header) return required("x-payment header is required");
    let payment: PaymentHeader;
    try {
      payment = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as PaymentHeader;
    } catch {
      return required("the x-payment header is not base64 JSON");
    }
    if (payment.x402Version !== 2) return required("x402Version must be 2");
    if (canonical(payment.accepted) !== canonical(quote)) return required("accepted is not the quoted row: sign the accepts[] row verbatim");
    const sda = payment.payload?.signedDelegateAction;
    if (typeof sda !== "string") return required("payload.signedDelegateAction is missing");
    const key = createHash("sha256").update(sda).digest("hex");
    if (usedPayments.has(key)) return required("this x-payment header was already used");
    const verified = await o.facilitator.verify(payment, quote);
    if (!verified.ok) return required(verified.reason);
    usedPayments.add(key);
    const [title = "", ...rest] = text.split("\n");
    const h = open({ title: title.trim().slice(0, 200), description: rest.join("\n").trim(), message: text }, { header: payment, row: quote, payer: verified.payer }, true);
    log({ assignment: h.assignment.assignmentId, task: h.task!.id, payer: verified.payer, amount: quote.amount }, "paid call opened a hire");
    const configuration = (p.configuration ?? {}) as { returnImmediately?: unknown };
    if (configuration.returnImmediately !== true) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, o.holdMs ?? 60_000);
        h.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return c.json({ jsonrpc: "2.0", id: req.id, result: { task: h.task } });
  });

  // --- The worker REST API --------------------------------------------------------------------
  app.use("/v1/*", async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    if (auth !== `Bearer ${o.token}`) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  const item = (h: Hire): MyAssignmentItem => ({ assignment: { ...h.assignment }, job: { ...h.job }, latestMessage: h.latestMessage, autoAcceptAt: null });

  app.get("/v1/agents/me/assignments", (c) => {
    const status = c.req.query("status") ?? "in_progress";
    if (status !== "all" && !STATUSES.includes(status)) return c.json({ error: "validation_error", message: `invalid status filter: ${status}` }, 400);
    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) return c.json({ error: "validation_error", message: "limit is 1..=100 and offset at least 0" }, 400);
    const rows = [...hires.values()]
      .filter((h) => status === "all" || h.assignment.status === status)
      .sort((a, b) => b.assignment.createdAt.localeCompare(a.assignment.createdAt))
      .slice(offset, offset + limit)
      .map(item);
    return c.json({ assignments: rows });
  });

  app.post("/v1/assignments/:id/start", (c) => {
    const h = hires.get(c.req.param("id"));
    if (!h) return c.json({ error: "not_found" }, 404);
    if (!h.assignment.startedAt) {
      if (h.assignment.status !== "in_progress") return c.json({ error: "invalid_state_transition", message: `cannot transition from '${h.assignment.status}' to 'started'` }, 400);
      h.assignment.startedAt = iso();
      touch(h);
      setTask(h, "TASK_STATE_WORKING");
    }
    return c.json({ startedAt: h.assignment.startedAt });
  });

  app.post("/v1/assignments/:id/submit", async (c) => {
    const h = hires.get(c.req.param("id"));
    if (!h) return c.json({ error: "not_found" }, 404);
    const body = (await c.req.json().catch(() => null)) as { deliverableMarkdown?: unknown; files?: unknown } | null;
    if (!body || typeof body.deliverableMarkdown !== "string") return c.json({ error: "unprocessable", message: "deliverableMarkdown is required" }, 422);
    const md = body.deliverableMarkdown;
    if (md.length === 0 || Buffer.byteLength(md) > MAX_DELIVERABLE_BYTES) return c.json({ error: "invalid_deliverable", message: "the deliverable is 1 byte to 256 KiB of Markdown" }, 400);
    if (h.assignment.status !== "in_progress" && h.assignment.status !== "submitted") return c.json({ error: "invalid_state_transition", message: `cannot transition from '${h.assignment.status}' to 'submitted'` }, 400);
    // An identical resend is a no-op.
    if (h.deliverable === md && h.assignment.status === "submitted") return c.json(h.assignment);
    h.deliverable = md;
    Object.assign(h.assignment, { status: "submitted", submittedAt: iso(), deliverableHash: createHash("sha256").update(md).digest("hex"), deliverableUrl: `${o.baseUrl}/v1/assignments/${h.assignment.assignmentId}/deliverable/raw` });
    touch(h);
    if (h.payment) {
      // An A2A call: the submit is accepted at once, and the held payment settles now.
      const s = await o.facilitator.settle(h.payment.header, h.payment.row);
      h.settlement = s;
      if (s.ok) {
        settlements.push({ assignmentId: h.assignment.assignmentId, taskId: h.task?.id ?? null, payer: s.payer, amount: h.payment.row.amount, asset: h.payment.row.asset, payTo: h.payment.row.payTo, transaction: s.transaction });
        Object.assign(h.assignment, { status: "accepted", finalizedAt: iso() });
        if (h.task) h.task.artifacts = [{ artifactId: randomUUID(), name: "answer", parts: [{ text: md }] }];
        setTask(h, "TASK_STATE_COMPLETED");
        log({ assignment: h.assignment.assignmentId, transaction: s.transaction }, "delivered and settled");
        void send("hire.accepted", { job_id: h.job.jobId, assignment_id: h.assignment.assignmentId });
      } else {
        setTask(h, "TASK_STATE_FAILED");
        log({ assignment: h.assignment.assignmentId, reason: s.reason, transaction: s.transaction ?? null }, "settlement failed");
        void send("hire.refunded", { job_id: h.job.jobId, assignment_id: h.assignment.assignmentId, amount: h.assignment.escrowAmount, token: h.assignment.escrowToken, reason: "payment_refused" });
      }
    }
    return c.json(h.assignment);
  });

  app.post("/v1/assignments/:id/decline", async (c) => {
    const h = hires.get(c.req.param("id"));
    if (!h) return c.json({ error: "not_found" }, 404);
    const body = (await c.req.json().catch(() => null)) as { reason?: unknown; detail?: unknown } | null;
    const reason = body?.reason;
    if (reason !== "rejected" && reason !== "failed") return c.json({ error: "validation_error", message: "reason is rejected or failed" }, 400);
    if (h.assignment.status !== "in_progress") return c.json({ error: "invalid_state_transition", message: `cannot transition from '${h.assignment.status}' to 'cancelled'` }, 400);
    if (reason === "rejected" && h.assignment.deliverableUrl) return c.json({ error: "invalid_state_transition", message: "rejected is refused after a delivery: use failed" }, 400);
    const detail = typeof body?.detail === "string" ? body.detail.slice(0, 1000) : null;
    Object.assign(h.assignment, { status: "cancelled", cancelReason: reason, cancelDetail: detail, finalizedAt: iso() });
    touch(h);
    setTask(h, reason === "rejected" ? "TASK_STATE_REJECTED" : "TASK_STATE_FAILED");
    if (h.task && detail) h.task.status.message = { role: "ROLE_AGENT", parts: [{ text: detail }] };
    void send("hire.refunded", { job_id: h.job.jobId, assignment_id: h.assignment.assignmentId, amount: h.assignment.escrowAmount, token: h.assignment.escrowToken, reason });
    return c.json(h.assignment);
  });

  return {
    app,
    settlements,
    webhooks,
    quote: row,
    setWebhook(w: { url: string; secret: string } | null) {
      webhook = w;
    },
    /** An instant hire without an A2A call: a board award, or an owner's free test run with `escrowAmount: "0"`. */
    hire(brief: { title: string; description: string; tags?: string[]; escrowAmount?: string; escrowToken?: string }) {
      return item(open(brief, null, false));
    },
    /** The buyer sends a delivered (not yet accepted) assignment back with a note. */
    requestChanges(assignmentId: string, note: string) {
      const h = hires.get(assignmentId);
      if (!h || h.assignment.status !== "submitted") throw new Error("only a submitted assignment can be sent back");
      h.assignment.status = "in_progress";
      h.assignment.slaDeadlineAt = new Date(now() + o.plan.slaSeconds * 1000).toISOString();
      h.latestMessage = { senderSide: "buyer", origin: "direct", body: note, truncated: false, attachments: [], createdAt: iso() };
      touch(h);
      void send("hire.changes_requested", { job_id: h.job.jobId, assignment_id: assignmentId });
    },
    assignment(assignmentId: string) {
      const h = hires.get(assignmentId);
      return h ? { ...item(h), deliverable: h.deliverable, task: h.task, settlement: h.settlement } : null;
    },
    task(taskId: string) {
      return hires.get(tasks.get(taskId) ?? "")?.task ?? null;
    },
  };
}

export type Standin = ReturnType<typeof createStandin>;

/** A fresh agent token in the market's format. */
export const newAgentToken = () => `aat_${randomBytes(16).toString("hex")}`;

/** The most gas a payment may ask the relayer to prepay (the x402 NEAR reference default, 100 Tgas). */
const MAX_PAYMENT_GAS = 100n * 10n ** 12n;

/**
 * The facilitator on NEAR testnet: verifies a payment as one ed25519-signed NEP-366 delegate
 * action holding exactly one `ft_transfer` of the quoted amount to `payTo`, unexpired and inside
 * the quoted window, by a payer holding the amount; settles it by having `relayer` submit it and
 * checking the token's `ft_transfer` event in the receipts.
 */
export function nearFacilitator(o: { viewer: Viewer; relayer: Sender }): Facilitator {
  const decode = (p: PaymentHeader) => {
    const bytes = new Uint8Array(Buffer.from(p.payload.signedDelegateAction, "base64"));
    return { bytes, decoded: decodeSignedDelegateAction(bytes) };
  };
  return {
    async verify(p, row) {
      let d: ReturnType<typeof decode>;
      try {
        d = decode(p);
      } catch {
        return { ok: false, reason: "invalid_exact_near_payload_signed_delegate_action" };
      }
      const da = d.decoded.signedDelegate.delegateAction;
      const payer = da.senderId;
      if (payer === o.relayer.accountId) return { ok: false, reason: "invalid_exact_near_relayer_cannot_be_payer" };
      const key = (da.publicKey as { ed25519Key?: { data: number[] } }).ed25519Key?.data;
      const sig = (d.decoded.signedDelegate.signature as { ed25519Signature?: { data: number[] } }).ed25519Signature?.data;
      if (!key || !sig) return { ok: false, reason: "invalid_exact_near_unsupported_key_type" };
      // NEP-366 signs SHA-256 of the u32 prefix 2^30 + 366 and the Borsh DelegateAction (the bytes before the signature).
      const delegateBytes = d.bytes.subarray(0, d.bytes.length - 1 - 64);
      const message = new Uint8Array(4 + delegateBytes.length);
      new DataView(message.buffer).setUint32(0, DELEGATE_ACTION_PREFIX, true);
      message.set(delegateBytes, 4);
      if (!ed25519.verify(new Uint8Array(sig), sha256(message), new Uint8Array(key))) return { ok: false, reason: "invalid_exact_near_payload_signature" };
      if (da.receiverId !== row.asset || da.actions.length !== 1) return { ok: false, reason: "invalid_exact_near_payload_action_count" };
      const fc = (da.actions[0] as { functionCall?: { methodName: string; args: Uint8Array; gas: bigint; deposit: bigint } }).functionCall;
      if (!fc || fc.methodName !== "ft_transfer") return { ok: false, reason: "invalid_exact_near_payload_method_name" };
      let args: { receiver_id?: unknown; amount?: unknown };
      try {
        args = JSON.parse(Buffer.from(fc.args).toString("utf8")) as typeof args;
      } catch {
        return { ok: false, reason: "invalid_exact_near_payload_ft_transfer_args" };
      }
      if (args.receiver_id !== row.payTo || args.amount !== row.amount) return { ok: false, reason: "invalid_exact_near_payload_recipient_or_amount_mismatch" };
      if (BigInt(fc.deposit) !== 1n || BigInt(fc.gas) > MAX_PAYMENT_GAS) return { ok: false, reason: "invalid_exact_near_payload_deposit_or_gas" };
      const head = await o.viewer.rpc<{ header: { height: number } }>("block", { finality: "final" });
      const remaining = BigInt(da.maxBlockHeight) - BigInt(head.header.height);
      if (remaining <= 0n) return { ok: false, reason: "invalid_exact_near_payload_delegate_action_expired" };
      if (remaining > timeoutBlocks(row.maxTimeoutSeconds)) return { ok: false, reason: "invalid_exact_near_payload_delegate_action_timeout_window_exceeds_max_timeout" };
      const balance = BigInt(await o.viewer.view<string>(row.asset, "ft_balance_of", { account_id: payer }));
      if (balance < BigInt(row.amount)) return { ok: false, reason: "insufficient_funds" };
      return { ok: true, payer };
    },
    async settle(p, row) {
      const { decoded } = decode(p);
      const payer = decoded.signedDelegate.delegateAction.senderId;
      try {
        // FINAL: every receipt has run, the inner ft_transfer included.
        const out = await o.relayer.sendTx((tx) => tx.signedDelegateAction(decoded), "FINAL");
        const hash = out.transaction?.hash ?? out.transaction_outcome?.id ?? "";
        return transferred(out, { asset: row.asset, payTo: row.payTo, amount: row.amount, payer }) ? { ok: true, transaction: hash, payer } : { ok: false, reason: failureOf(out) ?? "the transaction holds no matching ft_transfer", transaction: hash };
      } catch (e) {
        return { ok: false, reason: String((e as Error).message ?? e).slice(0, 300), ...(e instanceof TxError && e.hash ? { transaction: e.hash } : {}) };
      }
    },
  };
}

/** Whether an outcome holds a successful `ft_transfer` of exactly `amount` from payer to payTo on `asset`. */
export function transferred(out: FinalExecutionOutcome, expect: { asset: string; payTo: string; amount: string; payer: string }): boolean {
  return (out.receipts_outcome ?? []).some((r) => {
    const status = r.outcome.status as { SuccessValue?: string } | string;
    if (r.outcome.executor_id !== expect.asset || typeof status !== "object" || !("SuccessValue" in status)) return false;
    return parseEvents(r.outcome.logs).some(
      (e) =>
        e.standard === "nep141" &&
        e.event === "ft_transfer" &&
        Array.isArray(e.data) &&
        (e.data as Array<{ old_owner_id?: string; new_owner_id?: string; amount?: string }>).some((t) => t.old_owner_id === expect.payer && t.new_owner_id === expect.payTo && t.amount === expect.amount),
    );
  });
}

// Run on its own: a stand-in whose facilitator takes no payment (for poking at the shapes by hand).
if (import.meta.main) {
  const port = Number(process.env.STANDIN_PORT ?? 4890);
  const token = process.env.STANDIN_TOKEN ?? newAgentToken();
  const D = deployment("testnet");
  const s = createStandin({
    token,
    agent: { agentId: randomUUID(), handle: "tredio-attention", name: "Tredio attention check", description: "Attention index for any topic", tags: ["attention"] },
    plan: { priceAmount: process.env.PRICE_USDC ?? "0.05", slaSeconds: 120 },
    payment: { network: "near:testnet", asset: D.contracts.usdc, payTo: D.treasury },
    facilitator: { verify: async () => ({ ok: false, reason: "this stand-in takes no payments: scripts/trial.ts runs a settled call" }), settle: async () => ({ ok: false, reason: "no settlement" }) },
    baseUrl: `http://localhost:${port}`,
    log: (f, m) => console.log(JSON.stringify({ msg: m, ...f })),
  });
  Bun.serve({ port, fetch: s.app.fetch, idleTimeout: 120 });
  console.log(JSON.stringify({ msg: "stand-in market listening", port, token }));
}
