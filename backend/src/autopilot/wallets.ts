import { CUSTODY_CONTRACT, custodyKeyOf, isImplicitAccount, onChainPolicy } from "@tredio/custody";
import { type AgentApi, agentPolicyProblem, type GenerateIntentResponse, autopilotAgentPolicy, ownerIntents, type PasskeyCredential, passkeyOwner, passkeySpki, submitOwnerIntent } from "@tredio/custody/agent-api";
import { Hono } from "hono";
import { z } from "zod";
import type { Log } from "../log";

/**
 * Policy wallets behind Autopilot grants. On testnet the app makes an OutLayer custody wallet in the
 * browser and the account's passkey stores its policy on chain (`outlayer.testnet`), so this server
 * only checks the result: the policy is stored and its controller is the account. On mainnet the
 * wallet is a NEAR Intents Agent API agent owned by the account's passkey; the partner key stays
 * here, so this server prepares each owner action, the passkey signs it in the browser, and this
 * server submits it.
 */

export type WalletKind = "outlayer" | "agent-api";

export interface GrantWallet {
  kind: WalletKind;
  account: string;
  agentId: string | null;
}

/** A grant's wallet as the app sends it: the wallet's implicit account and, on mainnet, its agent. */
export const walletBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("outlayer"), account: z.string().refine(isImplicitAccount, "an implicit account (64 hex characters)") }),
  z.object({ kind: z.literal("agent-api"), account: z.string().refine(isImplicitAccount, "an implicit account (64 hex characters)"), agentId: z.string().min(4).max(80) }),
]);

export interface WalletDeps {
  network: "testnet" | "mainnet";
  view: <T>(contractId: string, method: string, args: object) => Promise<T>;
  /** An account's NEAR (yoctoNEAR). */
  balance: (account: string) => Promise<bigint>;
  /** #mainnet: the NEAR Intents Agent API under the partner key; null without one. */
  agentApi: AgentApi | null;
}

/** Why `wallet` is not a policy wallet `owner` controls with Autopilot's policy, or null. */
export async function walletOwnerProblem(d: WalletDeps, owner: string, wallet: GrantWallet): Promise<string | null> {
  if (wallet.kind === "outlayer") {
    const p = await onChainPolicy(d.view, CUSTODY_CONTRACT[d.network], custodyKeyOf(wallet.account));
    if (!p) return "the wallet's policy is not stored on chain yet";
    if (p.owner !== owner) return `the wallet's policy is controlled by ${p.owner}, not your account`;
    return null;
  }
  if (!d.agentApi || !wallet.agentId) return "this server has no NEAR Intents Agent API key";
  const owned = await agentOwnerProblem(d, owner, wallet.agentId);
  if (owned) return owned.problem;
  const [agent, policy] = await Promise.all([d.agentApi.getAgent(wallet.agentId), d.agentApi.getPolicy(wallet.agentId)]);
  if (agent.wallet?.near_account_id !== wallet.account) return "the agent's NEAR account is not the wallet named";
  return agentPolicyProblem(policy.policy, owner);
}

/** Null when the agent is owned by `owner`'s passkey (read on chain), else why not. */
export async function agentOwnerProblem(d: WalletDeps, owner: string, agentId: string): Promise<{ problem: string } | null> {
  if (!d.agentApi) return { problem: "this server has no NEAR Intents Agent API key" };
  const [agent, ownerKey] = await Promise.all([d.agentApi.getAgent(agentId), d.view<string>(owner, "owner_key", {})]);
  return agent.owner?.type === "passkey" && agent.owner.public_key === passkeySpki(ownerKey) ? null : { problem: "the agent is not owned by your account's passkey" };
}

/** What the app shows of a grant's wallet: its freeze, its controller and its gas. */
export async function walletStatus(d: WalletDeps, wallet: GrantWallet): Promise<{ frozen: boolean | null; controller: string | null; balance: string | null }> {
  const balance = await d
    .balance(wallet.account)
    .then((b) => b.toString())
    .catch(() => null);
  if (wallet.kind === "outlayer") {
    const p = await onChainPolicy(d.view, CUSTODY_CONTRACT[d.network], custodyKeyOf(wallet.account)).catch(() => undefined);
    return { frozen: p === undefined ? null : (p?.frozen ?? false), controller: p?.owner ?? null, balance };
  }
  const policy = d.agentApi && wallet.agentId ? await d.agentApi.getPolicy(wallet.agentId).catch(() => null) : null;
  return { frozen: policy?.policy?.frozen ?? null, controller: null, balance };
}

const intentBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent_create"), credentialId: z.string().regex(/^[A-Za-z0-9_-]{8,512}$/), rpId: z.string().min(1).max(253), origin: z.string().url() }),
  z.object({ type: z.literal("grant_issue"), agentId: z.string().min(4).max(80), commitment: z.string().regex(/^[0-9a-f]{64}$/), validDays: z.number().int().min(1).max(30) }),
  z.object({ type: z.enum(["agent_freeze", "agent_unfreeze"]), agentId: z.string().min(4).max(80) }),
]);
const submitBody = z.object({
  correlationId: z.string().min(8).max(128),
  credential: z.object({
    id: z.string(),
    rawId: z.string(),
    type: z.literal("public-key"),
    response: z.object({ clientDataJSON: z.string(), authenticatorData: z.string(), signature: z.string(), userHandle: z.string().optional() }),
    clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
    authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  }),
});

type Generated = Pick<GenerateIntentResponse, "type" | "correlation_id" | "agent_id" | "intent" | "preview">;

export interface AgentRouteDeps extends WalletDeps {
  log: Log;
  now?: () => number;
}

/**
 * #mainnet: the owner actions of an account's Autopilot agent, signed by its passkey. `intent`
 * prepares one (the partner key never leaves this server) and keeps it for ten minutes, for this
 * account only; `submit` hands the passkey's assertion to the API and waits for the outcome.
 */
export function agentIntentRoutes(d: AgentRouteDeps) {
  const app = new Hono<{ Variables: { user: string } }>();
  const pending = new Map<string, { owner: string; generated: Generated; at: number }>();
  const now = d.now ?? Date.now;
  const off = () => (d.network !== "mainnet" || !d.agentApi ? "the NEAR Intents Agent API runs on mainnet, with this server's partner key" : null);

  app.post("/autopilot/agent/intent", async (c) => {
    const why = off();
    if (why) return c.json({ error: why }, 503);
    const api = d.agentApi!;
    const body = intentBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") }, 400);
    const owner = c.get("user");
    const b = body.data;
    try {
      let generated: Generated;
      if (b.type === "agent_create") {
        // The owner is the account's own passkey, read on chain, never taken from the request.
        const ownerKey = await d.view<string>(owner, "owner_key", {});
        generated = await ownerIntents.create(api, owner, passkeyOwner({ ownerKeyHex: ownerKey, credentialId: b.credentialId, rpId: b.rpId, origin: b.origin }), autopilotAgentPolicy({ account: owner }));
      } else {
        // Only the account's own agent; a grant also needs Autopilot's policy in force.
        const owned = await agentOwnerProblem(d, owner, b.agentId);
        if (owned) return c.json({ error: owned.problem }, 409);
        const policy = b.type === "grant_issue" ? agentPolicyProblem((await api.getPolicy(b.agentId)).policy, owner) : null;
        if (policy) return c.json({ error: policy }, 409);
        generated =
          b.type === "grant_issue"
            ? await ownerIntents.grant(api, b.agentId, b.commitment, new Date(now() + b.validDays * 86_400_000))
            : b.type === "agent_freeze"
              ? await ownerIntents.freeze(api, b.agentId)
              : await ownerIntents.unfreeze(api, b.agentId);
      }
      if (generated.intent.standard !== "webauthn") return c.json({ error: `the API asked for a ${generated.intent.standard} signature, not the passkey's` }, 502);
      for (const [k, v] of pending) if (now() - v.at > 600_000) pending.delete(k);
      pending.set(generated.correlation_id, { owner, generated, at: now() });
      return c.json({ correlationId: generated.correlation_id, type: generated.type, agentId: generated.agent_id, summary: generated.preview.summary, webauthn: generated.intent.payload });
    } catch (e) {
      d.log.warn({ owner, type: b.type, err: e instanceof Error ? e.message : String(e) }, "agent intent failed");
      return c.json({ error: `the Agent API refused: ${e instanceof Error ? e.message : String(e)}` }, 502);
    }
  });

  app.post("/autopilot/agent/submit", async (c) => {
    const why = off();
    if (why) return c.json({ error: why }, 503);
    const body = submitBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "send the passkey's assertion for a prepared intent" }, 400);
    const p = pending.get(body.data.correlationId);
    if (!p || p.owner !== c.get("user")) return c.json({ error: "no such intent for your account; prepare it again" }, 404);
    try {
      const status = await submitOwnerIntent(d.agentApi!, p.generated, body.data.credential as PasskeyCredential);
      pending.delete(body.data.correlationId);
      const agent = p.generated.type === "agent_create" ? await d.agentApi!.getAgent(p.generated.agent_id) : null;
      return c.json({ status: status.status, agentId: p.generated.agent_id, account: agent?.wallet?.near_account_id ?? null });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  return app;
}
