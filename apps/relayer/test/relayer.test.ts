import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58Encode, type Sender, type Viewer } from "@tredio/chain";
import { activationTicketMessage, deployment, ownerRequest, requestChallenge, requestJson } from "@tredio/contracts";
import { encodeSignedDelegateAction } from "near-kit";
import { metaAllowlist, RelayError, Relayer, Window } from "../src/relayer";
import { TxError } from "@tredio/chain";

const D = deployment("testnet");
const NOW = 1_793_900_000_000;

function passkey() {
  const secret = p256.utils.randomSecretKey();
  const ownerKey = `p256:${base58Encode(p256.getPublicKey(secret, true))}`;
  const prove = async (request: string) => {
    const challenge = await requestChallenge(request);
    const client = JSON.stringify({ type: "webauthn.get", challenge: Buffer.from(challenge).toString("base64url"), origin: "https://app.tredio.bid" });
    const auth = new Uint8Array([...sha256(new TextEncoder().encode("tredio.bid")), 0x05, 0, 0, 0, 1]);
    const sig = p256.sign(sha256(new Uint8Array([...auth, ...sha256(new TextEncoder().encode(client))])), secret, { prehash: false, lowS: true });
    return { authenticator_data: Buffer.from(auth).toString("base64url"), client_data_json: client, signature: Buffer.from(sig).toString("hex") };
  };
  return { ownerKey, prove };
}

const ticketSeed = ed25519.utils.randomSecretKey();
const ticketSigner = `ed25519:${base58Encode(ed25519.getPublicKey(ticketSeed))}`;
const ticketFor = (ownerKey: string, account: string, expiresAt = NOW / 1000 + 600) => ({
  ownerKey,
  account,
  expiresAt,
  signature: Buffer.from(ed25519.sign(activationTicketMessage({ network: "testnet", ownerKey, account, expiresAt }), ticketSeed)).toString("base64"),
});

/** A chain where `existing` accounts exist and each owner key derives to `0u` + 52 a's with its last char. */
function fakes(opts: { existing?: Set<string>; owners?: Map<string, string>; session?: { expires_at: number; gas_key: boolean } | null; gasKey?: bigint; account?: { amount: bigint; storage: number }; storage?: bigint } = {}) {
  const sent: Array<{ kind: string; detail: unknown }> = [];
  const derive = (ownerKey: string) => `0u${ownerKey.slice(-1).toLowerCase().repeat(52)}`;
  const viewer = {
    view: async (contract: string, method: string, args: Record<string, string>) => {
      if (method === "account_id_of") return derive(args.owner_key!);
      if (method === "owner_key") {
        const k = opts.owners?.get(contract);
        if (!k) throw new Error("CodeDoesNotExist");
        return k;
      }
      if (method === "nonce_used") return false;
      if (method === "session") return opts.session ?? null;
      if (method === "storage_balance_of") return opts.storage === undefined ? null : { total: "10000000000000000000000", available: opts.storage.toString() };
      throw new Error(`unexpected view ${method}`);
    },
    rpc: async (_m: string, p: { account_id: string }) => {
      if (opts.account && opts.owners?.has(p.account_id)) return { amount: opts.account.amount.toString(), storage_usage: opts.account.storage };
      if (opts.existing?.has(p.account_id)) return {};
      throw new Error(`UNKNOWN_ACCOUNT ${p.account_id}`);
    },
    gasKey: async () => (opts.gasKey === undefined ? null : { balance: opts.gasKey, nonces: 4 }),
  } as unknown as Viewer;
  const sender = {
    accountId: "relayer.testnet",
    send: async (call: unknown) => (sent.push({ kind: "call", detail: call }), { hash: "tx1", value: null }),
    sendOutcome: async (call: unknown) => (
      sent.push({ kind: "call", detail: call }),
      { status: { SuccessValue: "" }, transaction: { hash: "tx1" }, receipts_outcome: [{ id: "r1", outcome: { status: { SuccessValue: "" }, logs: ['EVENT_JSON:{"standard":"tredio","version":"1.0.0","event":"order_placed","data":[{"id":"9"}]}'], executor_id: "book.tredio.testnet" } }] }
    ),
    fundGasKey: async (account: string, pk: string, amount: bigint) => (sent.push({ kind: "fund", detail: { account, pk, amount } }), { transaction: { hash: "tx2" } }),
    sendTx: async (build: (tx: unknown) => unknown) => {
      const actions: unknown[] = [];
      const tx = {
        transfer: (to: string, amount: string) => (actions.push({ transfer: { to, amount } }), tx),
        signedDelegateAction: (sd: unknown) => (actions.push({ delegate: sd }), tx),
      };
      build(tx);
      sent.push({ kind: "tx", detail: actions });
      return { transaction: { hash: "tx3" } };
    },
  } as unknown as Sender;
  return { viewer, sender, sent, derive };
}

const limits = { accountsPerHour: 2, accountsPerDay: 10, ownerCallsPerAccountPerHour: 10, topupsPerSessionPerDay: 1, topupsPerAccountPerDay: 2, storageTopupsPerAccountPerDay: 4, metaPerAccountPerHour: 5, nearPerHour: 10n ** 25n };
const relayer = (f: ReturnType<typeof fakes>, ticket: string | null = ticketSigner) =>
  new Relayer({ sender: f.sender, viewer: f.viewer, deployment: D, ticketSigner: ticket, createDeposit: 4n * 10n ** 23n, sessionGasTarget: 35n * 10n ** 22n, sessionGasMin: 31n * 10n ** 22n, sessionStorageMin: 15n * 10n ** 22n, sessionStorageTarget: 2n * 10n ** 23n, limits, now: () => NOW });

describe("creating accounts", () => {
  test("creates an account with a valid ticket and a proof of its first request", async () => {
    const f = fakes();
    const pk = passkey();
    const account = f.derive(pk.ownerKey);
    const request = requestJson(ownerRequest(account, "testnet", [], NOW));
    const out = await relayer(f).createAccount({ ownerKey: pk.ownerKey, request, proof: await pk.prove(request), ticket: ticketFor(pk.ownerKey, account) });
    expect(out).toEqual({ account, hash: "tx1" });
    expect(f.sent[0]!.detail).toMatchObject({ receiverId: D.contracts.accounts, methodName: "create_account", deposit: (4n * 10n ** 23n).toString() });
  });

  test("refuses without a ticket, with a ticket for another key, or an expired one", async () => {
    const f = fakes();
    const pk = passkey();
    const account = f.derive(pk.ownerKey);
    const request = requestJson(ownerRequest(account, "testnet", [], NOW));
    const proof = await pk.prove(request);
    const r = relayer(f);
    await expect(r.createAccount({ ownerKey: pk.ownerKey, request, proof, ticket: null })).rejects.toThrow(/activation ticket is required/);
    const other = passkey();
    await expect(r.createAccount({ ownerKey: pk.ownerKey, request, proof, ticket: ticketFor(other.ownerKey, account) })).rejects.toThrow(/activation ticket is required/);
    await expect(r.createAccount({ ownerKey: pk.ownerKey, request, proof, ticket: ticketFor(pk.ownerKey, account, NOW / 1000 - 1) })).rejects.toThrow(/expired/);
    const forged = { ...ticketFor(pk.ownerKey, account), signature: Buffer.alloc(64).toString("base64") };
    await expect(r.createAccount({ ownerKey: pk.ownerKey, request, proof, ticket: forged })).rejects.toThrow(/not valid/);
    expect(f.sent).toHaveLength(0);
  });

  test("refuses a proof by another passkey, an existing account, and past the hourly cap", async () => {
    const pk = passkey();
    const f = fakes();
    const account = f.derive(pk.ownerKey);
    const request = requestJson(ownerRequest(account, "testnet", [], NOW));
    const wrong = await passkey().prove(request);
    await expect(relayer(f).createAccount({ ownerKey: pk.ownerKey, request, proof: wrong, ticket: ticketFor(pk.ownerKey, account) })).rejects.toThrow(/passkey proof/);
    const taken = fakes({ existing: new Set([account]) });
    await expect(relayer(taken).createAccount({ ownerKey: pk.ownerKey, request, proof: await pk.prove(request), ticket: ticketFor(pk.ownerKey, account) })).rejects.toThrow(/already exists/);
    // Testnet without a ticket key: the hourly cap still holds.
    const open = fakes();
    const r = relayer(open, null);
    for (let i = 0; i < 3; i++) {
      const p = passkey();
      const acc = open.derive(p.ownerKey);
      const req = requestJson(ownerRequest(acc, "testnet", [], NOW));
      const run = r.createAccount({ ownerKey: p.ownerKey, request: req, proof: await p.prove(req), ticket: null });
      if (i < 2) await run;
      else await expect(run).rejects.toMatchObject({ status: 429 });
    }
  });
});

describe("owner requests and session gas", () => {
  test("relays only a Tredio account's own passkey requests", async () => {
    const pk = passkey();
    const base = fakes();
    const account = base.derive(pk.ownerKey);
    const f = fakes({ owners: new Map([[account, pk.ownerKey]]) });
    const request = requestJson(ownerRequest(account, "testnet", [{ freeze: {} } as never], NOW));
    const done = await relayer(f).ownerExecute({ account, request, proof: await pk.prove(request) });
    expect(done.hash).toBe("tx1");
    // The receipts' logs come back with the answer, so the app reads what happened without another RPC call.
    expect(done.outcome.receipts_outcome[0]!.outcome.logs[0]).toContain("order_placed");
    await expect(relayer(fakes()).ownerExecute({ account, request, proof: await pk.prove(request) })).rejects.toThrow(/not a Tredio account/);
    await expect(relayer(f).ownerExecute({ account, request, proof: await passkey().prove(request) })).rejects.toBeInstanceOf(RelayError);
  });

  test("says plainly when its own wallet runs dry", async () => {
    const account = fakes().derive("p256:x");
    const f = fakes({ session: { expires_at: NOW / 1000 + 3600, gas_key: true }, gasKey: 10n ** 20n, owners: new Map([[account, "p256:x"]]) });
    (f.sender as unknown as { fundGasKey: () => Promise<never> }).fundGasKey = async () => {
      throw new TxError('Server error: {"InvalidTxError":{"NotEnoughBalanceForDeposit":{"signer_id":"relayer.testnet"}}}');
    };
    await expect(relayer(f).fundSession({ account, publicKey: "ed25519:x" })).rejects.toThrow(/low on NEAR and is being refilled/);
  });

  test("adds storage at Tredio's contracts for a Tredio account that runs low, and only there", async () => {
    const pk = passkey();
    const account = fakes().derive(pk.ownerKey);
    const low = fakes({ owners: new Map([[account, pk.ownerKey]]), storage: 2_800_000_000_000_000_000_000n });
    const r = relayer(low);
    const done = await r.fundContractStorage({ account, contract: D.contracts.perps });
    expect(done.hash).toBe("tx1");
    const call = low.sent.at(-1)!.detail as { receiverId: string; methodName: string; deposit: string; args: { account_id: string } };
    expect([call.receiverId, call.methodName, call.args.account_id, call.deposit]).toEqual([D.contracts.perps, "storage_deposit", account, "20000000000000000000000"]);
    const roomy = fakes({ owners: new Map([[account, pk.ownerKey]]), storage: 10n ** 22n });
    expect((await relayer(roomy).fundContractStorage({ account, contract: D.contracts.perps })).hash).toBeNull();
    await expect(r.fundContractStorage({ account, contract: "evil.testnet" })).rejects.toThrow(/Tredio's contracts only/);
    await expect(relayer(fakes({ storage: 0n })).fundContractStorage({ account, contract: D.contracts.perps })).rejects.toThrow(/not a Tredio account/);
  });

  test("makes room for a new session key on an account low on NEAR, at most a few times a day", async () => {
    const pk = passkey();
    const account = fakes().derive(pk.ownerKey);
    const add = (n: number) => requestJson(ownerRequest(account, "testnet", [{ add_session: { public_key: `ed25519:${"1".repeat(43)}`, n } } as never], NOW + n));
    const send = async (r: Relayer, n: number) => {
      const request = add(n);
      return r.ownerExecute({ account, request, proof: await pk.prove(request) });
    };
    // 2750 bytes of storage cost 0.0275 NEAR, so 0.02875 leaves 0.00125 free: the top-up brings it back to 0.2.
    const low = fakes({ owners: new Map([[account, pk.ownerKey]]), account: { amount: 28_750_000_000_000_000_000_000n, storage: 2750 } });
    const r = relayer(low);
    await send(r, 1);
    const transfer = low.sent.find((x) => x.kind === "tx")?.detail as Array<{ transfer: { to: string; amount: string } }>;
    expect(transfer[0]!.transfer).toEqual({ to: account, amount: "198750000000000000000000 yocto" });
    expect(low.sent.at(-1)!.kind).toBe("call");
    for (let i = 2; i <= 4; i++) await send(r, i);
    await expect(send(r, 5)).rejects.toThrow(/many sessions today/);

    // An account with room, or a request that adds no session, costs nothing extra.
    const roomy = fakes({ owners: new Map([[account, pk.ownerKey]]), account: { amount: 5n * 10n ** 23n, storage: 2750 } });
    await send(relayer(roomy), 1);
    expect(roomy.sent.filter((x) => x.kind === "tx")).toHaveLength(0);
  });

  test("tops a low session gas key up to the target, once a day", async () => {
    const pk = passkey();
    const account = fakes().derive(pk.ownerKey);
    const f = fakes({ owners: new Map([[account, pk.ownerKey]]), session: { expires_at: NOW / 1000 + 3600, gas_key: true }, gasKey: 10n ** 23n });
    const r = relayer(f);
    await r.fundSession({ account, publicKey: "ed25519:11111111111111111111111111111111" });
    expect(f.sent[0]).toEqual({ kind: "fund", detail: { account, pk: "ed25519:11111111111111111111111111111111", amount: 25n * 10n ** 22n } });
    await expect(r.fundSession({ account, publicKey: "ed25519:11111111111111111111111111111111" })).rejects.toMatchObject({ status: 429 });
    const full = fakes({ owners: new Map([[account, pk.ownerKey]]), session: { expires_at: NOW / 1000 + 3600, gas_key: true }, gasKey: 4n * 10n ** 23n });
    expect((await relayer(full).fundSession({ account, publicKey: "ed25519:11111111111111111111111111111111" })).hash).toBeNull();
    // Another session (a new device) gets its first funding; the account-wide cap then stops a third.
    await r.fundSession({ account, publicKey: "ed25519:22222222222222222222222222222222" });
    await expect(r.fundSession({ account, publicKey: "ed25519:33333333333333333333333333333333" })).rejects.toThrow(/account's sessions were topped up enough/);
    const expired = fakes({ owners: new Map([[account, pk.ownerKey]]), session: { expires_at: NOW / 1000 - 1, gas_key: true }, gasKey: 0n });
    await expect(relayer(expired).fundSession({ account, publicKey: "ed25519:11111111111111111111111111111111" })).rejects.toThrow(/not an active session/);
  });
});

test("a sliding window forgets old events", () => {
  let t = 0;
  const w = new Window(1000, () => t);
  w.add("a", 2);
  expect(w.count("a")).toBe(2);
  t = 1500;
  expect(w.count("a")).toBe(0);
});

describe("wallet meta-transactions", () => {
  const delegate = (receiverId: string, methodName: string, args: unknown) =>
    encodeSignedDelegateAction({
      signedDelegate: {
        delegateAction: {
          senderId: "alice.testnet",
          receiverId,
          actions: [{ functionCall: { methodName, args: new TextEncoder().encode(JSON.stringify(args)), gas: 100n * 10n ** 12n, deposit: 1n } }],
          nonce: 1n,
          maxBlockHeight: 1n,
          publicKey: { ed25519Key: { data: Array.from({ length: 32 }, () => 0) } },
        },
        signature: { ed25519Signature: { data: Array.from({ length: 64 }, () => 0) } },
      },
    } as never);

  test("token transfers are paid only when they go to a Tredio contract", async () => {
    const f = fakes({});
    const r = relayer(f);
    const to = (receiver_id: string) => ({ receiver_id, amount: "1000000", msg: "" });
    await expect(r.relayMeta(delegate(D.contracts.usdc, "ft_transfer_call", to("bob.testnet")))).rejects.toThrow(/transfers to Tredio contracts/);
    await expect(r.relayMeta(delegate(D.contracts.usdc, "ft_transfer_call", { amount: "1" }))).rejects.toThrow(/transfers to Tredio contracts/);
    await expect(r.relayMeta(delegate(D.contracts.outcomes, "mt_transfer_call", to("bob.testnet")))).rejects.toThrow(/transfers to Tredio contracts/);
    await expect(r.relayMeta(delegate("evil.testnet", "ft_transfer_call", to(D.contracts.book)))).rejects.toThrow(/only for calls to Tredio contracts/);
    expect(await r.relayMeta(delegate(D.contracts.usdc, "ft_transfer_call", to(D.contracts.outcomes)))).toMatchObject({ sender: "alice.testnet" });
    expect(await r.relayMeta(delegate(D.contracts.outcomes, "mt_transfer_call", to(D.contracts.book)))).toMatchObject({ sender: "alice.testnet" });
  });

  test("#mainnet: Circle's USDC has no faucet to relay", () => {
    expect(metaAllowlist(D).get(D.contracts.usdc)?.has("faucet")).toBe(true);
    const mainnet = { ...D, root: "tredio.near", contracts: { ...D.contracts, usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" } };
    expect(metaAllowlist(mainnet).get(mainnet.contracts.usdc)).toEqual(new Set(["ft_transfer_call", "storage_deposit"]));
  });
});
