import { describe, expect, test } from "bun:test";
import {
  AUTOPILOT_CAPABILITIES,
  autopilotRules,
  base58Decode,
  base58Encode,
  CustodyCallFailed,
  CustodyWallet,
  custodyKeyOf,
  freezeCall,
  implicitAccountOf,
  nearKeyOf,
  OutLayerSigner,
  onChainPolicy,
  POLICY_DEPOSIT_MARGIN,
  PolicyRefusal,
  policyCost,
  unfreezeCall,
  valueFromResult,
  walletPolicyProblem,
  walletSetupActions,
  type WalletPolicyView,
} from "../src";

const WALLET = "ab76c1c8fa9b1fa714dca983aff274cceef8e74da4958f8f424ac6b2f969b02e";
const ACCOUNT = "0uexampleaccount";
const API = "https://custody.test";

type Route = (req: { method: string; path: string; body: unknown; headers: Headers }) => { status: number; body: unknown } | undefined;

/** A fetch that answers from `route` and records every request. */
function fakeFetch(route: Route) {
  const seen: { method: string; path: string; body: unknown; headers: Headers }[] = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const req = { method: init?.method ?? "GET", path: url.pathname + url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init?.headers) };
    seen.push(req);
    const r = route(req);
    if (!r) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, seen };
}

describe("keys", () => {
  test("one key, three spellings", () => {
    const near = nearKeyOf(WALLET);
    expect(near.startsWith("ed25519:")).toBe(true);
    expect(base58Decode(near.slice(8)).length).toBe(32);
    expect(custodyKeyOf(WALLET)).toBe(`ed25519:${WALLET}`);
    expect(implicitAccountOf(near)).toBe(WALLET);
    expect(implicitAccountOf(custodyKeyOf(WALLET))).toBe(WALLET);
  });

  test("leading zero bytes survive base58", () => {
    expect(implicitAccountOf("ed25519:11111111111111111111111111111111")).toBe("0".repeat(64));
    const b = new Uint8Array([0, 0, 1, 2, 255]);
    expect(base58Decode(base58Encode(b))).toEqual(b);
  });

  test("only implicit accounts have a key", () => {
    expect(() => nearKeyOf("alice.testnet")).toThrow("not an ed25519 implicit account");
  });
});

describe("Autopilot's policy", () => {
  const rules = autopilotRules({ account: ACCOUNT });
  const stored = (over: Partial<WalletPolicyView> = {}): WalletPolicyView => ({ wallet_id: "w", controller: ACCOUNT, frozen: false, policy: "stored", rules, capabilities: AUTOPILOT_CAPABILITIES, ...over });

  test("calls to the account only, with no NEAR attached, rate limited", () => {
    expect(rules.transaction_types).toEqual(["call"]);
    expect(rules.addresses).toEqual({ mode: "whitelist", list: [ACCOUNT] });
    expect(rules.limits).toEqual({ per_transaction: { native: "0" }, daily: { native: "0" } });
    expect(rules.rate_limit?.max_per_hour).toBe(120);
    expect(rules.time_restrictions).toBeUndefined();
    expect(autopilotRules({ account: ACCOUNT, callsPerHour: 10, hours: [8, 20] }).time_restrictions).toEqual({ timezone: "UTC", allowed_hours: [8, 20] });
    expect(AUTOPILOT_CAPABILITIES.sign_message?.allowed).toBe(false);
  });

  test("a wallet is Autopilot's only under exactly that policy, controlled by the account", () => {
    expect(walletPolicyProblem(stored(), ACCOUNT)).toBeNull();
    expect(walletPolicyProblem(stored({ policy: "none" }), ACCOUNT)).toContain("no policy");
    expect(walletPolicyProblem(stored({ policy: undefined }), ACCOUNT)).toContain("could not read");
    // The view's controller is OutLayer's (the wallet's own key for an anonymous wallet); the policy's owner is read on chain.
    expect(walletPolicyProblem(stored({ controller: `ed25519:${WALLET}` }), ACCOUNT)).toBeNull();
    expect(walletPolicyProblem(stored({ rules: { ...rules, addresses: { mode: "whitelist", list: [ACCOUNT, "usdc.tredio.testnet"] } } }), ACCOUNT)).toContain("other than the account");
    expect(walletPolicyProblem(stored({ rules: { ...rules, transaction_types: ["call", "transfer"] } }), ACCOUNT)).toContain("more than contract calls");
    expect(walletPolicyProblem(stored({ rules: { ...rules, limits: { per_transaction: { native: "1" } } } }), ACCOUNT)).toContain("attach NEAR");
    expect(walletPolicyProblem(stored({ capabilities: {} }), ACCOUNT)).toContain("sign messages");
    expect(walletPolicyProblem(stored({ capabilities: { sign_message: { allowed: false }, raw_sign: { allowed: true } } }), ACCOUNT)).toContain("beyond contract calls");
  });

  test("one owner request stores the policy, funds the wallet and adds the session for the wallet's key", () => {
    const signed = { signatureHex: "aa", publicKeyHex: WALLET, version: 1, locked: false, validUntil: 1_800_000_000, policyHash: "ff" };
    const actions = walletSetupActions({ contract: "outlayer.testnet", walletAccount: WALLET, encrypted: "ENC", signed, policyCost: 9_460_000_000_000_000_000_000n, gasFunding: 10n ** 23n, expiresAt: 1_790_000_000, dailyLimit: 500_000_000n });
    expect(actions).toHaveLength(3);
    const store = actions[0] as { call: { receiver_id: string; method_name: string; args: string; deposit: string; gas: string } };
    expect(store.call.receiver_id).toBe("outlayer.testnet");
    expect(store.call.method_name).toBe("store_wallet_policy");
    expect(BigInt(store.call.deposit)).toBe(9_460_000_000_000_000_000_000n + POLICY_DEPOSIT_MARGIN);
    expect(JSON.parse(atob(store.call.args))).toEqual({ wallet_pubkey: `ed25519:${WALLET}`, encrypted_data: "ENC", wallet_signature: "aa", version: 1, locked: false, valid_until: 1_800_000_000 });
    expect(actions[1]).toEqual({ transfer: { receiver_id: WALLET, amount: (10n ** 23n).toString() } });
    expect(actions[2]).toEqual({
      add_session: {
        public_key: nearKeyOf(WALLET),
        label: "autopilot",
        scope: { outcomes: false, perps: false, hyperliquid: true },
        expires_at: 1_790_000_000,
        daily_limit: "500000000",
        gas_key: false,
        gas_funding: "0",
      },
    });
    expect(walletSetupActions({ contract: "o", walletAccount: WALLET, encrypted: "E", signed, policyCost: 1n, gasFunding: 0n, expiresAt: 1, dailyLimit: 1n })).toHaveLength(2);
  });

  test("freezing and unfreezing name the wallet by its OutLayer key and attach nothing", () => {
    expect(freezeCall("outlayer.testnet", WALLET)).toMatchObject({ methodName: "freeze_wallet", args: { wallet_pubkey: `ed25519:${WALLET}` }, deposit: "0" });
    expect(unfreezeCall("outlayer.testnet", WALLET).methodName).toBe("unfreeze_wallet");
  });
});

describe("the custody client", () => {
  test("registers, reads its address and signs the policy for the owner", async () => {
    const { fetchImpl, seen } = fakeFetch((r) => {
      if (r.path === "/register") return { status: 200, body: { wallet_id: "w1", api_key: "wk_secret", near_account_id: WALLET } };
      if (r.path === "/wallet/v1/address?chain=near") return { status: 200, body: { wallet_id: "w1", address: WALLET, public_key: `ed25519:${WALLET}` } };
      if (r.path === "/wallet/v1/encrypt-policy") return { status: 200, body: { encrypted_base64: "ENC", policy_hash: "h" } };
      if (r.path === "/wallet/v1/sign-policy") return { status: 200, body: { signature_hex: "sig", public_key_hex: WALLET, version: 1, locked: false, valid_until: 99, policy_hash: "h" } };
      if (r.path === "/wallet/v1/invalidate-cache") return { status: 200, body: {} };
      return undefined;
    });
    const { wallet, walletId, accountId } = await CustodyWallet.register(API, fetchImpl);
    expect([walletId, accountId, wallet.apiKey]).toEqual(["w1", WALLET, "wk_secret"]);
    expect(await wallet.address()).toEqual({ walletId: "w1", accountId: WALLET, custodyKey: `ed25519:${WALLET}` });
    expect(await wallet.encryptPolicy("w1", autopilotRules({ account: ACCOUNT }), AUTOPILOT_CAPABILITIES)).toEqual({ encrypted: "ENC", policyHash: "h" });
    expect(await wallet.signPolicy("ENC", ACCOUNT)).toEqual({ signatureHex: "sig", publicKeyHex: WALLET, version: 1, locked: false, validUntil: 99, policyHash: "h" });
    await wallet.refresh("w1");
    const enc = seen.find((s) => s.path === "/wallet/v1/encrypt-policy")!;
    expect(enc.headers.get("authorization")).toBe("Bearer wk_secret");
    expect(enc.body).toMatchObject({ wallet_id: "w1", capabilities: { sign_message: { allowed: false } } });
    expect(seen.find((s) => s.path === "/wallet/v1/sign-policy")!.body).toEqual({ encrypted_data: "ENC", caller: ACCOUNT });
  });

  test("a call carries an idempotency key; refusals and on-chain failures are told apart", async () => {
    let answer: { status: number; body: unknown } = { status: 200, body: { request_id: "r", status: "success", tx_hash: "TX1", result: null } };
    const { fetchImpl, seen } = fakeFetch((r) => (r.path === "/wallet/v1/call" ? answer : undefined));
    const wallet = new CustodyWallet("wk", API, fetchImpl);
    const call = { receiverId: ACCOUNT, methodName: "session_call", args: { action: "faucet" }, gas: "300000000000000", deposit: "0" };
    expect(await wallet.call(call)).toEqual({ txHash: "TX1", result: null });
    expect(seen[0]!.headers.get("x-idempotency-key")).toBeTruthy();
    expect(seen[0]!.body).toEqual({ receiver_id: ACCOUNT, method_name: "session_call", args: { action: "faucet" }, gas: "300000000000000", deposit: "0" });

    answer = { status: 403, body: { error: "policy_denied", message: "Address 'usdc.tredio.testnet' is not in whitelist" } };
    const denied = await wallet.call(call).catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(PolicyRefusal);
    expect((denied as PolicyRefusal).code).toBe("policy_denied");
    expect((denied as PolicyRefusal).retryable).toBe(false);

    answer = { status: 403, body: { error: "wallet_frozen", message: "Wallet is frozen" } };
    expect(((await wallet.call(call).catch((e: unknown) => e)) as PolicyRefusal).code).toBe("wallet_frozen");

    answer = { status: 409, body: { error: "wallet_busy", message: "another operation" } };
    expect(((await wallet.call(call).catch((e: unknown) => e)) as PolicyRefusal).retryable).toBe(true);

    answer = { status: 422, body: { error: "onchain_tx_failed", message: "session keys only", tx_hash: "TX2", failure: { ActionError: {} } } };
    const failed = await wallet.call(call).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(CustodyCallFailed);
    expect((failed as CustodyCallFailed).txHash).toBe("TX2");
    expect((failed as CustodyCallFailed).message).toBe("session keys only");

    answer = { status: 200, body: { request_id: "r", status: "pending_approval", tx_hash: null, approval_id: "a" } };
    expect(((await wallet.call(call).catch((e: unknown) => e)) as PolicyRefusal).code).toBe("pending_approval");
  });

  test("the policy on chain: controller, freeze and cost", async () => {
    const calls: unknown[] = [];
    const view = async <T>(contract: string, method: string, args: object): Promise<T> => {
      calls.push({ contract, method, args });
      if (method === "get_wallet_policy") return { owner: ACCOUNT, frozen: true, updated_at: 1_700_000_000_000_000_000, version: 2, locked: false } as T;
      return "9460000000000000000000" as T;
    };
    expect(await onChainPolicy(view, "outlayer.testnet", custodyKeyOf(WALLET))).toEqual({ owner: ACCOUNT, frozen: true, version: 2, locked: false, updatedAtMs: 1_700_000_000_000 });
    expect(await policyCost(view, "outlayer.testnet", custodyKeyOf(WALLET), "ENC")).toBe(9_460_000_000_000_000_000_000n);
    expect(calls[0]).toEqual({ contract: "outlayer.testnet", method: "get_wallet_policy", args: { wallet_pubkey: `ed25519:${WALLET}` } });
    expect(await onChainPolicy(async () => null as never, "o", "k")).toBeNull();
  });
});

describe("the OutLayer signer", () => {
  test("sends session_call to the account with the gas asked and no NEAR, and reads the return value from the chain", async () => {
    const { fetchImpl, seen } = fakeFetch((r) =>
      r.path === "/wallet/v1/policy"
        ? { status: 200, body: { wallet_id: "w", controller: ACCOUNT, frozen: false, policy: "stored", rules: autopilotRules({ account: ACCOUNT }), capabilities: AUTOPILOT_CAPABILITIES } }
        : { status: 200, body: { request_id: "r", status: "success", tx_hash: "TXH", result: { status: "success" } } },
    );
    const reads: string[] = [];
    const signer = new OutLayerSigner(new CustodyWallet("wk", API, fetchImpl), WALLET, {
      view: async <T>() => ({ owner: ACCOUNT, frozen: false, updated_at: 0 }) as T,
      contract: "outlayer.testnet",
      readValue: async (hash, sender) => {
        reads.push(`${hash}|${sender}`);
        return { r: "1", s: "2", v: 27 };
      },
    });
    expect(signer.sessionKey).toBe(nearKeyOf(WALLET));
    const out = await signer.sessionCall(ACCOUNT, { hl_leverage: { asset_index: 0, is_cross: false, leverage: 3, nonce: 1 } }, 150);
    expect(out).toEqual({ hash: "TXH", value: { r: "1", s: "2", v: 27 } });
    expect(reads).toEqual([`TXH|${WALLET}`]);
    expect(seen[0]!.body).toEqual({ receiver_id: ACCOUNT, method_name: "session_call", args: { action: { hl_leverage: { asset_index: 0, is_cross: false, leverage: 3, nonce: 1 } } }, gas: "150000000000000", deposit: "0" });
    expect(await signer.state()).toEqual({ frozen: false, controller: ACCOUNT });
    expect(await signer.policyProblem(ACCOUNT)).toBeNull();
    expect(await signer.policyProblem("someone.testnet")).toContain("other than the account");
  });

  test("a return value OutLayer includes is used as is", () => {
    expect(valueFromResult({ return_value: { r: "a" } })).toEqual({ r: "a" });
    expect(valueFromResult({ status: { SuccessValue: btoa(JSON.stringify({ v: 28 })) } })).toEqual({ v: 28 });
    expect(valueFromResult({ status: "success" })).toBeUndefined();
    expect(valueFromResult(null)).toBeUndefined();
  });
});
