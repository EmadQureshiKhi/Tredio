import { describe, expect, test } from "bun:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { orderAction } from "@tredio/hyperliquid";
import { buildOrder } from "../src/orders";
import { AUTOPILOT_POLICY, Nonces, type PlaceOrder, relayerFunding, SessionVenue, sessionProblem, VenueError } from "../src/venue";
import { FakeAccount, FakeExchange, market, T } from "./fakes";

const BTC = market("BTC", 3, 5, 76_000);

function setup(o: { funded?: boolean; label?: string } = {}) {
  const account = new FakeAccount("0uuser", o.label);
  const exchange = new FakeExchange([market("SOL", 0, 2, 90), BTC]);
  exchange.setMark("BTC", 76_000);
  if (o.funded !== false) exchange.fund(account.address, 1_000);
  const funded: string[] = [];
  const venue = new SessionVenue({
    owner: account.account,
    kind: "grant",
    sessionKey: account.key.publicKey,
    network: "testnet",
    policy: AUTOPILOT_POLICY,
    chain: account,
    hyperliquid: exchange,
    addressOf: async () => account.address,
    nonces: new Nonces(),
    fund: async () => {
      funded.push(account.account);
      account.gas = 35n * 10n ** 22n;
      return account.gas;
    },
    gasMin: 31n * 10n ** 22n,
    gasNeeded: 30n * 10n ** 22n,
    postRetryMs: 1,
    now: () => T * 1000,
  });
  return { account, exchange, venue, funded };
}

function openBtc(nonce = T * 1000, leverage: number | null = 2): PlaceOrder {
  const order = buildOrder(BTC, { buy: true, worstPrice: 76_380, size: 0.0005, reduceOnly: false });
  if ("skip" in order) throw new Error(order.skip);
  return { market: BTC, action: "open", side: "long", order, leverage, nonce };
}

describe("session venue", () => {
  test("sets isolated leverage first, then posts exactly the order the account signed", async () => {
    const { account, exchange, venue } = setup();
    const sent: string[] = [];
    const o = openBtc();
    const r = await venue.send(o, async (hash) => void sent.push(hash));
    expect(account.calls.map((c) => Object.keys(c as object)[0])).toEqual(["hl_leverage", "hl_order"]);
    expect(account.calls[0]).toMatchObject({ hl_leverage: { asset_index: 3, is_cross: false, leverage: 2 } });
    expect(exchange.posted.map((p) => p.action.type)).toEqual(["updateLeverage", "order"]);
    // Hyperliquid recovered the account's own address from both signatures.
    expect(exchange.posted.every((p) => p.user === account.address)).toBe(true);
    expect(exchange.posted[1]).toMatchObject({ action: orderAction(o.order), nonce: o.nonce });
    expect(sent).toEqual(["tx2"]);
    expect(r).toMatchObject({ status: "filled", txHash: "tx2", size: 0.0005, price: 76_000 });
    if (r.status !== "filled") throw new Error("not filled");
    expect(r.feeUsdc).toBeCloseTo(0.0005 * 76_000 * 0.00045);
    expect(r.closedPnlUsdc).toBe(0);
  });

  test("leaves leverage alone when the market is already at it, and on closes", async () => {
    const { account, venue } = setup();
    await venue.send(openBtc(), async () => {});
    account.calls = [];
    await venue.send(openBtc(T * 1000 + 10), async () => {});
    expect(account.calls.map((c) => Object.keys(c as object)[0])).toEqual(["hl_order"]);
  });

  test("Hyperliquid's refusals and misses come back as results, not errors", async () => {
    const { exchange, venue } = setup({ funded: false });
    const refused = await venue.send(openBtc(T * 1000, null), async () => {});
    expect(refused).toEqual({ status: "failed", txHash: "tx1", error: expect.stringContaining("does not exist") });
    exchange.fund((await venue.address()), 1_000);
    exchange.setMark("BTC", 77_000);
    expect(await venue.send(openBtc(T * 1000 + 1, null), async () => {})).toMatchObject({ status: "unfilled", error: expect.stringContaining("could not immediately match") });
    // The same nonce again: Hyperliquid has seen it.
    expect(await venue.send(openBtc(T * 1000 + 1, null), async () => {})).toMatchObject({ status: "seen" });
  });

  test("a leverage change that landed but lost its answer is not mistaken for a refusal", async () => {
    const { exchange, venue } = setup();
    const post = exchange.post.bind(exchange);
    let lost = 1;
    exchange.post = async (action, nonce, sig) => {
      const r = await post(action, nonce, sig);
      if (action.type === "updateLeverage" && lost-- > 0) throw new Error("socket hang up");
      return r;
    };
    expect((await venue.send(openBtc(), async () => {})).status).toBe("filled");
    expect(exchange.posted.map((p) => p.action.type)).toEqual(["updateLeverage", "updateLeverage", "order"]);
  });

  test("a leverage change Hyperliquid refuses stops the order before it is signed", async () => {
    const { account, venue } = setup({ funded: false });
    const r = await venue.send(openBtc(), async () => {});
    expect(r).toMatchObject({ status: "failed", txHash: "tx1", error: expect.stringContaining("refused 2x isolated leverage") });
    expect(account.calls).toHaveLength(1);
  });

  test("checks the session on chain first: gone, expired, mislabelled or wider than Hyperliquid", async () => {
    const { account, venue } = setup();
    account.session_ = null;
    expect(venue.send(openBtc(), async () => {})).rejects.toThrow("no such session");
    expect(account.calls).toHaveLength(0);
    const base = { label: "autopilot", scope: { outcomes: false, perps: false, hyperliquid: true }, created_at: 0, expires_at: T + 60, daily_limit: "0", spent: "0", day: 0, gas_key: true };
    expect(sessionProblem(base, T, AUTOPILOT_POLICY)).toBeNull();
    expect(sessionProblem({ ...base, expires_at: T }, T, AUTOPILOT_POLICY)).toBe("the session expired");
    expect(sessionProblem({ ...base, label: "e2e" }, T, AUTOPILOT_POLICY)).toBe("the session is labelled e2e, not autopilot");
    expect(sessionProblem({ ...base, scope: { outcomes: true, perps: false, hyperliquid: true } }, T, AUTOPILOT_POLICY)).toContain("more than Hyperliquid");
    expect(sessionProblem({ ...base, scope: { outcomes: false, perps: false, hyperliquid: false } }, T, AUTOPILOT_POLICY)).toBe("the session cannot trade Hyperliquid");
    expect(sessionProblem({ ...base, gas_key: false }, T, AUTOPILOT_POLICY)).toBe("the session key is not a gas key");
    expect(sessionProblem({ ...base, label: "e2e", scope: { outcomes: true, perps: true, hyperliquid: true } }, T, { label: null, hyperliquidOnly: false })).toBeNull();
  });

  test("tops the gas key up through the relayer when low, and waits when it cannot", async () => {
    const low = setup();
    low.account.gas = 30n * 10n ** 22n;
    await low.venue.send(openBtc(T * 1000, null), async () => {});
    expect(low.funded).toEqual(["0uuser"]);

    const { account, exchange } = setup();
    account.gas = 29n * 10n ** 22n;
    const venue = new SessionVenue({
      owner: account.account,
      kind: "grant",
      sessionKey: account.key.publicKey,
      network: "testnet",
      policy: AUTOPILOT_POLICY,
      chain: account,
      hyperliquid: exchange,
      addressOf: async () => account.address,
      nonces: new Nonces(),
      fund: async () => {
        throw new Error("this session was topped up enough today; try again tomorrow");
      },
      gasMin: 31n * 10n ** 22n,
      gasNeeded: 30n * 10n ** 22n,
      now: () => T * 1000,
    });
    const e = (await venue.send(openBtc(), async () => {}).catch((x: unknown) => x)) as VenueError;
    expect(e).toBeInstanceOf(VenueError);
    expect(e.retryable).toBe(true);
    expect(e.message).toBe("the session's gas key holds 0.29 NEAR, below the 0.3 NEAR a session call prepays; the relayer did not top it up: this session was topped up enough today; try again tomorrow");
    expect(venue.lastFundError).toContain("topped up enough");
  });

  test("a signature that does not recover to the account's address is never posted", async () => {
    const { account, exchange, venue } = setup();
    account.wrongKey = secp256k1.utils.randomSecretKey();
    const e = (await venue.send(openBtc(T * 1000, null), async () => {}).catch((x: unknown) => x)) as VenueError;
    expect(e.retryable).toBe(false);
    expect(e.message).toContain("not its Hyperliquid address");
    expect(exchange.posted).toHaveLength(0);
  });

  test("the guard's refusals: a stale mark waits for the next one, a price outside 2% does not", async () => {
    const { account, venue } = setup();
    account.failures.push(new Error("stale mark"));
    expect(((await venue.send(openBtc(T * 1000, null), async () => {}).catch((x: unknown) => x)) as VenueError).retryable).toBe(true);
    account.failures.push(new Error("price outside 2% of the mark"));
    expect(((await venue.send(openBtc(T * 1000, null), async () => {}).catch((x: unknown) => x)) as VenueError).retryable).toBe(false);
    account.failures.push(new Error("fetch failed"));
    expect(((await venue.send(openBtc(T * 1000, null), async () => {}).catch((x: unknown) => x)) as VenueError).retryable).toBe(true);
  });

  test("Hyperliquid down: posts are retried, then the order waits with its signature spent", async () => {
    const { exchange, venue } = setup();
    exchange.down = 2;
    expect((await venue.send(openBtc(T * 1000, null), async () => {})).status).toBe("filled");
    exchange.down = 3;
    const sent: string[] = [];
    const e = (await venue.send(openBtc(T * 1000 + 5, null), async (h) => void sent.push(h)).catch((x: unknown) => x)) as VenueError;
    expect(e.retryable).toBe(true);
    expect(e.message).toBe("Hyperliquid did not answer: fetch failed");
    expect(sent).toHaveLength(1);
  });
});

describe("relayer top-ups", () => {
  test("asks the relayer for the account's session key and returns the balance it reports", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ hash: "abc", balance: "350000000000000000000000" }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await relayerFunding("http://relayer:4100/", "0uuser", "ed25519:key", fetchImpl)()).toBe(35n * 10n ** 22n);
    expect(seen).toEqual([{ url: "http://relayer:4100/v1/sessions/fund", body: { account: "0uuser", publicKey: "ed25519:key" } }]);
    const refusing = (async () => new Response(JSON.stringify({ error: "not a Tredio account" }), { status: 403 })) as unknown as typeof fetch;
    expect(relayerFunding("http://relayer:4100", "x", "k", refusing)()).rejects.toThrow("not a Tredio account");
  });

  test("nonces are milliseconds and strictly increase", () => {
    const n = new Nonces(() => 1000);
    expect([n.next(), n.next(), n.next()]).toEqual([1000, 1001, 1002]);
  });
});
