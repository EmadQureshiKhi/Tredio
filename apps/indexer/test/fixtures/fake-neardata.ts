import type { Block } from "../../src/neardata";

/** A neardata stand-in serving `blocks` (null = skipped height); anything else is in the future. */
export function fakeNeardata(blocks: Map<number, Block | null>, final: () => number) {
  const paths: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === "/v0/last_block/final") {
      return new Response(null, { status: 302, headers: { location: `/v0/block/${final()}` } });
    }
    const h = Number(/^\/v0\/block\/(\d+)$/.exec(url.pathname)?.[1]);
    if (!blocks.has(h)) {
      return Response.json({ error: "The block is too far in the future", type: "BLOCK_DOES_NOT_EXIST" }, { status: 404 });
    }
    return new Response(JSON.stringify(blocks.get(h)), { headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, paths };
}
