import { describe, expect, test } from "bun:test";
import { grantCommitment as sdkCommitment } from "@near-intents-agent-api/sdk";
import { p256 } from "@noble/curves/nist.js";
import { AgentApiSigner, agentApi, agentPolicyProblem, autopilotAgentPolicy, grantCommitment, newGrantCredential, ownerIntents, passkeyOwner, passkeySpki, submitOwnerIntent } from "../src/agent-api";
import { base58Encode, nearKeyOf } from "../src";

// Offline: the real SDK client against recorded answers of the Agent API (mainnet shapes, 0.8.0).
const ACCOUNT = "0uautopilotowner";
const AGENT = "agt_01HZXAUTOPILOT";
const AGENT_NEAR = "c0ffee".padEnd(64, "0");
const SECRET = p256.utils.randomSecretKey();
const OWNER_KEY = Buffer.from(p256.getPublicKey(SECRET, true)).toString("hex");
const PASSKEY = { ownerKeyHex: OWNER_KEY, credentialId: "cred-1_x", rpId: "tredio.bid", origin: "https://app.tredio.bid" };

const status = (over: Record<string, unknown>) => ({
  correlation_id: "exec_1",
  agent_id: AGENT,
  status: "PROCESSING",
  failure_code: null,
  created_at: "2026-11-09T00:00:00Z",
  updated_at: "2026-11-09T00:00:00Z",
  dispatch_committed_at: null,
  grant: { id: "grt_1", label: "Tredio Autopilot executor" },
  type: "native",
  details: { method: "near_call", chain: "near", account_id: AGENT_NEAR, target: ACCOUNT, amount: "0", method_name: "session_call", primary_type: null, domain: null, message_json: null, request_sha256: "0".repeat(64), signature: null, tx_hash: null, provider_request_id: null, provider_status: null, failure_reason: null },
  ...over,
});

type Answer = { status: number; body: unknown };
function recorded(route: (method: string, path: string, body: unknown, headers: Headers) => Answer | undefined) {
  const seen: { method: string; path: string; body: unknown; headers: Headers }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ method: init?.method ?? "GET", path: url.pathname + url.search, body, headers });
    const a = route(init?.method ?? "GET", url.pathname + url.search, body, headers) ?? { status: 404, body: { errors: [{ status: "404", code: "not_found", layer: "api", title: "No route", meta: { retryable: false } }], meta: { request_id: "req_0" } } };
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, seen };
}

describe("the account's passkey as the agent's owner", () => {
  test("SPKI of the uncompressed key, as the API's pattern wants", () => {
    const o = passkeyOwner(PASSKEY);
    expect(o.type).toBe("passkey");
    if (o.type !== "passkey") throw new Error("unreachable");
    expect(o.public_key).toMatch(/^MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE[A-Za-z0-9_-]{85}[AQgw]$/);
    const der = Buffer.from(o.public_key, "base64url");
    expect(Buffer.from(der.subarray(26)).toString("hex")).toBe(Buffer.from(p256.getPublicKey(SECRET, false)).toString("hex"));
    expect([o.credential_id, o.rp_id, o.origin]).toEqual(["cred-1_x", "tredio.bid", "https://app.tredio.bid"]);
    // The account's `owner_key` view spells the same key `p256:<base58>`.
    expect(passkeySpki(`p256:${base58Encode(p256.getPublicKey(SECRET, true))}`)).toBe(o.public_key);
  });
});

describe("Autopilot's agent policy", () => {
  test("only native calls to the account; everything else shut", () => {
    const p = autopilotAgentPolicy({ account: ACCOUNT });
    expect(p.actions).toEqual([]);
    expect(p.assets).toEqual([]);
    expect(p.native?.near).toEqual({ sign_message: [], transfer: false, call: [ACCOUNT] });
    expect(p.destinations).toEqual({ mode: "only", list: [] });
    expect(agentPolicyProblem(p, ACCOUNT)).toBeNull();
    expect(agentPolicyProblem(null, ACCOUNT)).toContain("no policy");
    expect(agentPolicyProblem({ ...p, actions: ["withdraw"] }, ACCOUNT)).toContain("withdrawals");
    expect(agentPolicyProblem({ ...p, native: { ...p.native!, near: { sign_message: [], transfer: false, call: [ACCOUNT, "usdc.near"] } } }, ACCOUNT)).toContain("other than the account");
    expect(agentPolicyProblem({ ...p, native: { ...p.native!, evm: { sign_typed_data: [], sign_message: true, sign_transaction: false } } }, ACCOUNT)).toContain("EVM");
  });

  test("the grant token stays with the executor; the owner signs its hash, as the SDK computes it", () => {
    const g = newGrantCredential();
    expect(g.token).toMatch(/^ngt_[A-Za-z0-9_-]{43}$/);
    expect(g.commitment).toBe(sdkCommitment(g.token));
    expect(grantCommitment(g.token)).toBe(g.commitment);
  });
});

describe("owner intents, signed by the passkey", () => {
  test("create: the backend asks, the passkey signs the WebAuthn payload, the backend submits and waits", async () => {
    const webauthn = { standard: "webauthn", payload: { challenge: "Y2hhbGxlbmdl", rpId: "tredio.bid", allowCredentials: [{ id: "cred-1_x", type: "public-key" }], userVerification: "required", timeout: 60000 } };
    const { f, seen } = recorded((method, path) => {
      if (method === "POST" && path === "/v1/generate-intent") return { status: 200, body: { correlation_id: `intent_${"a".repeat(43)}`, type: "agent_create", agent_id: AGENT, status: "PENDING_SIGNATURE", expires_at: "2026-11-09T01:00:00Z", signer: passkeyOwner(PASSKEY), intent: webauthn, preview: { summary: "Create Tredio Autopilot" } } };
      if (method === "POST" && path === "/v1/submit-intent") return { status: 200, body: { ...status({ type: "agent_create", status: "QUEUED", details: { revision: null, policy_hash: null, transaction_hash: null, agent_id: AGENT } }) } };
      if (method === "GET" && path.startsWith("/v1/status")) return { status: 200, body: { ...status({ type: "agent_create", status: "SUCCESS", details: { revision: 1, policy_hash: "p", transaction_hash: "T", agent_id: AGENT } }) } };
      return undefined;
    });
    const api = agentApi("partner-key", { baseUrl: "https://api.agentsonintents.test", fetch: f });
    const generated = await ownerIntents.create(api, ACCOUNT, passkeyOwner(PASSKEY), autopilotAgentPolicy({ account: ACCOUNT }));
    expect(generated.agent_id).toBe(AGENT);
    const gen = seen[0]!;
    expect(gen.headers.get("x-api-key")).toBe("partner-key");
    expect(gen.body).toMatchObject({ type: "agent_create", name: "Tredio Autopilot", external_user_id: ACCOUNT, owner: { type: "passkey", rp_id: "tredio.bid" }, policy: { native: { near: { call: [ACCOUNT] } } } });
    const credential = { id: "cred-1_x", rawId: "cred-1_x", type: "public-key" as const, response: { clientDataJSON: "cd", authenticatorData: "ad", signature: "sg" }, clientExtensionResults: {} };
    const done = await submitOwnerIntent(api, generated, credential);
    expect(done.status).toBe("SUCCESS");
    expect(seen.find((s) => s.path === "/v1/submit-intent")!.body).toEqual({ type: "agent_create", correlation_id: generated.correlation_id, signed_data: { standard: "webauthn", payload: webauthn.payload, credential } });
  });

  test("a NEAR-key intent is not the passkey's to sign", async () => {
    const api = agentApi("k", { baseUrl: "https://x.test", fetch: recorded(() => undefined).f });
    const nep413 = { type: "agent_freeze" as const, correlation_id: "intent_x", intent: { standard: "nep413" as const, payload: { message: "m", recipient: "r", nonce: "n" } } };
    await expect(submitOwnerIntent(api, nep413, { id: "a", rawId: "a", type: "public-key", response: { clientDataJSON: "", authenticatorData: "", signature: "" }, clientExtensionResults: {} })).rejects.toThrow("WebAuthn");
  });
});

describe("the Agent API signer", () => {
  const owner = { account: ACCOUNT, spki: async () => passkeySpki(OWNER_KEY) };

  test("session calls go out as native NEAR calls under the executor's grant, and the value comes from the chain", async () => {
    let polls = 0;
    const { f, seen } = recorded((method, path) => {
      if (method === "POST" && path === `/v1/agents/${AGENT}/native/near/call`) return { status: 202, body: status({}) };
      if (method === "GET" && path.startsWith("/v1/status")) {
        polls++;
        return { status: 200, body: status(polls < 2 ? {} : { status: "SUCCESS", details: { ...status({}).details, tx_hash: "NEARTX" } }) };
      }
      return undefined;
    });
    const api = agentApi("partner-key", { baseUrl: "https://api.agentsonintents.test", fetch: f });
    const signer = new AgentApiSigner({ api, agentId: AGENT, grantToken: `ngt_${"b".repeat(43)}`, accountId: AGENT_NEAR, owner, readValue: async (hash, sender) => ({ hash, sender }) });
    expect(signer.sessionKey).toBe(nearKeyOf(AGENT_NEAR));
    const out = await signer.sessionCall(ACCOUNT, { hl_order: { nonce: 7 } }, 300);
    expect(out).toEqual({ hash: "NEARTX", value: { hash: "NEARTX", sender: AGENT_NEAR } });
    const call = seen[0]!;
    expect(call.headers.get("x-grant-token")).toBe(`ngt_${"b".repeat(43)}`);
    expect(call.headers.get("idempotency-key")).toBeTruthy();
    expect(call.body).toEqual({ receiver_id: ACCOUNT, method_name: "session_call", args: { action: { hl_order: { nonce: 7 } } }, gas: "300000000000000", deposit: "0" });
  });

  test("a refused or failed call is an error with the API's reason", async () => {
    const { f } = recorded((method, path) => {
      if (method === "POST" && path.endsWith("/native/near/call")) return { status: 202, body: status({ status: "FAILED", failure_code: "native_transaction_failed", details: { ...status({}).details, failure_reason: "session keys only" } }) };
      return undefined;
    });
    const api = agentApi("k", { baseUrl: "https://x.test", fetch: f });
    const signer = new AgentApiSigner({ api, agentId: AGENT, grantToken: `ngt_${"c".repeat(43)}`, accountId: AGENT_NEAR, owner, readValue: async () => null });
    await expect(signer.sessionCall(ACCOUNT, "faucet", 150)).rejects.toThrow("session keys only");

    const frozen = recorded((method, path) => (method === "POST" && path.endsWith("/native/near/call") ? { status: 403, body: { errors: [{ status: "403", code: "agent_frozen", layer: "policy", title: "The agent is frozen", meta: { retryable: false } }], meta: { request_id: "req_1" } } } : undefined));
    const api2 = agentApi("k", { baseUrl: "https://x.test", fetch: frozen.f });
    const s2 = new AgentApiSigner({ api: api2, agentId: AGENT, grantToken: `ngt_${"c".repeat(43)}`, accountId: AGENT_NEAR, owner, readValue: async () => null });
    await expect(s2.sessionCall(ACCOUNT, "faucet", 150)).rejects.toThrow("frozen");
  });

  test("state: the freeze from the applied policy, and control only while the owner is the account's passkey", async () => {
    let ownerKey = passkeySpki(OWNER_KEY);
    let frozen = false;
    const { f } = recorded((method, path) => {
      if (path === `/v1/agents/${AGENT}`) return { status: 200, body: { id: AGENT, name: "Tredio Autopilot", external_user_id: ACCOUNT, status: "ACTIVE", archived: false, deleted: false, owner: { ...passkeyOwner(PASSKEY), public_key: ownerKey }, owner_account: null, wallet: { wallet_id: "w", near_account_id: AGENT_NEAR, evm_account_id: null, solana_account_id: null }, created_at: "", cooldowns: { policy_change_available_at: null, unfreeze_available_at: null } } };
      if (path === `/v1/agents/${AGENT}/policy`) return { status: 200, body: { wallet_id: "w", revision: 1, policy_hash: "p", status: "APPLIED", applied_at: "", transaction_hash: "T", provider_policy_synced: true, cooldowns: { policy_change_available_at: null, unfreeze_available_at: null }, policy: { ...autopilotAgentPolicy({ account: ACCOUNT }), frozen }, usage: {} } };
      return undefined;
    });
    const api = agentApi("k", { baseUrl: "https://x.test", fetch: f });
    const signer = new AgentApiSigner({ api, agentId: AGENT, grantToken: `ngt_${"d".repeat(43)}`, accountId: AGENT_NEAR, owner, readValue: async () => null });
    expect(await signer.state()).toEqual({ frozen: false, controller: ACCOUNT });
    expect(await signer.policyProblem(ACCOUNT)).toBeNull();
    frozen = true;
    ownerKey = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEsomebodyelse";
    expect(await signer.state()).toEqual({ frozen: true, controller: null });
  });
});
