import { describe, expect, test } from "bun:test";
import { generateSealKeyPair, seal } from "@tredio/autopilot";
import { custodyKeyOf, nearKeyOf } from "@tredio/custody";
import { agentApi, autopilotAgentPolicy, passkeySpki } from "@tredio/custody/agent-api";
import { p256 } from "@noble/curves/nist.js";
import { issueUserToken } from "../src/api/user-auth";
import { type AutopilotRouteDeps, autopilotRoutes } from "../src/autopilot/routes";
import type { GrantWallet, WalletDeps } from "../src/autopilot/wallets";
import { quietLog } from "./helpers";

const SECRET = "policy-wallet-test-session-secret-0123456789";
const USER = "0upolicyowner";
const NOW = 1_793_900_000_000;
const WALLET = "4348f62db35f111328e9affa98ffaf1c20004b19a287305056997dff4d61bbf2";
const token = issueUserToken(SECRET, USER, "ed25519:11111111111111111111111111111111", Math.floor(NOW / 1000) + 3600);
const PASSKEY = p256.utils.randomSecretKey();
const OWNER_KEY = `p256:${(await import("@tredio/custody")).base58Encode(p256.getPublicKey(PASSKEY, true))}`;

type Policy = { owner: string; frozen: boolean; updated_at: number } | null;

/** The grant routes over an in-memory store and chain: a policy wallet's policy on `outlayer.<network>`, the account's session. */
async function setup(o: { network?: "testnet" | "mainnet"; agentFetch?: typeof fetch } = {}) {
  const pair = await generateSealKeyPair();
  const state = {
    policy: { owner: USER, frozen: false, updated_at: 0 } as Policy,
    session: { label: "autopilot", expires_at: NOW / 1000 + 86_400, scope: { outcomes: false, perps: false, hyperliquid: true }, daily_limit: "100000000", gas_key: false },
    key: null as { kind: "function_call"; receiverId: string; methodNames: string[] } | null,
    grant: null as { sessionKey: string; status: string; validUntil: number; dailyLimit: bigint; nextSessionKey: string | null } | null,
    wallets: new Map<string, GrantWallet>(),
    audits: [] as { event: string; detail: unknown }[],
  };
  const views: string[] = [];
  const wallets: WalletDeps = {
    network: o.network ?? "testnet",
    view: async <T>(contract: string, method: string, args: object): Promise<T> => {
      views.push(`${contract}.${method}`);
      if (method === "get_wallet_policy") {
        expect(contract).toBe(o.network === "mainnet" ? "outlayer.near" : "outlayer.testnet");
        expect(args).toEqual({ wallet_pubkey: custodyKeyOf(WALLET) });
        return state.policy as T;
      }
      if (method === "owner_key") return OWNER_KEY as T;
      throw new Error(`unexpected view ${method}`);
    },
    balance: async () => 2n * 10n ** 23n,
    agentApi: o.agentFetch ? agentApi("partner", { baseUrl: "https://agents.test", fetch: o.agentFetch }) : null,
  };
  const store = {
    requestGrant: async (_owner: string, sessionKey: string) => {
      state.grant = { sessionKey, status: "pending", validUntil: 0, dailyLimit: 0n, nextSessionKey: null };
      return { replaces: null };
    },
    setGrantWallet: async (_owner: string, sessionKey: string, w: GrantWallet) => void state.wallets.set(sessionKey, w),
    grantWallet: async (sessionKey: string) => state.wallets.get(sessionKey) ?? null,
    grant: async () => (state.grant ? { owner: USER, ...state.grant, wallet: state.wallets.get(state.grant.sessionKey) ?? null } : null),
    activateGrant: async (_o: string, _k: string, validUntil: number, dailyLimit: bigint) => {
      state.grant = { ...state.grant!, status: "active", validUntil, dailyLimit };
      return true;
    },
    addAudit: async (_o: string, event: string, detail: unknown) => void state.audits.push({ event, detail }),
  };
  const deps = {
    isRevoked: async () => false,
    store,
    sessions: async () => state.session,
    accessKey: async () => state.key,
    keys: { stillActive: async () => true },
    sessionSecret: SECRET,
    sealPublicKey: pair.publicKey,
    wallets,
    log: quietLog,
    now: () => NOW,
  } as unknown as AutopilotRouteDeps;
  const app = autopilotRoutes(deps);
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const get = (path: string) => app.request(path, { headers: { authorization: `Bearer ${token}` } });
  const box = (secret: string, sessionKey: string) => seal(secret, pair.publicKey, { owner: USER, sessionKey });
  return { state, views, post, get, box };
}

describe("grants backed by an OutLayer policy wallet", () => {
  const sessionKey = nearKeyOf(WALLET);
  const credential = `wk_${"ab".repeat(32)}`;

  test("the session asked for is a plain key for the wallet's own key, and nothing else", async () => {
    const s = await setup();
    const wrongKey = await s.post("/autopilot/grant", { dailyLimit: "100000000", validDays: 7, sessionKey: nearKeyOf("ab".repeat(32)), sealedKey: await s.box(credential, sessionKey), wallet: { kind: "outlayer", account: WALLET } });
    expect(wrongKey.status).toBe(400);
    expect(await wrongKey.json()).toEqual({ error: "a policy wallet's session is for the wallet's own key" });

    const agentOnTestnet = await s.post("/autopilot/grant", { sessionKey, sealedKey: await s.box(credential, sessionKey), wallet: { kind: "agent-api", account: WALLET, agentId: "agt_1" } });
    expect(agentOnTestnet.status).toBe(400);

    const res = await s.post("/autopilot/grant", { dailyLimit: "100000000", validDays: 7, sessionKey, sealedKey: await s.box(credential, sessionKey), wallet: { kind: "outlayer", account: WALLET } });
    expect(res.status).toBe(200);
    const { session } = (await res.json()) as { session: Record<string, unknown> };
    expect(session).toMatchObject({ public_key: sessionKey, label: "autopilot", scope: { outcomes: false, perps: false, hyperliquid: true }, gas_key: false });
    expect(s.state.wallets.get(sessionKey)).toEqual({ kind: "outlayer", account: WALLET, agentId: null });
  });

  test("confirming needs the account to control the wallet's policy on chain, and the session to be a plain key", async () => {
    const s = await setup();
    await s.post("/autopilot/grant", { sessionKey, sealedKey: await s.box(credential, sessionKey), wallet: { kind: "outlayer", account: WALLET } });

    s.state.policy = null;
    expect(await (await s.post("/autopilot/grant/confirm", {})).json()).toEqual({ error: "the wallet's policy is not stored on chain yet" });
    s.state.policy = { owner: "mallory.testnet", frozen: false, updated_at: 0 };
    const stolen = await s.post("/autopilot/grant/confirm", {});
    expect([stolen.status, await stolen.json()]).toEqual([409, { error: "the wallet's policy is controlled by mallory.testnet, not your account" }]);
    s.state.policy = { owner: USER, frozen: false, updated_at: 0 };
    s.state.session = { ...s.state.session, gas_key: true };
    expect((await s.post("/autopilot/grant/confirm", {})).status).toBe(409);
    s.state.session = { ...s.state.session, gas_key: false };
    // The key OutLayer holds may sit on the account as a plain session_call key, or not at all.
    s.state.key = { kind: "function_call", receiverId: USER, methodNames: ["session_call"] };
    const ok = await s.post("/autopilot/grant/confirm", {});
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { grant: { status: string; wallet: GrantWallet } }).grant).toMatchObject({ status: "active", wallet: { kind: "outlayer", account: WALLET } });
    expect(s.state.audits.map((a) => a.event)).toEqual(["grant_requested", "grant_active"]);

    // The app reads the wallet's freeze, controller and gas with the grant.
    s.state.policy = { owner: USER, frozen: true, updated_at: 0 };
    const g = (await (await s.get("/autopilot/grant")).json()) as { grant: { wallet: Record<string, unknown> } };
    expect(g.grant.wallet).toEqual({ kind: "outlayer", account: WALLET, agentId: null, frozen: true, controller: USER, balance: (2n * 10n ** 23n).toString() });
  });

  test("the Agent API's owner actions are mainnet's, with a partner key", async () => {
    const s = await setup();
    const res = await s.post("/autopilot/agent/intent", { type: "agent_freeze", agentId: "agt_1" });
    expect(res.status).toBe(503);
  });
});

describe("#mainnet: an Agent API agent owned by the account's passkey", () => {
  const AGENT = "agt_autopilot_1";
  const webauthn = { challenge: "Y2hhbGxlbmdl", rpId: "tredio.bid", allowCredentials: [{ id: "cred_1_abcdefgh", type: "public-key" }], userVerification: "required", timeout: 60000 };
  const agentView = (spki: string) => ({
    id: AGENT,
    name: "Tredio Autopilot",
    external_user_id: USER,
    status: "ACTIVE",
    archived: false,
    deleted: false,
    owner: { type: "passkey", credential_id: "cred_1_abcdefgh", public_key: spki, rp_id: "tredio.bid", origin: "https://app.tredio.bid" },
    owner_account: null,
    wallet: { wallet_id: "w", near_account_id: WALLET, evm_account_id: null, solana_account_id: null },
    created_at: "",
    cooldowns: { policy_change_available_at: null, unfreeze_available_at: null },
  });
  const status = (type: string, st: string) => ({ correlation_id: `intent_${"a".repeat(43)}`, agent_id: AGENT, status: st, failure_code: null, created_at: "", updated_at: "", dispatch_committed_at: null, grant: null, type, details: { revision: 1, policy_hash: "p", transaction_hash: "T", agent_id: AGENT } });

  function recorded(owner: string) {
    const bodies: { path: string; body: unknown }[] = [];
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      bodies.push({ path: url.pathname, body });
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (url.pathname === "/v1/generate-intent") return json({ correlation_id: `intent_${"a".repeat(43)}`, type: body.type, agent_id: AGENT, status: "PENDING_SIGNATURE", expires_at: "", signer: {}, intent: { standard: "webauthn", payload: webauthn }, preview: { summary: `${body.type} for ${USER}` } });
      if (url.pathname === "/v1/submit-intent") return json(status(body.type, "QUEUED"));
      if (url.pathname === "/v1/status") return json(status("agent_create", "SUCCESS"));
      if (url.pathname === `/v1/agents/${AGENT}`) return json(agentView(owner));
      if (url.pathname === `/v1/agents/${AGENT}/policy`) return json({ wallet_id: "w", revision: 1, policy_hash: "p", status: "APPLIED", applied_at: "", transaction_hash: "T", provider_policy_synced: true, cooldowns: { policy_change_available_at: null, unfreeze_available_at: null }, policy: autopilotAgentPolicy({ account: USER }), usage: {} });
      return new Response(JSON.stringify({ errors: [{ status: "404", code: "not_found", layer: "api", title: "no route", meta: { retryable: false } }], meta: {} }), { status: 404 });
    }) as typeof fetch;
    return { f, bodies };
  }

  test("create: this server reads the owner key on chain, the passkey signs, this server submits", async () => {
    const api = recorded(passkeySpki(OWNER_KEY));
    const s = await setup({ network: "mainnet", agentFetch: api.f });
    const res = await s.post("/autopilot/agent/intent", { type: "agent_create", credentialId: "cred_1_abcdefgh", rpId: "tredio.bid", origin: "https://app.tredio.bid" });
    expect(res.status).toBe(200);
    const intent = (await res.json()) as { correlationId: string; webauthn: unknown; agentId: string };
    expect(intent).toMatchObject({ agentId: AGENT, webauthn });
    expect(api.bodies[0]!.body).toMatchObject({ type: "agent_create", external_user_id: USER, owner: { type: "passkey", public_key: passkeySpki(OWNER_KEY) }, policy: { native: { near: { call: [USER] } }, actions: [] } });
    expect(s.views).toContain(`${USER}.owner_key`);

    const credential = { id: "cred_1_abcdefgh", rawId: "cred_1_abcdefgh", type: "public-key", response: { clientDataJSON: "cd", authenticatorData: "ad", signature: "sg" }, clientExtensionResults: {} };
    const done = await s.post("/autopilot/agent/submit", { correlationId: intent.correlationId, credential });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ status: "SUCCESS", agentId: AGENT, account: WALLET });
    expect(api.bodies.find((b) => b.path === "/v1/submit-intent")!.body).toMatchObject({ signed_data: { standard: "webauthn", payload: webauthn, credential } });
    // An intent is submitted once, by the account that prepared it.
    expect((await s.post("/autopilot/agent/submit", { correlationId: intent.correlationId, credential })).status).toBe(404);
  });

  test("grants, freezes and unfreezes only the account's own agent", async () => {
    const mine = await setup({ network: "mainnet", agentFetch: recorded(passkeySpki(OWNER_KEY)).f });
    expect((await mine.post("/autopilot/agent/intent", { type: "grant_issue", agentId: AGENT, commitment: "c".repeat(64), validDays: 7 })).status).toBe(200);
    expect((await mine.post("/autopilot/agent/intent", { type: "agent_freeze", agentId: AGENT })).status).toBe(200);
    const theirs = await setup({ network: "mainnet", agentFetch: recorded(passkeySpki(`p256:${(await import("@tredio/custody")).base58Encode(p256.getPublicKey(p256.utils.randomSecretKey(), true))}`)).f });
    const refused = await theirs.post("/autopilot/agent/intent", { type: "agent_freeze", agentId: AGENT });
    expect([refused.status, await refused.json()]).toEqual([409, { error: "the agent is not owned by your account's passkey" }]);
  });

  test("a grant on an agent confirms against the API: the passkey owns it, its NEAR account is the wallet, its policy is Autopilot's", async () => {
    const s = await setup({ network: "mainnet", agentFetch: recorded(passkeySpki(OWNER_KEY)).f });
    const sessionKey = nearKeyOf(WALLET);
    await s.post("/autopilot/grant", { sessionKey, sealedKey: await s.box(`ngt_${"x".repeat(43)}`, sessionKey), wallet: { kind: "agent-api", account: WALLET, agentId: AGENT } });
    const ok = await s.post("/autopilot/grant/confirm", {});
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { grant: { wallet: GrantWallet } }).grant.wallet).toEqual({ kind: "agent-api", account: WALLET, agentId: AGENT });
  });
});
