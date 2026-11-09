import { describe, expect, test } from "bun:test";
import { classify, MarketClient, MarketError, type MyAssignmentItem, verifyWebhook, webhookSignature } from "../src/market";

const row = (a: Partial<MyAssignmentItem["assignment"]>, jobKind: MyAssignmentItem["job"]["jobKind"] = "instant"): MyAssignmentItem => ({
  assignment: { assignmentId: "a", jobId: "j", workerAgentId: "w", status: "in_progress", escrowAmount: "0.05", escrowToken: "USDC", slaSeconds: 120, slaDeadlineAt: "", acceptanceWindowDays: 3, createdAt: "", updatedAt: "", ...a },
  job: { jobId: "j", title: "t", description: "", tags: [], jobKind, status: "in_progress", attachments: [] },
  latestMessage: null,
});

describe("assignment rows", () => {
  test("the row alone tells fresh work, rework and a dispute redo apart, as the worker skill says", () => {
    expect(classify(row({ deliverableUrl: null, submittedAt: null }))).toBe("fresh");
    expect(classify(row({ deliverableUrl: null, submittedAt: null, startedAt: "2026-11-09T10:00:00Z" }))).toBe("fresh");
    expect(classify(row({ deliverableUrl: "https://m/x", submittedAt: "2026-11-09T10:00:00Z" }))).toBe("rework");
    expect(classify(row({ deliverableUrl: "https://m/x", submittedAt: null }))).toBe("redo");
    expect(classify(row({}, "competition"))).toBe("competition");
  });
});

describe("webhook signatures", () => {
  // Computed with the webhook reference's own Python: hmac.new(secret, f"{ts}.".encode() + body, sha256).
  const secret = "0123456789abcdef0123456789abcdef";
  const ts = "1794248992";
  const body = '{"event":"hire.created","assignment_id":"a1"}';

  test("match the documented HMAC-SHA256 over <timestamp>.<raw body>", () => {
    expect(webhookSignature(secret, ts, body)).toBe("sha256=762f43aa075c64b201ee8d980e65104c99f1a3c7179ecedb088d335278d83ab0");
  });

  test("a wrong secret, a changed body, a missing header or a stale timestamp fail", () => {
    const sig = webhookSignature(secret, ts, body);
    const now = Number(ts) + 10;
    expect(verifyWebhook(secret, { timestamp: ts, signature: sig }, body, now)).toBe(true);
    expect(verifyWebhook(`${secret}x`, { timestamp: ts, signature: sig }, body, now)).toBe(false);
    expect(verifyWebhook(secret, { timestamp: ts, signature: sig }, `${body}\n`, now)).toBe(false);
    expect(verifyWebhook(secret, { timestamp: null, signature: sig }, body, now)).toBe(false);
    expect(verifyWebhook(secret, { timestamp: ts, signature: sig }, body, Number(ts) + 301)).toBe(false);
    expect(verifyWebhook(secret, { timestamp: ts, signature: sig.replace("sha256=", "") }, body, now)).toBe(false);
  });
});

describe("the market client", () => {
  test("sends the agent token and reads the market's error codes", async () => {
    const seen: Array<{ url: string; auth: string | null; body: unknown }> = [];
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (String(url).endsWith("/decline")) return new Response(JSON.stringify({ error: "invalid_state_transition", message: "cannot transition from 'submitted' to 'cancelled'" }), { status: 400 });
      if (String(url).endsWith("/start")) return new Response("upstream", { status: 503 });
      return new Response(JSON.stringify({ assignments: [] }), { status: 200 });
    }) as typeof fetch;
    const m = new MarketClient("https://market.near.ai/", "aat_x", f);
    expect(await m.assignments()).toEqual([]);
    expect(seen[0]).toEqual({ url: "https://market.near.ai/v1/agents/me/assignments?status=in_progress&limit=50&offset=0", auth: "Bearer aat_x", body: null });
    const declined = await m.decline("id-1", "failed", "x".repeat(2000)).catch((e: unknown) => e as MarketError);
    expect(declined).toMatchObject({ status: 400, code: "invalid_state_transition", transient: false });
    expect((seen[1]!.body as { detail: string }).detail.length).toBe(1000);
    const down = await m.start("id-1").catch((e: unknown) => e as MarketError);
    expect(down).toMatchObject({ status: 503, code: "http_503", transient: true });
  });

  test("an unreachable market is a transient error", async () => {
    const m = new MarketClient("https://market.near.ai", "aat_x", (async () => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch);
    expect(await m.assignments().catch((e: unknown) => e)).toMatchObject({ status: 0, code: "unreachable", transient: true });
  });
});
