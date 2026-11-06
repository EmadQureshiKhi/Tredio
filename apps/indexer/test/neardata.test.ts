import { describe, expect, test } from "bun:test";
import { silentLog } from "../src/log";
import { FatalError, Neardata, RateLimiter } from "../src/neardata";
import { fakeNeardata } from "./fixtures/fake-neardata";
import { scenario } from "./fixtures/scenario";

const client = (fetch: typeof globalThis.fetch, ...apiKeys: string[]) =>
  new Neardata({ baseUrl: "https://testnet.neardata.example", rpm: 6000, log: silentLog, fetch, apiKeys, throttleMs: 50 });

describe("Neardata", () => {
  test("blocks, skipped heights, future heights and the final head", async () => {
    const fake = fakeNeardata(scenario(), () => 1005);
    const nd = client(fake.fetch);
    const b = await nd.block(1000);
    expect(b.kind).toBe("block");
    expect(b.kind === "block" && b.block.block.header.height).toBe(1000);
    expect(await nd.block(1001)).toEqual({ kind: "skipped", height: 1001 });
    expect(await nd.block(1006)).toEqual({ kind: "future", height: 1006 });
    expect(await nd.finalHeight()).toBe(1005);
    expect(fake.paths).toEqual(["/v0/block/1000", "/v0/block/1001", "/v0/block/1006", "/v0/last_block/final"]);
  });

  test("follows redirects by hand and keeps the API key header", async () => {
    const seen: Array<[string, string | null]> = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push([url.href, new Headers(init?.headers).get("authorization")]);
      if (url.host === "testnet.neardata.example") {
        return new Response(null, { status: 302, headers: { location: "https://archive.neardata.example/v0/block/7" } });
      }
      return new Response("null");
    }) as typeof globalThis.fetch;
    expect(await client(fetch, "k-123").block(7)).toEqual({ kind: "skipped", height: 7 });
    expect(seen).toEqual([
      ["https://testnet.neardata.example/v0/block/7", "Bearer k-123"],
      ["https://archive.neardata.example/v0/block/7", "Bearer k-123"],
    ]);
  });

  test("a 429 pauses every request, even with Retry-After 0; 5xx retries; 401 is fatal", async () => {
    const at: number[] = [];
    let n = 0;
    const flaky = (async () => {
      at.push(Date.now());
      n++;
      if (n === 1) return new Response("rate-limit exceeded", { status: 429, headers: { "retry-after": "0" } });
      if (n === 2) return new Response("oops", { status: 502 });
      return new Response("null");
    }) as unknown as typeof globalThis.fetch;
    expect(await client(flaky).block(5)).toEqual({ kind: "skipped", height: 5 });
    expect(n).toBe(3);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(45);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(700);

    const denied = (async () => new Response("Unauthorized", { status: 401 })) as unknown as typeof globalThis.fetch;
    await expect(client(denied, "bad").block(5)).rejects.toBeInstanceOf(FatalError);
  });

  test("several keys take turns, and a refused one is dropped while the others carry on", async () => {
    const seen: string[] = [];
    const fetch = (async (_: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      seen.push(auth);
      return auth === "Bearer bad" ? new Response("Invalid API key", { status: 403 }) : new Response("null");
    }) as typeof globalThis.fetch;
    const nd = client(fetch, "k1", "bad", "k2");
    for (const h of [1, 2, 3, 4]) expect(await nd.block(h)).toEqual({ kind: "skipped", height: h });
    // The refused key is asked once; its request goes again at once on the next key, and the two left alternate.
    expect(seen).toEqual(["Bearer k1", "Bearer bad", "Bearer k1", "Bearer k2", "Bearer k1"]);
  });

  test("a height below the archive is fatal", async () => {
    const low = (async () => Response.json({ error: "too low", type: "BLOCK_HEIGHT_TOO_LOW" }, { status: 404 })) as unknown as typeof globalThis.fetch;
    await expect(client(low).block(1)).rejects.toBeInstanceOf(FatalError);
  });
});

describe("RateLimiter", () => {
  test("spaces requests at the configured rate after the burst", async () => {
    const l = new RateLimiter(600, 1); // 10 a second
    const t0 = Date.now();
    for (let i = 0; i < 4; i++) await l.take();
    const ms = Date.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(280);
    expect(ms).toBeLessThan(1_000);
  });
});
