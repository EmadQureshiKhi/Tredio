import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { Hono } from "hono";
import type { ChainReader, ChainTrend } from "../src/chain";
import type { Sql } from "../src/db";
import { moderationRoutes } from "../src/social/moderation";
import { callMessage, resolveCalls, socialRoutes, wilson } from "../src/social/routes";
import { testDb } from "./helpers";

/**
 * The social layer on Postgres: calls resolve from the registry's checkpoints after their window,
 * callers rank by the Wilson lower bound of their hit rate, a profile's record counts every call
 * (as the leaderboard does), one call is found by its id however old it is, and moderation hides
 * and restores calls and posts in every public view.
 */

const NOW = 1_790_000_000;
const DAY = 86_400;
const ADMIN = "admin.testnet";
const [ALICE, BOB, CAROL, DAVE, ERIN] = ["a", "b", "c", "d", "e"].map((ch) => ch.repeat(64)) as [string, string, string, string, string];

const trend = (identifier: string, status: ChainTrend["status"] = "Active", index = 50): ChainTrend => ({
  id: identifier,
  identifier,
  assetClass: 6,
  status,
  createdAt: NOW - 30 * DAY,
  updatedAt: NOW,
  statusSince: NOW - 30 * DAY,
  index,
  peakIndex: 80,
  surfacer: "tredio-oracle.testnet",
  reviewHash: null,
  asset: null,
});

let sql: Sql;
let trends: ChainTrend[] = [];
const chain = { trends: async () => trends } as unknown as ChainReader;

beforeAll(async () => {
  sql = await testDb();
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  await sql`TRUNCATE moderation_log, index_points, posts, calls, callers RESTART IDENTITY CASCADE`;
  trends = [trend("topic:openai"), trend("topic:world-cup")];
});

const app = () => socialRoutes({ sql, chain, approvals: { check: async () => null }, sessionSecret: "s".repeat(64), isRevoked: async () => false, now: () => NOW * 1000 });
/** The moderation routes as an admin reaches them, signed in. */
const admin = () =>
  new Hono<{ Variables: { admin: string } }>()
    .use("*", async (c, next) => {
      c.set("admin", ADMIN);
      await next();
    })
    .route("/", moderationRoutes({ sql }));
type Requester = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
const get = async <T>(a: Requester, path: string) => {
  const res = await a.request(path);
  return { status: res.status, body: (await res.json()) as T };
};
const post = async <T>(a: Requester, path: string, body: unknown) => {
  const res = await a.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
};

let signatures = 0;
/** A call stored as the API stores one; returns its id. */
async function insertCall(o: { caller: string; identifier?: string; direction?: "up" | "down"; horizon?: number; calledAt?: number; opening?: number; outcome?: "open" | "hit" | "miss" | "void" }): Promise<number> {
  const identifier = o.identifier ?? "topic:openai";
  const calledAt = o.calledAt ?? NOW - 2 * DAY;
  const horizon = o.horizon ?? DAY;
  await sql`INSERT INTO callers (address) VALUES (${o.caller}) ON CONFLICT DO NOTHING`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO calls (caller, identifier, trend_id, direction, horizon_sec, signature, called_at, opening_index, resolves_at, outcome)
    VALUES (${o.caller}, ${identifier}, ${identifier}, ${o.direction ?? "up"}, ${horizon}, ${`sig-${++signatures}`}, ${calledAt}, ${o.opening ?? 50}, ${calledAt + horizon}, ${o.outcome ?? "open"})
    RETURNING id`;
  return Number(row!.id);
}
const checkpoint = (trendId: string, observedAt: number, points: number) => sql`INSERT INTO index_points (trend_id, observed_at, points) VALUES (${trendId}, ${observedAt}, ${points})`;
const callRow = async (id: number) => (await sql<{ outcome: string; closing_index: number | null }[]>`SELECT outcome, closing_index FROM calls WHERE id = ${id}`)[0]!;

describe("resolveCalls", () => {
  test("a call resolves at the first checkpoint at or after its window: up hits above the opening level, down misses", async () => {
    const calledAt = NOW - 2 * DAY;
    const end = calledAt + DAY;
    const up = await insertCall({ caller: ALICE, direction: "up", calledAt, opening: 50 });
    const down = await insertCall({ caller: BOB, direction: "down", calledAt, opening: 50 });
    // Inside the window, then the first checkpoint after it, then a later one that must not count.
    await checkpoint("topic:openai", end - 300, 40);
    await checkpoint("topic:openai", end + 120, 57.5);
    await checkpoint("topic:openai", end + 900, 30);

    expect(await resolveCalls(sql, chain, NOW)).toEqual({ resolved: 2 });
    expect(await callRow(up)).toEqual({ outcome: "hit", closing_index: 57.5 });
    expect(await callRow(down)).toEqual({ outcome: "miss", closing_index: 57.5 });
    // Resolved calls are not resolved again.
    expect(await resolveCalls(sql, chain, NOW)).toEqual({ resolved: 0 });
  });

  test("the outcome markets' rule at the opening level: up misses and down hits when attention ends flat", async () => {
    const up = await insertCall({ caller: ALICE, direction: "up", opening: 50 });
    const down = await insertCall({ caller: BOB, direction: "down", opening: 50 });
    await checkpoint("topic:openai", NOW - DAY, 50);
    await resolveCalls(sql, chain, NOW);
    expect(await callRow(up)).toEqual({ outcome: "miss", closing_index: 50 });
    expect(await callRow(down)).toEqual({ outcome: "hit", closing_index: 50 });
  });

  test("a call stays open until its window ends and a checkpoint after the end exists", async () => {
    const running = await insertCall({ caller: ALICE, calledAt: NOW - 3600 });
    const waiting = await insertCall({ caller: BOB, calledAt: NOW - 2 * DAY });
    // The only checkpoint is inside the window of the second call: no closing level yet.
    await checkpoint("topic:openai", NOW - 2 * DAY + 600, 70);
    expect(await resolveCalls(sql, chain, NOW)).toEqual({ resolved: 0 });
    expect((await callRow(running)).outcome).toBe("open");
    expect((await callRow(waiting)).outcome).toBe("open");
  });

  test("a trend retired before the end resolves at its last checkpoint, or voids the call without one", async () => {
    trends = [trend("topic:openai", "Retired"), trend("topic:world-cup", "Retired")];
    const retired = await insertCall({ caller: ALICE, direction: "down", opening: 50 });
    const empty = await insertCall({ caller: BOB, identifier: "topic:world-cup" });
    await checkpoint("topic:openai", NOW - 2 * DAY + 600, 61);
    await checkpoint("topic:openai", NOW - 2 * DAY + 1200, 42);
    expect(await resolveCalls(sql, chain, NOW)).toEqual({ resolved: 2 });
    expect(await callRow(retired)).toEqual({ outcome: "hit", closing_index: 42 });
    expect(await callRow(empty)).toEqual({ outcome: "void", closing_index: null });
  });
});

type Board = { callers: Array<{ address: string; hits: number; misses: number; open: number; resolved: number; hitRate: number; score: number }> };
type Profile = { stats: { hits: number; misses: number; open: number; resolved: number; total: number; hitRate: number; score: number }; calls: Array<{ id: string }> };

describe("leaderboard", () => {
  test("the Wilson lower bound ranks a long good record above a short perfect one", () => {
    expect(wilson(0, 0)).toBe(0);
    expect(wilson(1, 1)).toBeCloseTo(0.2065, 4);
    expect(wilson(3, 3)).toBeCloseTo(0.4385, 4);
    expect(wilson(9, 10)).toBeCloseTo(0.5958, 4);
    expect(wilson(5, 10)).toBeLessThan(wilson(50, 100));
  });

  test("ranks callers by score, then by resolved calls, and counts open and void calls apart", async () => {
    const many = async (caller: string, outcome: "hit" | "miss" | "open" | "void", n: number) => {
      for (let i = 0; i < n; i++) await insertCall({ caller, outcome });
    };
    await many(ALICE, "hit", 1);
    await many(BOB, "hit", 9);
    await many(BOB, "miss", 1);
    await many(CAROL, "hit", 2);
    await many(CAROL, "open", 2);
    await many(CAROL, "void", 1);
    await many(DAVE, "open", 3);
    await many(ERIN, "miss", 1);
    const { body } = await get<Board>(app(), "/callers/leaderboard");
    // 9 of 10 beats 2 of 2 beats 1 of 1; Erin and Dave both score 0, and Erin has a resolved call.
    expect(body.callers.map((c) => c.address)).toEqual([BOB, CAROL, ALICE, ERIN, DAVE]);
    expect(body.callers[0]).toMatchObject({ hits: 9, misses: 1, open: 0, resolved: 10, hitRate: 0.9 });
    expect(body.callers.map((c) => c.score)).toEqual([wilson(9, 10), wilson(2, 2), wilson(1, 1), 0, 0]);
    expect(body.callers[1]).toMatchObject({ hits: 2, misses: 0, open: 2, resolved: 2, hitRate: 1 });
    expect(body.callers[4]).toMatchObject({ hits: 0, misses: 0, open: 3, resolved: 0, hitRate: 0 });
  });

  test("a profile's record counts every call, as the leaderboard does, and lists the newest 100", async () => {
    for (let i = 0; i < 130; i++) await insertCall({ caller: ALICE, calledAt: NOW - 10 * DAY + i * 60, outcome: i < 30 ? "hit" : i < 110 ? "miss" : "open" });
    const { body } = await get<Profile>(app(), `/callers/${ALICE}`);
    expect(body.stats).toMatchObject({ hits: 30, misses: 80, open: 20, resolved: 110, total: 130 });
    expect(body.stats.score).toBeCloseTo(wilson(30, 110), 10);
    expect(body.calls).toHaveLength(100);
    // The newest 100 alone would read 0 hits of 80.
    const board = (await get<Board>(app(), "/callers/leaderboard")).body.callers[0]!;
    expect({ hits: board.hits, misses: board.misses, open: board.open, score: board.score }).toEqual({ hits: 30, misses: 80, open: 20, score: body.stats.score });
  });
});

describe("one call by id", () => {
  test("finds a call older than the trend thread's newest 100, with the caller's record", async () => {
    const first = await insertCall({ caller: ALICE, calledAt: NOW - 9 * DAY, outcome: "hit" });
    for (let i = 0; i < 120; i++) await insertCall({ caller: BOB, calledAt: NOW - 8 * DAY + i * 60 });
    const thread = await get<{ calls: Array<{ id: string }> }>(app(), "/trends/topic:openai/thread");
    expect(thread.body.calls.some((c) => Number(c.id) === first)).toBe(false);

    const { status, body } = await get<{ call: Record<string, unknown>; record: Record<string, number> }>(app(), `/calls/${first}`);
    expect(status).toBe(200);
    expect(body.call).toMatchObject({ id: first, caller: ALICE, handle: null, identifier: "topic:openai", direction: "up", horizon_sec: DAY, called_at: NOW - 9 * DAY, resolves_at: NOW - 8 * DAY, outcome: "hit" });
    expect(body.record).toMatchObject({ hits: 1, misses: 0, open: 0, resolved: 1, hitRate: 1 });
    expect((await get(app(), "/calls/99999")).status).toBe(404);
    expect((await get(app(), "/calls/abc")).status).toBe(404);
  });

  test("a call made through the API (signed by its identity) is found by the id it returned", async () => {
    const seed = ed25519.utils.randomSecretKey();
    const caller = Buffer.from(ed25519.getPublicKey(seed)).toString("hex");
    const call = { identifier: "topic:world-cup", direction: "down" as const, horizonSec: 604_800, note: "fading after the final", issuedAt: NOW };
    const signature = Buffer.from(ed25519.sign(new TextEncoder().encode(callMessage(call)), seed)).toString("base64");
    const made = await post<{ call: { id: number } }>(app(), "/calls", { caller, ...call, signature });
    expect(made.status).toBe(201);
    const { body } = await get<{ call: Record<string, unknown> }>(app(), `/calls/${made.body.call.id}`);
    expect(body.call).toMatchObject({ id: made.body.call.id, caller, identifier: "topic:world-cup", direction: "down", horizon_sec: 604_800, note: "fading after the final", opening_index: 50, called_at: NOW, outcome: "open" });
  });
});

describe("moderation", () => {
  type Page = { total: number; hidden: number; matching: number; rows: Array<{ id: number; hiddenAt: string | null; lastAction: { admin: string; action: string; reason: string } | null }> };

  test("hiding a call takes it out of the thread, the profile, the leaderboard and the share lookup; restoring brings it back", async () => {
    const hit = await insertCall({ caller: ALICE, outcome: "hit" });
    await insertCall({ caller: ALICE, outcome: "miss" });
    const visible = async () => ({
      thread: (await get<{ calls: unknown[] }>(app(), "/trends/topic:openai/thread")).body.calls.length,
      profile: (await get<Profile>(app(), `/callers/${ALICE}`)).body.stats,
      board: (await get<Board>(app(), "/callers/leaderboard")).body.callers[0],
      lookup: (await get(app(), `/calls/${hit}`)).status,
    });
    expect(await visible()).toMatchObject({ thread: 2, profile: { hits: 1, misses: 1, total: 2 }, board: { hits: 1, misses: 1 }, lookup: 200 });

    const hidden = await post<{ id: number; hiddenAt: string | null }>(admin(), `/social/calls/${hit}/hide`, { reason: "spam" });
    expect(hidden.status).toBe(200);
    expect(hidden.body.id).toBe(hit);
    expect(hidden.body.hiddenAt).not.toBeNull();
    expect(await visible()).toMatchObject({ thread: 1, profile: { hits: 0, misses: 1, total: 1 }, board: { hits: 0, misses: 1 }, lookup: 404 });
    // Hiding twice is refused; the row itself is untouched.
    expect(await post(admin(), `/social/calls/${hit}/hide`, { reason: "again" })).toEqual({ status: 409, body: { error: "that call is already hidden" } });
    expect(await callRow(hit)).toEqual({ outcome: "hit", closing_index: null });

    const listed = await get<Page>(admin(), "/social/calls?state=hidden");
    expect(listed.body).toMatchObject({ total: 2, hidden: 1, matching: 1 });
    expect(listed.body.rows[0]).toMatchObject({ id: hit, lastAction: { admin: ADMIN, action: "hide_call", reason: "spam" } });

    const restored = await post<{ id: number; hiddenAt: string | null }>(admin(), `/social/calls/${hit}/restore`, { reason: "appeal upheld" });
    expect(restored).toEqual({ status: 200, body: { id: hit, hiddenAt: null } });
    expect(await visible()).toMatchObject({ thread: 2, profile: { hits: 1, misses: 1, total: 2 }, board: { hits: 1, misses: 1 }, lookup: 200 });
    expect(await post(admin(), `/social/calls/${hit}/restore`, { reason: "again" })).toEqual({ status: 409, body: { error: "that call is not hidden" } });

    const log = (await get<{ log: Array<{ action: string; target: string; reason: string; admin: string; before: { id: string; hidden_at: string | null } }> }>(admin(), "/social/moderation")).body.log;
    expect(log.map((l) => [l.action, l.target, l.reason, l.admin])).toEqual([
      ["restore_call", `calls:${hit}`, "appeal upheld", ADMIN],
      ["hide_call", `calls:${hit}`, "spam", ADMIN],
    ]);
    expect(log[1]!.before.hidden_at).toBeNull();
    expect(log[0]!.before.hidden_at).not.toBeNull();
  });

  test("hides and restores a post, keeps its replies pointing at it, and filters lists by state and caller", async () => {
    await sql`INSERT INTO callers (address, handle) VALUES (${ALICE}, 'alice'), (${BOB}, NULL)`;
    const [parent] = await sql<{ id: string }[]>`INSERT INTO posts (caller, identifier, body, signature) VALUES (${ALICE}, 'topic:openai', 'buy the rumour', 'p1') RETURNING id`;
    await sql`INSERT INTO posts (caller, identifier, body, reply_to, signature) VALUES (${BOB}, 'topic:openai', 'sell the news', ${parent!.id}, 'p2')`;
    const id = Number(parent!.id);
    const thread = async () => (await get<{ posts: Array<{ id: string; reply_to: string | null }> }>(app(), "/trends/topic:openai/thread")).body.posts;

    expect((await post(admin(), `/social/posts/${id}/hide`, { reason: " " })).status).toBe(400);
    expect((await post(admin(), `/social/posts/${id}/hide`, { reason: "off topic" })).status).toBe(200);
    expect((await thread()).map((p) => p.reply_to)).toEqual([String(id)]);
    expect((await get<Page>(admin(), "/social/posts?state=visible")).body).toMatchObject({ total: 2, hidden: 1, matching: 1 });
    expect((await get<Page>(admin(), "/social/posts?caller=@alice")).body.rows.map((r) => r.id)).toEqual([id]);
    expect((await get<Page>(admin(), `/social/posts?caller=${BOB}&state=hidden`)).body.matching).toBe(0);
    expect((await post(admin(), "/social/posts/99999/restore", { reason: "x" })).status).toBe(404);

    expect((await post(admin(), `/social/posts/${id}/restore`, { reason: "fine after all" })).status).toBe(200);
    expect(await thread()).toHaveLength(2);
    const callers = (await get<{ callers: Array<{ address: string; handle: string | null; posts: number; hidden: number }> }>(admin(), "/social/callers?q=ali")).body.callers;
    expect(callers).toEqual([expect.objectContaining({ address: ALICE, handle: "alice", posts: 1, hidden: 0 })]);
  });

  test("renames a caller and logs the profile as it was", async () => {
    await sql`INSERT INTO callers (address, handle, bio) VALUES (${ALICE}, 'rude_name', 'hello'), (${BOB}, 'taken', NULL)`;
    expect((await post(admin(), `/social/callers/${ALICE}/profile`, { handle: "taken", reason: "rules" })).status).toBe(409);
    expect((await post(admin(), `/social/callers/${ALICE}/profile`, { handle: "caller_1", bio: "", reason: "handle broke the rules" })).status).toBe(200);
    expect((await get<{ caller: { handle: string; bio: string | null } }>(app(), "/callers/caller_1")).body.caller).toMatchObject({ handle: "caller_1", bio: null });
    const [entry] = (await get<{ log: Array<{ action: string; before: unknown }> }>(admin(), "/social/moderation")).body.log;
    expect(entry).toMatchObject({ action: "rename_caller", before: { address: ALICE, handle: "rude_name", bio: "hello" } });
  });
});
