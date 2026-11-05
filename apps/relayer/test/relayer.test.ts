import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58Encode, type Sender, type Viewer } from "@tredio/chain";
import { activationTicketMessage, deployment, ownerRequest, requestChallenge, requestJson } from "@tredio/contracts";
import { RelayError, Relayer, Window } from "../src/relayer";

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
function fakes(opts: { existing?: Set<string>; owners?: Map<string, string>; session?: { expires_at: number; gas_key: boolean } | null; gasKey?: bigint } = {}) {
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
      throw new Error(`unexpected view ${method}`);
    },
    rpc: async (_m: string, p: { account_id: string }) => {
      if (opts.existing?.has(p.account_id)) return {};
      throw new Error(`UNKNOWN_ACCOUNT ${p.account_id}`);
    },
    gasKey: async () => (opts.gasKey === undefined ? null : { balance: opts.gasKey, nonces: 4 }),
  } as unknown as Viewer;
  const sender = {
    accountId: "relayer.testnet",
    send: async (call: unknown) => (sent.push({ kind: "call", detail: call }), { hash: "tx1", value: null }),
    fundGasKey: async (account: string, pk: string, amount: bigint) => (sent.push({ kind: "fund", detail: { account, pk, amount } }), { transaction: { hash: "tx2" } }),
    sendTx: async () => (sent.push({ kind: "tx", detail: null }), { transaction: { hash: "tx3" } }),
  } as unknown as Sender;
  return { viewer, sender, sent, derive };
}

const limits = { accountsPerHour: 2, accountsPerDay: 10, ownerCallsPerAccountPerHour: 2, topupsPerAccountPerDay: 1, metaPerAccountPerHour: 5, nearPerHour: 10n ** 25n };
const relayer = (f: ReturnType<typeof fakes>, ticket: string | null = ticketSigner) =>
  new Relayer({ sender: f.sender, viewer: f.viewer, deployment: D, ticketSigner: ticket, createDeposit: 4n * 10n ** 23n, sessionGasTarget: 35n * 10n ** 22n, sessionGasMin: 31n * 10n ** 22n, limits, now: () => NOW });

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
    expect((await relayer(f).ownerExecute({ account, request, proof: await pk.prove(request) })).hash).toBe("tx1");
    await expect(relayer(fakes()).ownerExecute({ account, request, proof: await pk.prove(request) })).rejects.toThrow(/not a Tredio account/);
    await expect(relayer(f).ownerExecute({ account, request, proof: await passkey().prove(request) })).rejects.toBeInstanceOf(RelayError);
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
