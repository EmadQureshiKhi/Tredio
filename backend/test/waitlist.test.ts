import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Sql } from "../src/db";
import { csvCell, EMAIL, ipHash, WAITLIST_JOINS_PER_WINDOW, waitlistAdminRoutes, waitlistRoutes } from "../src/waitlist/routes";
import { testDb } from "./helpers";

/**
 * The Mainnet waitlist: one row per email, consent required, the honeypot stores nothing, the client
 * address is kept only as a keyed hash, and admins list, export, invite and erase rows.
 */

const SECRET = "s".repeat(64);
const ACCOUNT = "Account-AB";

let sql: Sql;
let now = Date.parse("2026-10-12T12:00:00Z");

beforeAll(async () => {
  sql = await testDb();
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  await sql`TRUNCATE waitlist RESTART IDENTITY`;
});

const publicApp = () => waitlistRoutes({ sql, trustedProxyHops: 1, ipSecret: SECRET, now: () => now });
const join = (app: ReturnType<typeof waitlistRoutes>, body: unknown, ip = "192.0.2.1") =>
  app.request("/waitlist", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });
const rows = () => sql<{ email: string; source: string; account: string | null; consent: boolean; ip_hash: string; invited_at: Date | null; unsubscribed_at: Date | null }[]>`SELECT * FROM waitlist ORDER BY id`;

describe("email check", () => {
  test("takes ordinary addresses and refuses what cannot be mailed", () => {
    for (const ok of ["a@b.co", "first.last+tag@tredio.bid", "x_y@mail.example.co.uk", "o'neil@example.org", "a@xn--80ak6aa92e.xn--p1ai"]) expect(EMAIL.test(ok)).toBe(true);
    for (const bad of ["", "plain", "a@b", "a@b.c", "a b@c.com", "a@-b.com", "a@b-.com", "@b.com", "a@@b.com", "a@b.com.", `${"a".repeat(65)}@b.com`]) expect(EMAIL.test(bad)).toBe(false);
  });
});

describe("POST /waitlist", () => {
  test("stores the email lowercased and trimmed, the source, the account lowercased and a keyed hash of the client", async () => {
    const res = await join(publicApp(), { email: "  Waitlist-Check+1@Tredio.BID ", source: "app", account: ACCOUNT, consent: true }, "203.0.113.9, 192.0.2.1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const [row] = await rows();
    expect(row).toMatchObject({ email: "waitlist-check+1@tredio.bid", source: "app", account: ACCOUNT.toLowerCase(), consent: true, invited_at: null, unsubscribed_at: null });
    // The proxy's entry counts, and only as a hash keyed with the server secret.
    expect(row!.ip_hash).toBe(ipHash(SECRET, "192.0.2.1"));
    expect(row!.ip_hash).not.toContain("192.0.2.1");
  });

  test("joining again answers the same, keeps one row and the first source, and links an account only once", async () => {
    const app = publicApp();
    expect((await join(app, { email: "a@tredio.bid", source: "landing", consent: true })).status).toBe(200);
    expect((await join(app, { email: "A@tredio.bid", source: "app", account: ACCOUNT, consent: true })).status).toBe(200);
    expect(await rows()).toMatchObject([{ email: "a@tredio.bid", source: "landing", account: ACCOUNT.toLowerCase() }]);
    // A later join cannot move the email to another account.
    await join(app, { email: "a@tredio.bid", source: "app", account: "account-cd", consent: true });
    expect((await rows())[0]!.account).toBe(ACCOUNT.toLowerCase());
    // Joining again after unsubscribing is fresh consent.
    await sql`UPDATE waitlist SET unsubscribed_at = now()`;
    await join(app, { email: "a@tredio.bid", source: "app", consent: true });
    expect((await rows())[0]!.unsubscribed_at).toBeNull();
  });

  test("refuses a bad email, a missing consent and an unknown source", async () => {
    const app = publicApp();
    // Refusals count against the limit too, so each comes from its own address.
    let n = 0;
    const error = async (body: unknown) => {
      const res = await join(app, body, `198.51.100.${++n}`);
      return [res.status, ((await res.json()) as { error: string }).error];
    };
    expect(await error({ email: "nope", source: "app", consent: true })).toEqual([400, "Enter a valid email address."]);
    expect(await error({ email: `${"a".repeat(60)}@${["b", "c", "d", "e"].map((l) => l.repeat(63)).join(".")}.com`, source: "app", consent: true })).toEqual([400, "That email address is too long."]);
    expect(await error({ email: "a@tredio.bid", source: "app", consent: false })).toEqual([400, "Agree to launch emails to join the waitlist."]);
    expect(await error({ email: "a@tredio.bid", source: "app" })).toEqual([400, "Agree to launch emails to join the waitlist."]);
    expect((await error({ email: "a@tredio.bid", source: "email", consent: true }))[0]).toBe(400);
    expect((await error(null))[0]).toBe(400);
    expect(await rows()).toHaveLength(0);
  });

  test("a filled honeypot answers like a join and stores nothing", async () => {
    const res = await join(publicApp(), { email: "bot@tredio.bid", source: "landing", consent: true, website: "https://spam.example" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await rows()).toHaveLength(0);
    // An empty honeypot is a person.
    expect((await join(publicApp(), { email: "person@tredio.bid", source: "landing", consent: true, website: "" })).status).toBe(200);
    expect(await rows()).toHaveLength(1);
  });

  test("limits joins per client address, with Retry-After and a short reason", async () => {
    const app = publicApp();
    for (let i = 0; i < WAITLIST_JOINS_PER_WINDOW; i++) expect((await join(app, { email: `p${i}@tredio.bid`, source: "app", consent: true }, "192.0.2.50")).status).toBe(200);
    const refused = await join(app, { email: "late@tredio.bid", source: "app", consent: true }, "192.0.2.50");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "too many requests" });
    expect(Number(refused.headers.get("retry-after"))).toBe(600);
    // Another network is counted on its own, and the window ends.
    expect((await join(app, { email: "other@tredio.bid", source: "app", consent: true }, "192.0.2.51")).status).toBe(200);
    now += 600_000;
    expect((await join(app, { email: "late@tredio.bid", source: "app", consent: true }, "192.0.2.50")).status).toBe(200);
    expect(await rows()).toHaveLength(WAITLIST_JOINS_PER_WINDOW + 2);
  });
});

describe("admin waitlist", () => {
  const admin = () => waitlistAdminRoutes({ sql });
  const seed = async (n: number) => {
    for (let i = 1; i <= n; i++) {
      await sql`INSERT INTO waitlist (email, source, account, consent, ip_hash, created_at)
                VALUES (${`user${i}@tredio.bid`}, ${i % 2 ? "app" : "landing"}, ${i === 2 ? ACCOUNT.toLowerCase() : null}, true, 'h', now() - make_interval(mins => ${n - i}))`;
    }
  };
  type Page = { total: number; invited: number; linked: number; matching: number; rows: Array<{ id: number; email: string; invitedAt: string | null }> };
  const list = async (query = "") => (await (await admin().request(`/waitlist${query}`)).json()) as Page;
  const post = (path: string, body: unknown) => admin().request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  test("lists newest first, a page at a time, with counts and a search over emails and accounts", async () => {
    await seed(5);
    const page = await list("?limit=2");
    expect(page).toMatchObject({ total: 5, invited: 0, linked: 1, matching: 5 });
    expect(page.rows.map((r) => r.email)).toEqual(["user5@tredio.bid", "user4@tredio.bid"]);
    expect((await list("?limit=2&offset=4")).rows.map((r) => r.email)).toEqual(["user1@tredio.bid"]);
    expect((await list("?q=USER3")).rows.map((r) => r.email)).toEqual(["user3@tredio.bid"]);
    expect(await list("?q=00AB")).toMatchObject({ matching: 1, rows: [{ email: "user2@tredio.bid" }] });
    // LIKE wildcards in a search are literal.
    expect((await list("?q=%25")).matching).toBe(0);
  });

  test("marks rows invited once and erases rows on request", async () => {
    await seed(3);
    const ids = (await list()).rows.map((r) => r.id);
    expect(await (await post("/waitlist/invite", { ids: [ids[0], ids[1]] })).json()).toEqual({ invited: 2 });
    const first = (await list()).rows[0]!.invitedAt;
    expect(first).not.toBeNull();
    // Invited rows keep their first invite.
    expect(await (await post("/waitlist/invite", { ids })).json()).toEqual({ invited: 1 });
    expect((await list()).rows[0]!.invitedAt).toBe(first);
    expect((await list()).invited).toBe(3);
    expect((await post("/waitlist/invite", { ids: [] })).status).toBe(400);
    expect((await post("/waitlist/delete", { ids: ["1"] })).status).toBe(400);
    expect(await (await post("/waitlist/delete", { ids: [ids[2]] })).json()).toEqual({ deleted: 1 });
    expect((await list()).total).toBe(2);
  });

  test("exports every row as CSV, newest first, with formulas defused", async () => {
    await seed(2);
    await sql`INSERT INTO waitlist (email, source, consent, ip_hash) VALUES ('=cmd@tredio.bid', 'landing', true, 'h')`;
    const res = await admin().request("/waitlist.csv");
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="tredio-waitlist-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = (await res.text()).trimEnd().split("\r\n");
    expect(lines[0]).toBe("id,email,source,account,created_at,updated_at,invited_at,unsubscribed_at");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^3,'=cmd@tredio\.bid,landing,,\d{4}-/);
    expect(lines[3]).toMatch(/^1,user1@tredio\.bid,app,,/);
    // The client hash stays out of the export.
    expect(lines.join()).not.toContain(",h,");
  });

  test("csv cells quote separators and defuse formulas", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-x")).toBe("'-x");
    expect(csvCell("@sum")).toBe("'@sum");
  });
});
