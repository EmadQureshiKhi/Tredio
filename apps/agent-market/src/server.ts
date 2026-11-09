import { Hono } from "hono";
import { formatUsdc } from "./config";
import type { DailyLedger } from "./ledger";
import { verifyWebhook, WEBHOOK_HEADERS } from "./market";
import type { Log, Worker } from "./worker";

/**
 * The worker's HTTP side:
 *
 * - POST /market/webhook: the market's signed events (when MARKET_WEBHOOK_SECRET is set). Every
 *   event only makes the next poll come at once: the assignments list stays the record, as the
 *   market's webhook reference asks (`/skill/reference/webhooks.md`).
 * - GET /health (detail for the status views, 503 when polling or the API is down), GET /live.
 */

export interface ServerDeps {
  worker: Worker;
  ledger: DailyLedger;
  network: string;
  marketUrl: string;
  price: bigint;
  pollIntervalSec: number;
  webhookSecret: string | null;
  /** Whether Tredio's API answers (cached by the caller). */
  backendUp: () => Promise<boolean>;
  log: Log;
  startedAt: number;
  now?: () => number;
}

/** Deliveries remembered for de-duplication (the market redelivers at least once). */
const SEEN_DELIVERIES = 2000;
/** Events after which there may be work to pick up. */
const WORK_EVENTS = new Set(["hire.created", "hire.changes_requested", "hire.dispute_resolved", "message.created"]);

export function createServer(d: ServerDeps): Hono {
  const app = new Hono();
  const now = d.now ?? Date.now;
  const seen = new Set<string>();
  const events: Record<string, number> = {};

  app.post("/market/webhook", async (c) => {
    if (!d.webhookSecret) return c.json({ error: "webhooks are off: set MARKET_WEBHOOK_SECRET" }, 404);
    const raw = await c.req.text();
    const signed = verifyWebhook(d.webhookSecret, { timestamp: c.req.header(WEBHOOK_HEADERS.timestamp), signature: c.req.header(WEBHOOK_HEADERS.signature) }, raw, Math.floor(now() / 1000));
    if (!signed) return c.json({ error: "bad or stale signature" }, 401);
    const event = c.req.header(WEBHOOK_HEADERS.event) ?? "";
    const delivery = c.req.header(WEBHOOK_HEADERS.delivery) ?? "";
    if (delivery && seen.has(delivery)) return c.json({ ok: true, duplicate: true });
    if (delivery) {
      seen.add(delivery);
      if (seen.size > SEEN_DELIVERIES) seen.delete(seen.values().next().value!);
    }
    events[event] = (events[event] ?? 0) + 1;
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Signed but not JSON: acknowledged, nothing to read.
    }
    d.log({ event, delivery, assignment: body.assignment_id ?? null, reason: body.reason ?? null }, "webhook");
    if (WORK_EVENTS.has(event)) d.worker.kick();
    return c.json({ ok: true });
  });

  app.get("/live", (c) => c.json({ live: true }));

  app.get("/health", async (c) => {
    const s = d.worker.stats;
    const nowSec = Math.floor(now() / 1000);
    const backend = await d.backendUp();
    // A poll older than five intervals means the market (or the token) stopped answering.
    const pollOk = s.lastPollOkAt !== null ? nowSec - s.lastPollOkAt <= d.pollIntervalSec * 5 : nowSec - Math.floor(d.startedAt / 1000) <= d.pollIntervalSec * 5;
    const used = d.ledger.count();
    const alerts: Record<string, string> = {};
    if (!pollOk) alerts.poll = `no assignments poll has worked for ${d.pollIntervalSec * 5} s${s.lastPollError ? `: ${s.lastPollError}` : ""}`;
    if (!backend) alerts.backend = "Tredio's API does not answer: every hire would be declined";
    if (used >= d.ledger.cap) alerts.cap = `the daily cap (${d.ledger.cap} calls) is reached; hires are declined until 00:00 UTC`;
    const ok = pollOk && backend;
    const declined = Object.values(s.declined).reduce((a, n) => a + n, 0);
    return c.json(
      {
        ok,
        service: "agent-market",
        network: d.network,
        startedAt: Math.floor(d.startedAt / 1000),
        wallets: [],
        alerts,
        lastError: s.lastError,
        lastWorkAt: s.lastDeliveredAt,
        market: { url: d.marketUrl, webhooks: Boolean(d.webhookSecret), pollIntervalSec: d.pollIntervalSec, lastPollAt: s.lastPollAt, lastPollOkAt: s.lastPollOkAt, events },
        calls: { day: d.ledger.day, used, cap: d.ledger.cap, paid: d.ledger.count("paid"), tests: d.ledger.count("test"), delivered: s.delivered, reworks: s.reworks, declined: s.declined },
        facts: [
          { label: "Price", value: `${formatUsdc(d.price)} USDC a call` },
          { label: "Calls today", value: `${used} of ${d.ledger.cap}`, tone: used >= d.ledger.cap ? "warn" : undefined },
          { label: "Delivered", value: String(s.delivered) },
          { label: "Declined", value: `${declined} (terms ${s.declined.terms}, cap ${s.declined.cap}, topic ${s.declined.topic}, failed ${s.declined.failed})`, tone: s.declined.failed > 0 ? "warn" : undefined },
          ...(s.lastDeliveredAt ? [{ label: "Last delivery", at: s.lastDeliveredAt }] : []),
          { label: "Running since", at: Math.floor(d.startedAt / 1000) },
        ],
        flags: [],
      },
      ok ? 200 : 503,
    );
  });
  return app;
}
