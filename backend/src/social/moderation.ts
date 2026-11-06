import { Hono } from "hono";
import { z } from "zod";
import type { Sql } from "../db";

/**
 * Moderation of the social layer, for admins (mounted under /v1/admin). Calls and posts are signed
 * by their caller identity, so moderation never rewrites them: hiding one takes it out of every
 * public view (threads, profiles, the leaderboard, share links, call notifications), and restoring
 * brings it back as it was, with its replies and the posts that cite it. Each hide, restore and
 * rename lands in `moderation_log` with who did it, why, and the row as it stood. A caller's handle
 * and bio are plain profile metadata the caller can change at any time, so an admin may replace
 * them too (a handle that breaks the rules, or a profile whose key is lost).
 */

export const MODERATION_PAGE_MAX = 200;
export const MODERATION_STATES = ["all", "visible", "hidden"] as const;
const KINDS = ["calls", "posts"] as const;

const handle = z.string().regex(/^[a-z0-9_]{3,20}$/, "3 to 20 of a-z, 0-9 and _");
const reason = z.string().trim().min(1).max(200);
const renameBody = z.object({ handle, bio: z.string().max(160).default(""), reason });
const reasonBody = z.object({ reason });
/** A caller identity as stored (lowercase, no spaces), or a handle. */
const address = /^[a-z0-9._:-]{2,128}$/;

/** The newest moderation of a row, as the lists show it. */
interface LastAction {
  admin: string;
  action: string;
  reason: string;
  at: string;
}

const lastAction = (r: { m_admin: string | null; m_action: string | null; m_reason: string | null; m_at: Date | null }): LastAction | null =>
  r.m_admin && r.m_action && r.m_reason && r.m_at ? { admin: r.m_admin, action: r.m_action, reason: r.m_reason, at: r.m_at.toISOString() } : null;
const stamp = (d: Date | null) => (d ? d.toISOString() : null);

export function moderationRoutes(d: { sql: Sql }) {
  const app = new Hono<{ Variables: { admin: string } }>();
  const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
  const id = (raw: string) => (/^[1-9][0-9]{0,15}$/.test(raw) ? raw : null);
  const pattern = (q: string | undefined) => {
    const s = (q ?? "").trim().toLowerCase().replace(/^@/, "").slice(0, 100);
    return s ? `%${s.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
  };

  // Every caller with a profile or content, newest first, with what they published and how much
  // of it is hidden; `q` matches part of an identity, handle or linked account.
  app.get("/social/callers", async (c) => {
    const like = pattern(c.req.query("q"));
    const rows = await d.sql<{ address: string; handle: string | null; bio: string | null; linkedAccount: string | null; createdAt: Date; calls: number; posts: number; hidden: number }[]>`
      SELECT cl.address, cl.handle, cl.bio, cl.linked_account AS "linkedAccount", cl.created_at AS "createdAt",
             COALESCE(ca.n, 0) AS calls, COALESCE(po.n, 0) AS posts, COALESCE(ca.hidden, 0) + COALESCE(po.hidden, 0) AS hidden
        FROM callers cl
        LEFT JOIN (SELECT caller, count(*)::int AS n, count(*) FILTER (WHERE hidden_at IS NOT NULL)::int AS hidden FROM calls GROUP BY caller) ca ON ca.caller = cl.address
        LEFT JOIN (SELECT caller, count(*)::int AS n, count(*) FILTER (WHERE hidden_at IS NOT NULL)::int AS hidden FROM posts GROUP BY caller) po ON po.caller = cl.address
       WHERE ${like}::text IS NULL OR cl.address LIKE ${like} OR cl.handle LIKE ${like} OR cl.linked_account LIKE ${like}
       ORDER BY cl.created_at DESC LIMIT 500`;
    return c.json({ callers: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) });
  });

  // Calls or posts, newest first, `limit` at a time from `offset`. `state` is all, visible or
  // hidden, and `caller` an identity or a handle. Each row carries its newest moderation, and the
  // counts cover the whole table (`matching`: the filters).
  for (const kind of KINDS) {
    app.get(`/social/${kind}`, async (c) => {
      const state = MODERATION_STATES.find((s) => s === c.req.query("state")) ?? "all";
      const caller = (c.req.query("caller") ?? "").trim().toLowerCase().replace(/^@/, "") || null;
      if (caller && !address.test(caller)) return c.json({ error: "bad caller" }, 400);
      const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), MODERATION_PAGE_MAX);
      const offset = Math.max(Number(c.req.query("offset") ?? 0) || 0, 0);
      const hidden = state === "all" ? null : state === "hidden";
      const filter = d.sql`(${caller}::text IS NULL OR x.caller = ${caller} OR cl.handle = ${caller}) AND (${hidden}::boolean IS NULL OR (x.hidden_at IS NOT NULL) = ${hidden}::boolean)`;
      const last = d.sql`
        LEFT JOIN LATERAL (
          SELECT admin AS m_admin, action AS m_action, reason AS m_reason, created_at AS m_at FROM moderation_log
           WHERE target = ${`${kind}:`}::text || x.id ORDER BY created_at DESC, id DESC LIMIT 1
        ) m ON true`;
      const [rows, [counts]] = await Promise.all([
        kind === "calls"
          ? d.sql`
              SELECT x.id, x.caller, cl.handle, x.identifier, x.direction, x.horizon_sec, x.note, x.called_at, x.opening_index, x.resolves_at, x.closing_index, x.outcome, x.hidden_at, m.*
                FROM calls x JOIN callers cl ON cl.address = x.caller ${last}
               WHERE ${filter} ORDER BY x.id DESC LIMIT ${limit} OFFSET ${offset}`
          : d.sql`
              SELECT x.id, x.caller, cl.handle, x.identifier, x.body, x.reply_to, x.call_id, x.created_at, x.hidden_at, m.*
                FROM posts x JOIN callers cl ON cl.address = x.caller ${last}
               WHERE ${filter} ORDER BY x.id DESC LIMIT ${limit} OFFSET ${offset}`,
        d.sql<{ total: number; hidden: number; matching: number }[]>`
          SELECT count(*)::int AS total, count(*) FILTER (WHERE x.hidden_at IS NOT NULL)::int AS hidden, count(*) FILTER (WHERE ${filter})::int AS matching
            FROM ${d.sql(kind)} x JOIN callers cl ON cl.address = x.caller`,
      ]);
      const shaped = rows.map((r) => {
        const common = { id: Number(r.id), caller: r.caller as string, handle: r.handle as string | null, identifier: r.identifier as string, hiddenAt: stamp(r.hidden_at), lastAction: lastAction(r as never) };
        return kind === "calls"
          ? {
              ...common,
              direction: r.direction as "up" | "down",
              horizonSec: r.horizon_sec as number,
              note: r.note as string | null,
              calledAt: Number(r.called_at),
              openingIndex: r.opening_index as number,
              resolvesAt: Number(r.resolves_at),
              closingIndex: r.closing_index as number | null,
              outcome: r.outcome as string,
            }
          : { ...common, body: r.body as string, replyTo: r.reply_to === null ? null : Number(r.reply_to), callId: r.call_id === null ? null : Number(r.call_id), createdAt: stamp(r.created_at) };
      });
      return c.json({ ...counts!, limit, offset, rows: shaped });
    });
  }

  app.post("/social/callers/:address/profile", async (c) => {
    const who = c.req.param("address").toLowerCase();
    if (!address.test(who)) return c.json({ error: "bad address" }, 400);
    const b = renameBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: issues(b.error) }, 400);
    try {
      const done = await d.sql.begin(async (tx) => {
        const before = (await tx`SELECT address, handle, bio FROM callers WHERE address = ${who} FOR UPDATE`)[0];
        if (!before) return null;
        await tx`UPDATE callers SET handle = ${b.data.handle}, bio = ${b.data.bio || null}, updated_at = now() WHERE address = ${who}`;
        await tx`INSERT INTO moderation_log (admin, action, target, reason, before) VALUES (${c.get("admin")}, 'rename_caller', ${who}, ${b.data.reason}, ${tx.json(before as never)})`;
        return true;
      });
      if (!done) return c.json({ error: "no such caller" }, 404);
    } catch (e) {
      if (e instanceof Error && /unique/i.test(e.message)) return c.json({ error: "that handle is taken" }, 409);
      throw e;
    }
    return c.json({ caller: { address: who, handle: b.data.handle, bio: b.data.bio } });
  });

  // Hiding and restoring: the row stays as signed, only whether the public sees it changes.
  for (const kind of KINDS) {
    const noun = kind === "calls" ? "call" : "post";
    for (const act of ["hide", "restore"] as const) {
      app.post(`/social/${kind}/:id/${act}`, async (c) => {
        const target = id(c.req.param("id"));
        if (!target) return c.json({ error: "bad id" }, 400);
        const b = reasonBody.safeParse(await c.req.json().catch(() => null));
        if (!b.success) return c.json({ error: issues(b.error) }, 400);
        const hide = act === "hide";
        const done = await d.sql.begin(async (tx) => {
          const row = (await tx`SELECT * FROM ${tx(kind)} WHERE id = ${target} FOR UPDATE`)[0];
          if (!row) return { error: `no such ${noun}`, status: 404 as const };
          if ((row.hidden_at !== null) === hide) return { error: hide ? `that ${noun} is already hidden` : `that ${noun} is not hidden`, status: 409 as const };
          const [after] = await tx<{ hidden_at: Date | null }[]>`UPDATE ${tx(kind)} SET hidden_at = ${hide ? tx`now()` : null} WHERE id = ${target} RETURNING hidden_at`;
          await tx`INSERT INTO moderation_log (admin, action, target, reason, before) VALUES (${c.get("admin")}, ${`${act}_${noun}`}, ${`${kind}:${target}`}, ${b.data.reason}, ${tx.json(row as never)})`;
          return { hiddenAt: stamp(after!.hidden_at) };
        });
        return "error" in done ? c.json({ error: done.error }, done.status) : c.json({ id: Number(target), hiddenAt: done.hiddenAt });
      });
    }
  }

  app.get("/social/moderation", async (c) => {
    const rows = await d.sql<{ id: string; admin: string; action: string; target: string; reason: string; before: unknown; createdAt: Date }[]>`
      SELECT id, admin, action, target, reason, before, created_at AS "createdAt" FROM moderation_log ORDER BY id DESC LIMIT 200`;
    return c.json({ log: rows.map((r) => ({ ...r, id: Number(r.id), createdAt: r.createdAt.toISOString() })) });
  });
  return app;
}
