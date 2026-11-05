import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { clientIp, rateLimit } from "../api/rate-limit";
import type { Sql } from "../db";

/**
 * The Mainnet waitlist. Anyone may leave an email from the app or the website, with consent to
 * launch and beta emails; nothing is sent until Mainnet. The answer is the same whether the email
 * was new or already listed, so the form never tells a stranger who signed up. A filled `website`
 * field is the honeypot only bots see: it gets the same answer and stores nothing.
 */

/** Joins per client address per window: a person joins once or twice, a script many times. */
export const WAITLIST_JOINS_PER_WINDOW = 5;
export const WAITLIST_WINDOW_MS = 600_000;
/** The most rows an admin list returns per page. */
export const WAITLIST_PAGE_MAX = 200;

/**
 * A practical address check (the HTML email input's rule, with a dotted domain and a real top-level
 * label), not RFC 5322 in full: what passes here is worth an email at launch.
 */
export const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

const joinBody = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254, "That email address is too long.")
    .regex(EMAIL, "Enter a valid email address."),
  source: z.enum(["app", "landing"], "source must be app or landing"),
  account: z
    .string()
    .toLowerCase()
    .regex(/^(([a-z0-9]+[-_])*[a-z0-9]+\.)*([a-z0-9]+[-_])*[a-z0-9]+$/, "account must be a NEAR account")
    .min(2)
    .max(64)
    .nullish(),
  consent: z.literal(true, "Agree to launch emails to join the waitlist."),
});

const idsBody = z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) });

export interface WaitlistRow {
  id: number;
  email: string;
  source: "app" | "landing";
  account: string | null;
  createdAt: string;
  updatedAt: string;
  invitedAt: string | null;
  unsubscribedAt: string | null;
}

const COLUMNS = (sql: Sql) =>
  sql`id::int AS id, email, source, account, created_at AS "createdAt", updated_at AS "updatedAt", invited_at AS "invitedAt", unsubscribed_at AS "unsubscribedAt"`;

/** A client address as a keyed hash: rows from one network can be told apart without storing the address. */
export const ipHash = (secret: string, ip: string) => createHmac("sha256", secret).update(`tredio-waitlist-ip/${ip}`).digest("hex");

/**
 * `POST /waitlist` with `{ email, source, account?, consent, website? }`. Joining again with a listed
 * email is a no-op that keeps the first source, links an account if none was linked yet, and counts
 * as fresh consent (an earlier unsubscribe is lifted).
 */
export function waitlistRoutes(d: { sql: Sql; trustedProxyHops: number; ipSecret: string; now?: () => number }) {
  const app = new Hono();
  const limit = rateLimit(WAITLIST_JOINS_PER_WINDOW, WAITLIST_WINDOW_MS, (c) => `waitlist:${clientIp(c, d.trustedProxyHops)}`, d.now);
  app.post("/waitlist", limit, async (c) => {
    const raw: unknown = await c.req.json().catch(() => null);
    if (raw && typeof raw === "object" && typeof (raw as { website?: unknown }).website === "string" && (raw as { website: string }).website.trim()) return c.json({ ok: true });
    const b = joinBody.safeParse(raw);
    if (!b.success) return c.json({ error: b.error.issues[0]?.message ?? "bad request" }, 400);
    const { email, source, account, consent } = b.data;
    const hash = ipHash(d.ipSecret, clientIp(c, d.trustedProxyHops));
    await d.sql`
      INSERT INTO waitlist (email, source, account, consent, ip_hash)
      VALUES (${email}, ${source}, ${account ?? null}, ${consent}, ${hash})
      ON CONFLICT (email) DO UPDATE
        SET account = COALESCE(waitlist.account, EXCLUDED.account),
            consent = true,
            unsubscribed_at = NULL,
            updated_at = now()`;
    return c.json({ ok: true });
  });
  return app;
}

/** RFC 4180 cells, with formulas defused: a cell a spreadsheet would evaluate starts with a quote. */
export function csvCell(value: string | null): string {
  if (value === null) return "";
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Admin views of the waitlist (mounted under /v1/admin): the list, a CSV export, invites and removal. */
export function waitlistAdminRoutes(d: { sql: Sql }) {
  const app = new Hono<{ Variables: { admin: string } }>();
  const pattern = (q: string | undefined) => {
    const s = (q ?? "").trim().toLowerCase().slice(0, 100);
    return s ? `%${s.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
  };
  const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");

  // Newest first, `limit` at a time from `offset`; `q` matches part of an email or account.
  app.get("/waitlist", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), WAITLIST_PAGE_MAX);
    const offset = Math.max(Number(c.req.query("offset") ?? 0) || 0, 0);
    const like = pattern(c.req.query("q"));
    const where = like ? d.sql`WHERE email LIKE ${like} OR account LIKE ${like}` : d.sql``;
    const [rows, [counts]] = await Promise.all([
      d.sql<WaitlistRow[]>`SELECT ${COLUMNS(d.sql)} FROM waitlist ${where} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`,
      d.sql<{ total: number; invited: number; linked: number; matching: number }[]>`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE invited_at IS NOT NULL)::int AS invited,
               count(*) FILTER (WHERE account IS NOT NULL)::int AS linked,
               count(*) FILTER (WHERE ${like}::text IS NULL OR email LIKE ${like} OR account LIKE ${like})::int AS matching
          FROM waitlist`,
    ]);
    return c.json({ ...counts!, limit, offset, rows: rows.map(iso) });
  });

  app.get("/waitlist.csv", async (c) => {
    const rows = await d.sql<WaitlistRow[]>`SELECT ${COLUMNS(d.sql)} FROM waitlist ORDER BY created_at DESC, id DESC`;
    const head = ["id", "email", "source", "account", "created_at", "updated_at", "invited_at", "unsubscribed_at"];
    const lines = rows.map(iso).map((r) => [String(r.id), r.email, r.source, r.account, r.createdAt, r.updatedAt, r.invitedAt, r.unsubscribedAt].map(csvCell).join(","));
    const day = new Date().toISOString().slice(0, 10);
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", `attachment; filename="tredio-waitlist-${day}.csv"`);
    c.header("cache-control", "no-store");
    return c.body(`${[head.join(","), ...lines].join("\r\n")}\r\n`);
  });

  // Marks rows invited to the beta; rows invited earlier keep their first invite time.
  app.post("/waitlist/invite", async (c) => {
    const b = idsBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: issues(b.error) }, 400);
    const done = await d.sql`UPDATE waitlist SET invited_at = now(), updated_at = now() WHERE id = ANY(${b.data.ids}::bigint[]) AND invited_at IS NULL RETURNING id`;
    return c.json({ invited: done.length });
  });

  // Erases rows for good: a deletion request sent to the contact address.
  app.post("/waitlist/delete", async (c) => {
    const b = idsBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: issues(b.error) }, 400);
    const done = await d.sql`DELETE FROM waitlist WHERE id = ANY(${b.data.ids}::bigint[]) RETURNING id`;
    return c.json({ deleted: done.length });
  });
  return app;
}

const stamp = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null));
const iso = (r: WaitlistRow): WaitlistRow => ({
  ...r,
  createdAt: stamp(r.createdAt)!,
  updatedAt: stamp(r.updatedAt)!,
  invitedAt: stamp(r.invitedAt),
  unsubscribedAt: stamp(r.unsubscribedAt),
});
