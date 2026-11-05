import { afterEach, describe, expect, test } from "bun:test";
import { activation, ApiError } from "../src/lib/api";

const realFetch = globalThis.fetch;
const account = "account-a1";
const answer = (status: number, body: unknown) => {
  const seen: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return seen;
};

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("activation tickets during sign-up", () => {
  test("asks the API for the new account's ticket", async () => {
    const seen = answer(200, { expiresAt: 1_800_000_600, signature: "ticket-signature" });
    expect(await activation.ticket(account)).toEqual({ expiresAt: 1_800_000_600, signature: "ticket-signature" });
    expect(seen[0]!.url).toEndWith("/v1/activation-ticket");
    expect(seen[0]!.body).toEqual({ account });
  });

  test("goes on without one when the API has no ticket key, so the relayer decides", async () => {
    answer(503, { error: "activation tickets are not configured" });
    expect(await activation.ticket(account)).toBeNull();
    answer(404, { error: "not found" });
    expect(await activation.ticket(account)).toBeNull();
  });

  test("stops on the API's refusals, with its message", async () => {
    answer(429, { error: "Too many new accounts from this network for now. Try again later, or sign in with a passkey you already have." });
    const refused = await activation.ticket(account).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).message).toStartWith("Too many new accounts");
    answer(503, { error: "Could not check the account; try again." });
    await expect(activation.ticket(account)).rejects.toThrow("Could not check the account");
  });
});
