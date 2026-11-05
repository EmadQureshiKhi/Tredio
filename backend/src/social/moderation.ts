import { Hono } from "hono";
import { z } from "zod";
import type { Sql } from "../db";

/**
 * Moderation of the social layer, for admins (mounted under /v1/admin). Calls and posts are signed
 * by their caller identity, so moderation never rewrites them: it removes one from the public
 * views, and the signed original stays in `moderation_log` with who removed it and why. A caller's
 * handle and bio are plain profile metadata the caller can change at any time, so an admin may
 * replace them too (a handle that breaks the rules, or a profile whose key is lost).
 */

const handle = z.string().regex(/^[a-z0-9_]{3,20}$/, "3 to 20 of a-z, 0-9 and _");
const reason = z.string().trim().min(1).max(200);
const renameBody = z.object({ handle, bio: z.string().max(160).default(""), reason });
const removeBody = z.object({ reason });
/** A caller identity as stored: lowercase, no spaces. */
const address = /^[a-z0-9._:-]{2,128}$/;

export function moderationRoutes(d: { sql: Sql }) {
  const app = new Hono<{ Variables: { admin: string } }>();
  const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
  const id = (raw: string) => (/^[1-9][0-9]{0,15}$/.test(raw) ? raw : null);

  // Every caller with a profile or content, newest first, with what they have published.
  app.get("/social/callers", async (c) => {
    const rows = await d.sql`
      SELECT cl.address, cl.handle, cl.bio, cl.linked_account, cl.created_at,
             (SELECT count(*)::int FROM calls WHERE caller = cl.address) AS calls,
             (SELECT count(*)::int FROM posts WHERE caller = cl.address) AS posts
        FROM callers cl ORDER BY cl.created_at DESC LIMIT 500`;
    return c.json({ callers: rows });
  });

  app.get("/social/content", async (c) => {
    const caller = (c.req.query("caller") ?? "").toLowerCase();
    if (caller && !address.test(caller)) return c.json({ error: "bad caller" }, 400);
    const [calls, posts] = await Promise.all([
      d.sql`SELECT id, caller, identifier, direction, note, outcome, called_at FROM calls WHERE ${caller || null}::text IS NULL OR caller = ${caller || null} ORDER BY id DESC LIMIT 500`,
      d.sql`SELECT id, caller, identifier, body, created_at FROM posts WHERE ${caller || null}::text IS NULL OR caller = ${caller || null} ORDER BY id DESC LIMIT 500`,
    ]);
    return c.json({ calls, posts });
  });

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

  for (const kind of ["calls", "posts"] as const) {
    app.post(`/social/${kind}/:id/remove`, async (c) => {
      const target = id(c.req.param("id"));
      if (!target) return c.json({ error: "bad id" }, 400);
      const b = removeBody.safeParse(await c.req.json().catch(() => null));
      if (!b.success) return c.json({ error: issues(b.error) }, 400);
      const removed = await d.sql.begin(async (tx) => {
        const row = (kind === "calls" ? await tx`DELETE FROM calls WHERE id = ${target} RETURNING *` : await tx`DELETE FROM posts WHERE id = ${target} RETURNING *`)[0];
        if (!row) return false;
        const action = kind === "calls" ? "remove_call" : "remove_post";
        await tx`INSERT INTO moderation_log (admin, action, target, reason, before) VALUES (${c.get("admin")}, ${action}, ${`${kind}:${target}`}, ${b.data.reason}, ${tx.json(row as never)})`;
        return true;
      });
      return removed ? c.json({ ok: true }) : c.json({ error: `no such ${kind === "calls" ? "call" : "post"}` }, 404);
    });
  }

  app.get("/social/moderation", async (c) => c.json({ log: await d.sql`SELECT id, admin, action, target, reason, before, created_at FROM moderation_log ORDER BY id DESC LIMIT 200` }));
  return app;
}
