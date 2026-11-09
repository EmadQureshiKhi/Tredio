import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { generateSealKeyPair, seal } from "@tredio/autopilot";
import type { Viewer } from "@tredio/chain";
import { AccountVersions, type SessionAction } from "@tredio/contracts";
import { implicitAccountOf, PolicyRefusal, type SessionCallResult, type WalletSigner, type WalletState } from "@tredio/custody";
import { buildOrder } from "../src/orders";
import type { ExecutorDb } from "../src/db";
import type { ExecutorStatus } from "../src/executor";
import { healthReport } from "../src/health";
import { silentLog } from "../src/log";
import { AUTOPILOT_POLICY, Nonces, type PlaceOrder, SessionVenue, sessionProblem, VenueError, WALLET_POLICY } from "../src/venue";
import { type GrantChain, Venues, walletKeyProblem } from "../src/venues";
import { credentialProblem, WalletGate, walletSessionChain } from "../src/wallets";
import { FakeAccount, FakeExchange, market, T, TEST_DATABASE_URL, testDb } from "./fakes";

const BTC = market("BTC", 3, 5, 76_000);
const API_KEY = `wk_${"ab".repeat(32)}`;

/** A custody enclave in memory: signs the account's session calls with the account's own Chain Signatures key, unless frozen or told to refuse. */
class FakeWallet implements WalletSigner {
  readonly kind = "outlayer" as const;
  readonly accountId: string;
  readonly sessionKey: string;
  state_: WalletState;
  policy: string | null = null;
  refusals: Error[] = [];
  calls: { owner: string; action: unknown; tgas: number }[] = [];
  reads = 0;

  constructor(readonly account: FakeAccount) {
    // The account's fake session is for this key: the wallet's implicit account is that key's.
    this.sessionKey = account.key.publicKey;
    this.accountId = implicitAccountOf(account.key.publicKey);
    account.session_ = { ...account.session_!, gas_key: false };
    this.state_ = { frozen: false, controller: account.account };
  }

  async sessionCall(owner: string, action: unknown, tgas: number): Promise<SessionCallResult> {
    const r = this.refusals.shift();
    if (r) throw r;
    if (this.state_.frozen) throw new PolicyRefusal("wallet_frozen", "Wallet is frozen", 403);
    this.calls.push({ owner, action, tgas });
    return this.account.sessionCall(action as SessionAction);
  }

  async state(): Promise<WalletState> {
    this.reads++;
    return this.state_;
  }

  async policyProblem(): Promise<string | null> {
    return this.policy;
  }
}

function openBtc(nonce = T * 1000): PlaceOrder {
  const order = buildOrder(BTC, { buy: true, worstPrice: 76_380, size: 0.0005, reduceOnly: false });
  if ("skip" in order) throw new Error(order.skip);
  return { market: BTC, action: "open", side: "long", order, leverage: null, nonce };
}

/** A viewer that answers the account's `session` view from the fake. */
const viewerOf = (account: FakeAccount) => ({ view: async (a: string, _m: string, args: { public_key: string }) => account.session(a, args.public_key) }) as unknown as Viewer;

function setup(o: { balance?: bigint | null } = {}) {
  const account = new FakeAccount("0uuser");
  const wallet = new FakeWallet(account);
  const exchange = new FakeExchange([BTC]);
  exchange.setMark("BTC", 76_000);
  exchange.fund(account.address, 1_000);
  let now = T * 1000;
  const gate = new WalletGate(wallet, account.account, { balance: async () => (o.balance === undefined ? 10n ** 23n : o.balance), minBalance: 5n * 10n ** 22n, ttlMs: 15_000, now: () => now });
  const versions = new AccountVersions(async () => 2);
  const venue = new SessionVenue({
    owner: account.account,
    kind: "grant",
    sessionKey: wallet.sessionKey,
    network: "testnet",
    policy: WALLET_POLICY,
    chain: walletSessionChain(viewerOf(account), wallet, account.account, versions),
    hyperliquid: exchange,
    addressOf: async () => account.address,
    nonces: new Nonces(),
    fund: async () => {
      throw new Error("a policy wallet pays its own gas");
    },
    gasMin: 0n,
    wallet: gate,
    checkTtlMs: 0,
    postRetryMs: 1,
    now: () => now,
  });
  return { account, wallet, exchange, gate, venue, tick: (ms: number) => void (now += ms) };
}

describe("a venue on a policy wallet", () => {
  test("the enclave signs the session call, with the gas the account's code needs, and the order goes out as the account signed it", async () => {
    const { wallet, exchange, venue } = setup();
    expect(venue.wallet?.kind).toBe("outlayer");
    const sent: string[] = [];
    const r = await venue.send(openBtc(), async (hash) => void sent.push(hash));
    expect(r).toMatchObject({ status: "filled", txHash: "tx1" });
    expect(sent).toEqual(["tx1"]);
    expect(wallet.calls).toEqual([{ owner: "0uuser", action: { hl_order: { order: openBtc().order, nonce: T * 1000 } }, tgas: 150 }]);
    expect(exchange.posted.map((p) => p.action.type)).toEqual(["order"]);
  });

  test("a frozen wallet makes the venue wait; one the account does not control, or wider than Autopilot's, stops it", async () => {
    const frozen = setup();
    frozen.wallet.state_ = { ...frozen.wallet.state_, frozen: true };
    const e1 = await frozen.venue.send(openBtc(), async () => {}).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(VenueError);
    expect((e1 as VenueError).retryable).toBe(true);
    expect((e1 as VenueError).message).toContain("froze Autopilot's policy wallet");
    expect(frozen.wallet.calls).toHaveLength(0);

    const stolen = setup();
    stolen.wallet.state_ = { frozen: false, controller: "mallory.testnet" };
    const e2 = (await stolen.venue.send(openBtc(), async () => {}).catch((e: unknown) => e)) as VenueError;
    expect([e2.retryable, e2.message]).toEqual([false, expect.stringContaining("controlled by mallory.testnet")]);

    const wide = setup();
    wide.wallet.policy = "the policy lets the wallet call contracts other than the account";
    const e3 = (await wide.venue.send(openBtc(), async () => {}).catch((e: unknown) => e)) as VenueError;
    expect([e3.retryable, e3.message]).toEqual([false, expect.stringContaining("not Autopilot's")]);
  });

  test("an account whose code takes session calls only from its own keys makes the wallet wait", async () => {
    const account = new FakeAccount("0uold");
    const wallet = new FakeWallet(account);
    const gate = new WalletGate(wallet, account.account, { balance: async () => 10n ** 24n, minBalance: 0n, accepts: async () => false });
    expect(await gate.check()).toEqual({ reason: expect.stringContaining("takes session calls only from its own keys"), pause: false });
  });

  test("a wallet low on gas waits for its account to fund it", async () => {
    const { venue, wallet } = setup({ balance: 10n ** 22n });
    const e = (await venue.send(openBtc(), async () => {}).catch((x: unknown) => x)) as VenueError;
    expect([e.retryable, e.message]).toEqual([true, expect.stringContaining("holds 0.01 NEAR for gas")]);
    expect(wallet.calls).toHaveLength(0);
  });

  test("the enclave's refusals: a freeze it saw first may pass later, its policy never", async () => {
    const { venue, wallet } = setup();
    wallet.refusals.push(new PolicyRefusal("wallet_frozen", "Wallet is frozen", 403), new PolicyRefusal("policy_denied", "Address is not in whitelist", 403));
    const later = (await venue.send(openBtc(), async () => {}).catch((e: unknown) => e)) as VenueError;
    expect([later.retryable, later.message]).toEqual([true, "the policy wallet refused (wallet_frozen): Wallet is frozen"]);
    const never = (await venue.send(openBtc(T * 1000 + 1), async () => {}).catch((e: unknown) => e)) as VenueError;
    expect([never.retryable, never.message]).toEqual([false, "the policy wallet refused (policy_denied): Address is not in whitelist"]);
  });

  test("the gate reads the wallet at most once per window, then again", async () => {
    const { gate, wallet, tick } = setup();
    expect(await gate.check()).toBeNull();
    expect(await gate.check()).toBeNull();
    expect(wallet.reads).toBe(1);
    expect(gate.last).toMatchObject({ owner: "0uuser", kind: "outlayer", frozen: false, balance: "0.1", problem: null });
    wallet.state_ = { ...wallet.state_, frozen: true };
    tick(16_000);
    expect((await gate.check())?.pause).toBe(false);
    expect(gate.last?.frozen).toBe(true);
    wallet.state = async () => {
      throw new Error("rpc 429");
    };
    gate.forget();
    expect(await gate.check()).toEqual({ reason: "could not check the policy wallet: rpc 429", pause: false });
  });

  test("a policy wallet's session is a plain key for the wallet's own key; a sealed grant's is a gas key", () => {
    const base = { label: "autopilot", scope: { outcomes: false, perps: false, hyperliquid: true }, created_at: 0, expires_at: T + 60, daily_limit: "0", spent: "0", day: 0, gas_key: false };
    expect(sessionProblem(base, T, WALLET_POLICY)).toBeNull();
    expect(sessionProblem({ ...base, gas_key: true }, T, WALLET_POLICY)).toContain("gas key");
    expect(sessionProblem(base, T, AUTOPILOT_POLICY)).toBe("the session key is not a gas key");
    expect(walletKeyProblem("0uuser", null)).toBeNull();
    expect(walletKeyProblem("0uuser", { kind: "function_call", receiverId: "0uuser", methodNames: ["session_call"], gasKey: false })).toBeNull();
    expect(walletKeyProblem("0uuser", { kind: "full" })).toContain("not limited");
    expect(walletKeyProblem("0uuser", { kind: "function_call", receiverId: "0uuser", methodNames: ["session_call"], gasKey: true })).toContain("gas key");
    expect(credentialProblem("outlayer", API_KEY)).toBeNull();
    expect(credentialProblem("outlayer", "ed25519:abc")).toContain("OutLayer");
    expect(credentialProblem("agent-api", `ngt_${"x".repeat(43)}`)).toBeNull();
  });
});

describe("/health with policy wallets", () => {
  test("lists each wallet with its freeze, gas and why it waits, and sums them up for the status page", async () => {
    const status: ExecutorStatus = { lastTickAt: T - 5, lastTickMs: 100, lastError: null, failingTicks: 0, kill: { engaged: false, reason: null }, rules: 1, ticks: 3 };
    const stats = async () => ({ rules: 1, grants: 3, follows: 0, leaders: 0, inFlight: 0, today: { filled: 0, unfilled: 0, failed: 0 } });
    const checks = [
      { owner: "0ua", kind: "outlayer" as const, account: "a".repeat(64), frozen: false, balance: "0.2", problem: null, checkedAt: T },
      { owner: "0ub", kind: "outlayer" as const, account: "b".repeat(64), frozen: true, balance: "0.2", problem: "the account froze Autopilot's policy wallet", checkedAt: T },
      { owner: "0uc", kind: "outlayer" as const, account: "c".repeat(64), frozen: false, balance: "0.01", problem: "the policy wallet holds 0.01 NEAR for gas", checkedAt: T },
    ];
    const r = await healthReport({ network: "testnet", tickSec: 15, sealKeyId: "k", now: () => T * 1000, status: () => status, stats, wallet: async () => null, policyWallets: () => checks });
    expect(r.httpStatus).toBe(200);
    expect(r.body.policyWallets).toEqual(checks);
    expect(r.body.facts).toContainEqual({ label: "Policy wallets", value: "3 in use, 1 frozen by their accounts, 1 waiting", tone: "warn" });
  });
});

const maybe = TEST_DATABASE_URL ? describe : describe.skip;
let db: ExecutorDb;
let drop: () => Promise<void>;

maybe("grants backed by a policy wallet", () => {
  beforeAll(async () => {
    ({ db, drop } = await testDb());
  });
  afterAll(async () => drop());
  beforeEach(async () => {
    await db.sql`TRUNCATE autopilot_grants, autopilot_grant_keys, autopilot_grant_wallets, autopilot_audit RESTART IDENTITY CASCADE`;
  });

  async function resolver(wallet: FakeWallet, sealed: string, pair: { privateKey: string }) {
    const made: string[] = [];
    const chain: GrantChain = {
      session: async (a, k) => wallet.account.session(a, k),
      accessKey: async () => ({ kind: "function_call", receiverId: wallet.account.account, methodNames: ["session_call"], gasKey: false }),
    };
    const exchange = new FakeExchange([BTC]);
    const venues = new Venues(
      db,
      chain,
      (r) => {
        made.push(`${r.kind}|${r.secretKey}|${r.wallet?.kind}|${r.wallet?.account}`);
        return new SessionVenue({
          owner: r.owner,
          kind: r.kind,
          sessionKey: r.sessionKey,
          network: "testnet",
          policy: WALLET_POLICY,
          chain: wallet.account,
          hyperliquid: exchange,
          addressOf: async () => wallet.account.address,
          nonces: new Nonces(),
          fund: async () => 0n,
          gasMin: 0n,
          wallet: new WalletGate(wallet, r.owner, { balance: async () => 10n ** 23n, minBalance: 0n, ttlMs: 0 }),
        });
      },
      { sealPrivateKey: pair.privateKey, bot: null },
      silentLog,
    );
    await db.sql`INSERT INTO autopilot_grants (owner, session_key, sealed_key, status, valid_until, daily_limit) VALUES (${wallet.account.account}, ${wallet.sessionKey}, ${sealed}, 'active', ${T + 86_400}, 500000000)`;
    await db.sql`INSERT INTO autopilot_grant_wallets (session_key, owner, kind, account) VALUES (${wallet.sessionKey}, ${wallet.account.account}, 'outlayer', ${wallet.accountId})`;
    return { venues, made };
  }

  test("the box opens to the wallet's key, the venue signs through the wallet, and a freeze makes rules wait instead of pausing", async () => {
    const pair = await generateSealKeyPair();
    const wallet = new FakeWallet(new FakeAccount("0uowner"));
    const sealed = await seal(API_KEY, pair.publicKey, { owner: "0uowner", sessionKey: wallet.sessionKey });
    const { venues, made } = await resolver(wallet, sealed, pair);
    await venues.refresh(T);
    const r = await venues.forOwner("0uowner", "session", T);
    expect("venue" in r && r.venue.wallet?.account).toBe(wallet.accountId);
    expect(made).toEqual([`grant|${API_KEY}|outlayer|${wallet.accountId}`]);
    expect(venues.walletChecks()).toEqual([expect.objectContaining({ owner: "0uowner", account: wallet.accountId, frozen: false, problem: null })]);

    wallet.state_ = { ...wallet.state_, frozen: true };
    expect(await venues.forOwner("0uowner", "session", T)).toEqual({ reason: expect.stringContaining("froze Autopilot's policy wallet"), pause: false });
    wallet.state_ = { ...wallet.state_, frozen: false };
    expect("venue" in (await venues.forOwner("0uowner", "session", T))).toBe(true);
  });

  test("a box that does not hold a wallet key is refused once, as unusable", async () => {
    const pair = await generateSealKeyPair();
    const wallet = new FakeWallet(new FakeAccount("0uother"));
    const sealed = await seal("ed25519:not-a-wallet-key", pair.publicKey, { owner: "0uother", sessionKey: wallet.sessionKey });
    const { venues, made } = await resolver(wallet, sealed, pair);
    await venues.refresh(T);
    expect(await venues.forOwner("0uother", "session", T)).toEqual({ reason: expect.stringContaining("does not open to an OutLayer wallet key"), pause: true });
    expect(made).toEqual([]);
  });

  test("the grant ends when the wallet's session is gone on chain", async () => {
    const pair = await generateSealKeyPair();
    const wallet = new FakeWallet(new FakeAccount("0ugone"));
    const sealed = await seal(API_KEY, pair.publicKey, { owner: "0ugone", sessionKey: wallet.sessionKey });
    const { venues } = await resolver(wallet, sealed, pair);
    wallet.account.session_ = null;
    await venues.refresh(T);
    expect(await venues.forOwner("0ugone", "session", T)).toEqual({ reason: "no active Autopilot grant for the account", pause: true });
    expect((await db.sql<{ status: string }[]>`SELECT status FROM autopilot_grants WHERE owner = '0ugone'`)[0]?.status).toBe("revoked");
  });
});
