import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DailyLedger } from "../src/ledger";
import { MarketClient, webhookSignature } from "../src/market";
import { parseDeliverable } from "../src/result";
import { createServer } from "../src/server";
import { type Checker, Worker } from "../src/worker";
import { createStandin, escrowString, type Facilitator, newAgentToken, type PaymentHeader, type Task } from "../scripts/standin";
import { checker, D, TREND } from "./helpers";

const BASE = "http://standin.test";
const PAYER = "caller.testnet";
const SECRET = "s".repeat(40);

interface Setup {
  priceAmount?: string;
  workerPrice?: bigint;
  cap?: number;
  freeTests?: number;
  check?: Checker;
  maxAttempts?: number;
  webhooks?: boolean;
  settleOk?: boolean;
}

/** The stand-in market, the worker polling it, and the worker's HTTP side receiving its webhooks. */
function setup(o: Setup = {}) {
  const token = newAgentToken();
  const facilitatorCalls: string[] = [];
  const facilitator: Facilitator = {
    async verify(p) {
      facilitatorCalls.push("verify");
      return p.payload.signedDelegateAction.startsWith("bad") ? { ok: false, reason: "invalid_exact_near_payload_signature" } : { ok: true, payer: PAYER };
    },
    async settle() {
      facilitatorCalls.push("settle");
      return o.settleOk === false ? { ok: false, reason: "the transaction holds no matching ft_transfer", transaction: "failed-tx" } : { ok: true, transaction: `tx-${facilitatorCalls.length}`, payer: PAYER };
    },
  };
  const ledger = new DailyLedger({ price: o.workerPrice ?? 50_000n, acceptTokens: ["USDC"], dailyCap: o.cap ?? 10, freeTestsPerDay: o.freeTests ?? 1 });
  const logs: Array<{ msg: string; fields: Record<string, unknown> }> = [];
  const log = (fields: Record<string, unknown>, msg: string) => logs.push({ msg, fields });
  // Late-bound: the stand-in sends webhooks to the worker's server, which is built after it.
  let serverFetch: (r: Request) => Response | Promise<Response> = () => new Response("not ready", { status: 503 });
  const standin = createStandin({
    token,
    agent: { agentId: randomUUID(), handle: "tredio-attention", name: "Tredio attention check", description: "Attention index for any topic", tags: ["attention"] },
    plan: { priceAmount: o.priceAmount ?? "0.05", slaSeconds: 120 },
    payment: { network: "near:testnet", asset: D.contracts.usdc, payTo: D.treasury },
    facilitator,
    baseUrl: BASE,
    webhook: o.webhooks ? { url: "http://worker.test/market/webhook", secret: SECRET } : null,
    holdMs: 5_000,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => serverFetch(new Request(url, init))) as typeof fetch,
  });
  const marketFetch = (async (url: string | URL | Request, init?: RequestInit) => standin.app.fetch(new Request(url, init))) as typeof fetch;
  const market = new MarketClient(BASE, token, marketFetch);
  const worker = new Worker({ market, checker: o.check ?? checker(), ledger, maxConcurrent: 4, maxAttempts: o.maxAttempts ?? 3, workTimeoutMs: 5_000, log });
  const server = createServer({ worker, ledger, network: "testnet", marketUrl: BASE, price: 50_000n, pollIntervalSec: 15, webhookSecret: SECRET, backendUp: async () => true, log, startedAt: Date.now() });
  serverFetch = (r) => server.fetch(r);

  const rpc = (method: string, params: unknown, headers: Record<string, string> = {}) =>
    standin.app.fetch(new Request(`${BASE}/a2a/v1`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
  const sendMessage = (text: string, headers: Record<string, string> = {}, configuration: Record<string, unknown> = { historyLength: 0 }) =>
    rpc("SendMessage", { message: { messageId: randomUUID(), role: "ROLE_USER", parts: [{ text }] }, configuration }, headers);
  /** The caller's payment for the quoted row: base64 JSON, as the x402 caller skill builds it. */
  const pay = (row: Record<string, unknown>, sda = Buffer.from(randomUUID()).toString("base64")) => ({ "X-PAYMENT": Buffer.from(JSON.stringify({ x402Version: 2, accepted: row, payload: { signedDelegateAction: sda } } satisfies Omit<PaymentHeader, "accepted"> & { accepted: unknown })).toString("base64") });
  /** Waits until the market lists work for the agent (the paid call opens it after its checks). */
  const waitForWork = async () => {
    for (let i = 0; i < 200; i++) {
      if ((await market.assignments()).length > 0) return;
      await Bun.sleep(5);
    }
    throw new Error("no hire opened");
  };
  /** A paid call answered by one worker pass: the caller's view (HTTP status and task) and the worker's outcomes. */
  const paidCall = async (text: string) => {
    const quote = (await (await sendMessage(text)).json()) as { accepts: Array<Record<string, unknown>> };
    const pending = sendMessage(text, pay(quote.accepts[0]!));
    await waitForWork();
    const outcomes = await worker.poll();
    const res = await pending;
    const body = (await res.json()) as { result?: { task: Task }; error?: unknown };
    return { status: res.status, task: body.result?.task ?? null, outcomes };
  };
  return { standin, market, worker, ledger, server, logs, facilitatorCalls, rpc, sendMessage, pay, paidCall, token };
}

describe("the stand-in market's A2A host", () => {
  test("an unpaid call is quoted with a 402 in the documented x402 shape, taken from the default plan", async () => {
    const s = setup();
    const res = await s.sendMessage("Attention check: Godzilla");
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({
      x402Version: 2,
      error: "x-payment header is required",
      accepts: [{ scheme: "exact", network: "near:testnet", asset: D.contracts.usdc, amount: "50000", payTo: D.treasury, maxTimeoutSeconds: 720 }],
    });
    const card = (await (await s.standin.app.fetch(new Request(`${BASE}/.well-known/agent-card.json`))).json()) as { supportedInterfaces: Array<{ url: string }> };
    expect(card.supportedInterfaces[0]!.url).toBe(`${BASE}/a2a/v1`);
    expect(await (await s.standin.app.fetch(new Request(`${BASE}/.well-known/x402`))).json()).toEqual({ x402Version: 2, recipients: [{ network: "near:testnet", asset: D.contracts.usdc, payTo: D.treasury }] });
    expect(s.facilitatorCalls).toEqual([]);
  });

  test("a payment that does not sign the quoted row, or comes twice, is refused before any hire", async () => {
    const s = setup();
    const row = ((await (await s.sendMessage("Godzilla")).json()) as { accepts: Array<Record<string, unknown>> }).accepts[0]!;
    const cheaper = await s.sendMessage("Godzilla", s.pay({ ...row, amount: "1" }));
    expect(cheaper.status).toBe(402);
    expect(((await cheaper.json()) as { error: string }).error).toContain("sign the accepts[] row verbatim");
    const forged = await s.sendMessage("Godzilla", s.pay(row, "bad-signature"));
    expect(((await forged.json()) as { error: string }).error).toBe("invalid_exact_near_payload_signature");
    const once = s.pay(row);
    const first = s.sendMessage("Godzilla", once, { returnImmediately: true });
    expect((await first).status).toBe(200);
    const replay = await s.sendMessage("Godzilla", once);
    expect(replay.status).toBe(402);
    expect(((await replay.json()) as { error: string }).error).toBe("this x-payment header was already used");
    expect((await s.market.assignments()).length).toBe(1);
  });

  test("GetTask, CancelTask and the unsupported methods answer with the documented codes", async () => {
    const s = setup();
    const row = ((await (await s.sendMessage("Godzilla")).json()) as { accepts: Array<Record<string, unknown>> }).accepts[0]!;
    const opened = (await (await s.sendMessage("Godzilla", s.pay(row), { returnImmediately: true })).json()) as { result: { task: Task } };
    expect(opened.result.task.status.state).toBe("TASK_STATE_SUBMITTED");
    const got = (await (await s.rpc("GetTask", { id: opened.result.task.id, historyLength: 0 })).json()) as { result: Task };
    expect(got.result.id).toBe(opened.result.task.id);
    const cancelled = (await (await s.rpc("CancelTask", { id: opened.result.task.id })).json()) as { result: Task };
    expect(cancelled.result.status.state).toBe("TASK_STATE_CANCELED");
    expect(((await (await s.rpc("CancelTask", { id: opened.result.task.id })).json()) as { error: { code: number } }).error.code).toBe(-32002);
    expect(((await (await s.rpc("GetTask", { id: "nope" })).json()) as { error: { code: number } }).error.code).toBe(-32001);
    expect(((await (await s.rpc("ListTasks", {})).json()) as { error: { code: number } }).error.code).toBe(-32004);
    expect(((await (await s.rpc("SendMessage", { message: { parts: [] } })).json()) as { error: { code: number } }).error.code).toBe(-32602);
    // A cancelled hire is no longer work.
    expect(await s.market.assignments()).toEqual([]);
    expect(s.facilitatorCalls).toEqual(["verify"]);
  });
});

describe("a hire end to end, worker against the stand-in", () => {
  test("a paid call: the worker starts and delivers, the payment settles at delivery, the caller reads the result", async () => {
    const s = setup();
    const { status, task, outcomes } = await s.paidCall("Attention check: Godzilla\nWhat is the attention on it right now?");
    expect(outcomes).toEqual([{ assignmentId: expect.any(String), action: "delivered", kind: "fresh", identifier: TREND }]);
    expect(status).toBe(200);
    expect(task!.status.state).toBe("TASK_STATE_COMPLETED");
    const result = parseDeliverable(task!.artifacts![0]!.parts[0]!.text);
    expect(result).toMatchObject({ query: "Godzilla", topic: { identifier: TREND }, index: { now: 99.88 }, review: { verified: true } });
    expect(s.facilitatorCalls).toEqual(["verify", "settle"]);
    expect(s.standin.settlements).toEqual([{ assignmentId: outcomes[0]!.assignmentId, taskId: task!.id, payer: PAYER, amount: "50000", asset: D.contracts.usdc, payTo: D.treasury, transaction: "tx-2" }]);
    const a = s.standin.assignment(outcomes[0]!.assignmentId)!;
    expect(a.assignment).toMatchObject({ status: "accepted", escrowAmount: "0.050000000000", escrowToken: "USDC" });
    expect(a.assignment.startedAt).not.toBeNull();
    expect(s.ledger.count("paid")).toBe(1);
    expect(s.worker.stats.delivered).toBe(1);
  });

  test("a signed hire.created webhook makes the worker pick the hire up at once", async () => {
    const s = setup({ webhooks: true });
    const row = ((await (await s.sendMessage("Godzilla")).json()) as { accepts: Array<Record<string, unknown>> }).accepts[0]!;
    // No poll from the test: only the webhook can start the work.
    const res = await s.sendMessage("Godzilla", s.pay(row));
    const task = ((await res.json()) as { result: { task: Task } }).result.task;
    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    // hire.accepted goes out after the delivery; give it a moment to land.
    for (let i = 0; i < 100 && s.standin.webhooks.some((w) => w.status === null); i++) await Bun.sleep(5);
    expect(s.standin.webhooks.map((w) => [w.event, w.status])).toEqual([
      ["hire.created", 200],
      ["hire.accepted", 200],
    ]);
    expect(s.logs.filter((l) => l.msg === "webhook").map((l) => l.fields.event)).toEqual(["hire.created", "hire.accepted"]);
  });

  test("a topic Tredio does not track is declined as rejected, and the caller pays nothing", async () => {
    const s = setup();
    const { task, outcomes } = await s.paidCall("Attention check: curling world championship");
    expect(outcomes[0]).toMatchObject({ action: "declined", reason: "rejected", why: "topic" });
    expect(task!.status.state).toBe("TASK_STATE_REJECTED");
    expect(task!.status.message!.parts[0]!.text).toContain('Tredio does not track "curling world championship"');
    expect(task!.status.message!.parts[0]!.text).toContain("Godzilla Minus Zero (topic:godzilla-minus-zero.2)");
    expect(s.facilitatorCalls).toEqual(["verify"]);
    expect(s.standin.settlements).toEqual([]);
    expect(s.ledger.count()).toBe(0);
  });

  test("past the daily cap a hire is declined as rejected, unpaid", async () => {
    const s = setup({ cap: 1 });
    expect((await s.paidCall("Godzilla")).task!.status.state).toBe("TASK_STATE_COMPLETED");
    const second = await s.paidCall("World Cup");
    expect(second.outcomes[0]).toMatchObject({ action: "declined", reason: "rejected", why: "cap" });
    expect(second.task!.status.state).toBe("TASK_STATE_REJECTED");
    expect(second.task!.status.message!.parts[0]!.text).toBe("this agent's daily capacity (1 calls) is used up; it takes calls again after 00:00 UTC");
    expect(s.standin.settlements.length).toBe(1);
  });

  test("a plan quoting less than the agent's own price is declined, unpaid", async () => {
    const s = setup({ priceAmount: "0.01" });
    const { task, outcomes } = await s.paidCall("Godzilla");
    expect(outcomes[0]).toMatchObject({ action: "declined", why: "terms", detail: "this agent's price is 0.05 USDC a call; this hire holds 0.010000000000 USDC" });
    expect(task!.status.state).toBe("TASK_STATE_REJECTED");
    expect(s.standin.settlements).toEqual([]);
  });

  test("a free test run (no escrow) is answered within its own allowance", async () => {
    const s = setup({ freeTests: 1 });
    const first = s.standin.hire({ title: "Godzilla", description: "", escrowAmount: "0.000000000000" });
    expect((await s.worker.poll())[0]).toMatchObject({ assignmentId: first.assignment.assignmentId, action: "delivered" });
    expect(s.standin.assignment(first.assignment.assignmentId)!.assignment.status).toBe("submitted");
    const second = s.standin.hire({ title: "Godzilla", description: "", escrowAmount: "0" });
    expect((await s.worker.poll())[0]).toMatchObject({ assignmentId: second.assignment.assignmentId, action: "declined", why: "cap", detail: "the day's free test runs (1) are used up" });
    expect(s.ledger.count("test")).toBe(1);
  });

  test("rework: a note naming another topic is answered for that topic; a note naming none re-reads the brief", async () => {
    const s = setup();
    const hire = s.standin.hire({ title: "Attention check: Cardano", description: "", escrowAmount: escrowString("0.05") });
    const id = hire.assignment.assignmentId;
    expect((await s.worker.poll())[0]).toMatchObject({ action: "delivered", identifier: "crypto:ada" });
    s.standin.requestChanges(id, "Sorry, I meant Godzilla Minus Zero");
    expect((await s.worker.poll())[0]).toMatchObject({ action: "delivered", kind: "rework", identifier: TREND });
    s.standin.requestChanges(id, "Can you add more detail please?");
    expect((await s.worker.poll())[0]).toMatchObject({ action: "delivered", kind: "rework", identifier: "crypto:ada" });
    const r = parseDeliverable(s.standin.assignment(id)!.deliverable!);
    expect(r.notes[0]).toBe("Your note named no topic Tredio tracks, so this is a fresh reading of the brief's topic.");
    expect(s.worker.stats.reworks).toBe(2);
    // Rework is the same call: it does not count against the cap again.
    expect(s.ledger.count()).toBe(1);
  });

  test("a check that keeps failing is retried, then declined as failed; the caller pays nothing", async () => {
    const base = checker();
    const failing: Checker = { resolve: (q) => base.resolve(q), check: async () => Promise.reject(new Error("Tredio's API answered 502")) };
    const s = setup({ check: failing, maxAttempts: 2 });
    const quote = ((await (await s.sendMessage("Godzilla")).json()) as { accepts: Array<Record<string, unknown>> }).accepts[0]!;
    const pending = s.sendMessage("Godzilla", s.pay(quote));
    for (let i = 0; i < 200 && (await s.market.assignments()).length === 0; i++) await Bun.sleep(5);
    expect((await s.worker.poll())[0]).toMatchObject({ action: "retry", error: "Tredio's API answered 502" });
    expect((await s.worker.poll())[0]).toMatchObject({ action: "declined", reason: "failed", why: "failed" });
    const task = ((await (await pending).json()) as { result: { task: Task } }).result.task;
    expect(task.status.state).toBe("TASK_STATE_FAILED");
    expect(s.standin.settlements).toEqual([]);
  });

  test("a settlement the chain refuses fails the task and books nothing", async () => {
    const s = setup({ settleOk: false });
    const { task } = await s.paidCall("Godzilla");
    expect(task!.status.state).toBe("TASK_STATE_FAILED");
    expect(s.standin.settlements).toEqual([]);
  });

  test("the agent enters no competitions and leaves their rows alone", async () => {
    const s = setup();
    const hire = s.standin.hire({ title: "Godzilla", description: "" });
    // The stand-in opens instant hires; a competition entry is the same row with jobKind competition.
    const row = (await s.market.assignments())[0]!;
    row.job.jobKind = "competition";
    expect(await s.worker.handle(row)).toMatchObject({ assignmentId: hire.assignment.assignmentId, action: "skipped", kind: "competition" });
  });
});

describe("the worker REST surface of the stand-in", () => {
  test("a wrong token is a 401; state rules follow the API reference", async () => {
    const s = setup();
    const wrong = new MarketClient(BASE, newAgentToken(), (async (u: string | URL | Request, i?: RequestInit) => s.standin.app.fetch(new Request(u, i))) as typeof fetch);
    await expect(wrong.assignments()).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    const hire = s.standin.hire({ title: "Godzilla", description: "" });
    const id = hire.assignment.assignmentId;
    await expect(s.market.submit(id, "")).rejects.toMatchObject({ status: 400, code: "invalid_deliverable" });
    await expect(s.market.assignments("bogus" as never)).rejects.toMatchObject({ status: 400, code: "validation_error" });
    expect((await s.market.start(id)).startedAt).toBeString();
    await s.market.submit(id, "# Done");
    s.standin.requestChanges(id, "again please");
    await expect(s.market.decline(id, "rejected", "no")).rejects.toMatchObject({ status: 400, code: "invalid_state_transition" });
    expect((await s.market.decline(id, "failed", "could not")).status).toBe("cancelled");
    await expect(s.market.start("unknown")).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("the worker's webhook endpoint", () => {
  test("only signed, fresh deliveries are taken; a redelivery is acknowledged once", async () => {
    const s = setup();
    const post = (body: string, headers: Record<string, string>) => s.server.fetch(new Request("http://worker.test/market/webhook", { method: "POST", headers, body }));
    const body = JSON.stringify({ event: "webhook.ping", agent_id: "a", delivery_id: "d", test: true });
    const ts = String(Math.floor(Date.now() / 1000));
    const signed = { "x-market-event": "webhook.ping", "x-market-delivery": "test-1", "x-market-timestamp": ts, "x-market-signature": webhookSignature(SECRET, ts, body) };
    expect((await post(body, signed)).status).toBe(200);
    expect(await (await post(body, signed)).json()).toEqual({ ok: true, duplicate: true });
    expect((await post(body, { ...signed, "x-market-delivery": "test-2", "x-market-signature": webhookSignature("x".repeat(40), ts, body) })).status).toBe(401);
    expect((await post(`${body} `, { ...signed, "x-market-delivery": "test-3" })).status).toBe(401);
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect((await post(body, { ...signed, "x-market-delivery": "test-4", "x-market-timestamp": old, "x-market-signature": webhookSignature(SECRET, old, body) })).status).toBe(401);
  });

  test("health reports the day's calls, the price and alerts", async () => {
    const s = setup({ cap: 1 });
    await s.paidCall("Godzilla");
    const h = (await (await s.server.fetch(new Request("http://worker.test/health"))).json()) as { ok: boolean; alerts: Record<string, string>; calls: { used: number; cap: number; delivered: number } };
    expect(h.ok).toBe(true);
    expect(h.calls).toMatchObject({ used: 1, cap: 1, delivered: 1 });
    expect(h.alerts.cap).toContain("daily cap (1 calls) is reached");
    expect(await (await s.server.fetch(new Request("http://worker.test/live"))).json()).toEqual({ live: true });
  });
});
