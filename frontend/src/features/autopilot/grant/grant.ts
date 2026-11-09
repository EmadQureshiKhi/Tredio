"use client";
import { useQueryClient } from "@tanstack/react-query";
import { seal } from "@tredio/autopilot";
import { keepsGasKeys, type OwnerAction } from "@tredio/contracts";
import {
  AUTOPILOT_CAPABILITIES,
  autopilotRules,
  CUSTODY_API,
  CUSTODY_CONTRACT,
  CustodyWallet,
  custodyKeyOf,
  DEFAULT_GAS_FUNDING,
  freezeCall,
  nearKeyOf,
  newGrantCredential,
  ownerCall,
  policyCost,
  unfreezeCall,
  walletSession,
  walletSetupActions,
} from "@tredio/custody";
import { useCallback, useState } from "react";
import { describeError, useAccount } from "@/lib/account/AccountProvider";
import { rpId } from "@/lib/account/service";
import { accountVersion } from "@/lib/account/version";
import { assert } from "@/lib/account/webauthn";
import { type AgentWebAuthn, ApiError, autopilot, type GrantWallet } from "@/lib/api";
import { view } from "@/lib/chain/client";
import { base64UrlDecode, base64UrlEncode, utf8 } from "@/lib/chain/encoding";
import { newKeyPair } from "@/lib/chain/keys";
import { NETWORK } from "@/lib/config";
import { ownerActions } from "@/lib/trade/calls";
import type { Tx } from "@/lib/trade/useTx";

/**
 * Granting and revoking Autopilot's access. The app makes a Hyperliquid-only session key on this
 * device and seals it to the executor, so the API only stores a box it cannot open; the account
 * adds the session with one passkey prompt, the relayer fills its gas, and the API confirms it on
 * chain. Revoking removes the session on chain (v1 account code deletes its key; v2 keeps the key,
 * unable to act, so its gas is not burned), then pauses what it was running.
 *
 * The sealed plaintext is the key's NEAR secret (`ed25519:<base58 of seed || public key>`).
 *
 * A grant can instead run through a policy wallet, whose key never leaves a custody enclave. On
 * testnet the app makes an OutLayer wallet here, has its enclave encrypt Autopilot's policy and sign
 * it for this account, and one passkey prompt stores the policy (the account becomes its only
 * controller), sends the wallet NEAR for gas and adds Autopilot's session for the wallet's own key.
 * The sealed plaintext is then the wallet's API key. On mainnet the wallet is a NEAR Intents Agent
 * API agent owned by this passkey: the API prepares each owner action and the passkey signs it.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** USDC a day Autopilot may move (Hyperliquid margin lives on Hyperliquid, so this caps session outflows on NEAR). */
export const DAILY_CAPS = [100, 250, 500, 1000] as const;
/** How long a grant lasts; the API allows up to a week. */
export const VALID_DAYS = [1, 3, 7] as const;

/** NEAR the account sends a new policy wallet for gas. */
export const WALLET_GAS_NEAR = Number(DEFAULT_GAS_FUNDING / 10n ** 18n) / 1e6;

/** Signs an Agent API owner action with the account's passkey: the credential as WebAuthn JSON. */
async function signAgentIntent(w: AgentWebAuthn, credentialId: string | null) {
  const a = await assert(w.rpId, base64UrlDecode(w.challenge), w.allowCredentials[0]?.id ?? credentialId);
  return {
    id: a.credentialId,
    rawId: a.credentialId,
    type: "public-key" as const,
    response: { clientDataJSON: base64UrlEncode(utf8(a.proof.client_data_json)), authenticatorData: a.proof.authenticator_data, signature: base64UrlEncode(a.signed.der) },
    clientExtensionResults: {},
  };
}

/** A new grant key, sealed at once to the executor and bound to the account and the key's id. */
export async function sealGrantKey(owner: string, executorPublicKey: string): Promise<{ sessionKey: string; sealedKey: string }> {
  const key = newKeyPair();
  return { sessionKey: key.publicKey, sealedKey: await seal(key.secretKey, executorPublicKey, { owner, sessionKey: key.publicKey }) };
}

export function useGrantActions() {
  const account = useAccount();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const refreshQueries = useCallback(async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["ap-grant"] }),
      qc.invalidateQueries({ queryKey: ["sessions"] }),
      qc.invalidateQueries({ queryKey: ["dormant-keys"] }),
      qc.invalidateQueries({ queryKey: ["ap-rules"] }),
      qc.invalidateQueries({ queryKey: ["ap-rule"] }),
      qc.invalidateQueries({ queryKey: ["follows"] }),
    ]);
  }, [qc]);
  const refresh = refreshQueries;

  /** One passkey prompt. Resolves true once the API sees the session active on chain. */
  const grant = useCallback(
    async (tx: Tx, dailyCapUsdc: number, validDays: number): Promise<boolean> => {
      const owner = account.address;
      if (!owner) return false;
      setError(null);
      setWorking(true);
      try {
        const { publicKey } = await autopilot.sealKey();
        const key = await sealGrantKey(owner, publicKey);
        const dailyLimit = BigInt(dailyCapUsdc) * 1_000_000n;
        const { session } = await autopilot.requestGrant(dailyLimit, validDays, key);
        // The passkey adds the key made here, Hyperliquid only, whatever the server answered.
        if (session.public_key !== key.sessionKey) throw new Error("The server answered with a different key. Nothing was added; try again.");
        const scope = { outcomes: false, perps: false, hyperliquid: true };
        const sent = await tx.run(() => account.addSession({ publicKey: key.sessionKey, label: session.label, scope, expiresAt: session.expires_at, dailyLimit }), {
          action: "Grant Autopilot access",
          done: "Autopilot access granted",
          pending: "Confirm with your passkey",
        });
        if (!sent) return false;
        // The API reads the account on chain; its node may be a block behind the relayer's.
        for (let attempt = 0; ; attempt++) {
          try {
            await autopilot.confirmGrant();
            break;
          } catch (e) {
            if (!(e instanceof ApiError && (e.status === 409 || e.status === 503)) || attempt >= 8) throw e;
            await sleep(800 + attempt * 400);
          }
        }
        await refresh();
        return true;
      } catch (e) {
        setError(describeError(e));
        return false;
      } finally {
        setWorking(false);
      }
    },
    [account, refresh],
  );

  /** Waits until the API sees the session on chain (its node may be a block behind the relayer's). */
  const confirm = useCallback(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        await autopilot.confirmGrant();
        return;
      } catch (e) {
        if (!(e instanceof ApiError && (e.status === 409 || e.status === 503)) || attempt >= 8) throw e;
        await sleep(800 + attempt * 400);
      }
    }
  }, []);

  /**
   * Autopilot on a policy wallet. Testnet: one passkey prompt (store the policy, fund the wallet,
   * add the session). Mainnet: three (create the agent, grant the executor, add the session).
   */
  const grantWallet = useCallback(
    async (tx: Tx, dailyCapUsdc: number, validDays: number): Promise<boolean> => {
      const owner = account.address;
      if (!owner) return false;
      setError(null);
      setWorking(true);
      try {
        const { publicKey } = await autopilot.sealKey();
        const dailyLimit = BigInt(dailyCapUsdc) * 1_000_000n;
        let actions: OwnerAction[];
        let refresh: () => Promise<void> = async () => {};
        if (NETWORK === "mainnet") {
          const credentialId = account.session?.credentialId ?? null;
          const created = await autopilot.agentIntent({ type: "agent_create", credentialId: credentialId ?? "", rpId: rpId(), origin: window.location.origin });
          const agent = await autopilot.agentSubmit(created.correlationId, await signAgentIntent(created.webauthn, credentialId));
          if (!agent.account) throw new Error("The agent has no NEAR account yet; try again in a minute.");
          const grantToken = newGrantCredential();
          const issued = await autopilot.agentIntent({ type: "grant_issue", agentId: agent.agentId, commitment: grantToken.commitment, validDays });
          await autopilot.agentSubmit(issued.correlationId, await signAgentIntent(issued.webauthn, credentialId));
          const sessionKey = nearKeyOf(agent.account);
          const sealedKey = await seal(grantToken.token, publicKey, { owner, sessionKey });
          const { session } = await autopilot.requestGrant(dailyLimit, validDays, { sessionKey, sealedKey }, { kind: "agent-api", account: agent.account, agentId: agent.agentId });
          if (session.public_key !== sessionKey || session.gas_key) throw new Error("The server answered with different terms. Nothing was added; try again.");
          actions = [{ transfer: { receiver_id: agent.account, amount: DEFAULT_GAS_FUNDING.toString() } }, walletSession({ walletAccount: agent.account, expiresAt: session.expires_at, dailyLimit }) as OwnerAction];
        } else {
          // The wallet is made here; its key is sealed to the executor only after the account controls its policy.
          const { wallet, walletId, accountId } = await CustodyWallet.register(CUSTODY_API[NETWORK]);
          const { encrypted } = await wallet.encryptPolicy(walletId, autopilotRules({ account: owner }), AUTOPILOT_CAPABILITIES);
          const signed = await wallet.signPolicy(encrypted, owner);
          const contract = CUSTODY_CONTRACT[NETWORK];
          const cost = await policyCost((c, m, a) => view(c, m, a), contract, custodyKeyOf(accountId), encrypted);
          const sessionKey = nearKeyOf(accountId);
          const sealedKey = await seal(wallet.apiKey, publicKey, { owner, sessionKey });
          const { session } = await autopilot.requestGrant(dailyLimit, validDays, { sessionKey, sealedKey }, { kind: "outlayer", account: accountId });
          if (session.public_key !== sessionKey || session.gas_key) throw new Error("The server answered with different terms. Nothing was added; try again.");
          actions = walletSetupActions({ contract, walletAccount: accountId, encrypted, signed, policyCost: cost, gasFunding: DEFAULT_GAS_FUNDING, expiresAt: session.expires_at, dailyLimit }) as OwnerAction[];
          refresh = () => wallet.refresh(walletId).catch(() => undefined);
        }
        const sent = await tx.run(() => account.ownerExecute(actions), { action: "Put Autopilot on a policy wallet", done: "Autopilot's policy wallet is set up", pending: "Confirm with your passkey" });
        if (!sent) return false;
        await refresh();
        await confirm();
        await refreshQueries();
        return true;
      } catch (e) {
        setError(describeError(e));
        return false;
      } finally {
        setWorking(false);
      }
    },
    [account, confirm, refreshQueries],
  );

  /** One passkey prompt: the account freezes or unfreezes its policy wallet; a frozen wallet's enclave signs nothing. */
  const setFrozen = useCallback(
    async (tx: Tx, wallet: GrantWallet, frozen: boolean): Promise<boolean> => {
      setError(null);
      setWorking(true);
      try {
        if (wallet.kind === "agent-api") {
          if (!wallet.agentId) throw new Error("This grant names no agent.");
          const intent = await autopilot.agentIntent({ type: frozen ? "agent_freeze" : "agent_unfreeze", agentId: wallet.agentId });
          await autopilot.agentSubmit(intent.correlationId, await signAgentIntent(intent.webauthn, account.session?.credentialId ?? null));
        } else {
          const call = (frozen ? freezeCall : unfreezeCall)(CUSTODY_CONTRACT[NETWORK], wallet.account);
          const sent = await tx.run(() => account.ownerExecute([ownerCall(call) as OwnerAction]), {
            action: frozen ? "Freeze Autopilot's wallet" : "Unfreeze Autopilot's wallet",
            done: frozen ? "Autopilot's wallet is frozen" : "Autopilot's wallet is unfrozen",
            pending: "Confirm with your passkey",
          });
          if (!sent) return false;
        }
        await refreshQueries();
        return true;
      } catch (e) {
        setError(describeError(e));
        return false;
      } finally {
        setWorking(false);
      }
    },
    [account, refreshQueries],
  );

  /** One passkey prompt: renews the session for the same policy wallet in place (its key and policy stay). */
  const renewWallet = useCallback(
    async (tx: Tx, wallet: GrantWallet, dailyCapUsdc: number, validDays: number): Promise<boolean> => {
      setError(null);
      setWorking(true);
      try {
        const terms = { walletAccount: wallet.account, expiresAt: Math.floor(Date.now() / 1000) + validDays * 86_400, dailyLimit: BigInt(dailyCapUsdc) * 1_000_000n };
        const sent = await tx.run(() => account.ownerExecute([walletSession(terms) as OwnerAction]), { action: "Renew Autopilot access", done: "Autopilot access renewed", pending: "Confirm with your passkey" });
        if (!sent) return false;
        await confirm();
        await refreshQueries();
        return true;
      } catch (e) {
        setError(describeError(e));
        return false;
      } finally {
        setWorking(false);
      }
    },
    [account, confirm, refreshQueries],
  );

  /** One passkey prompt: the account sends its policy wallet more NEAR for gas. */
  const fundWallet = useCallback(
    async (tx: Tx, wallet: GrantWallet): Promise<boolean> => {
      setError(null);
      const sent = await tx.run(() => account.ownerExecute([ownerActions.transferNear(wallet.account, DEFAULT_GAS_FUNDING)]), { action: "Send gas to Autopilot's wallet", done: "Gas sent", pending: "Confirm with your passkey" });
      await refreshQueries();
      return Boolean(sent);
    },
    [account, refreshQueries],
  );

  /** One passkey prompt: removes the session on chain, then pauses running rules and copies. */
  const revoke = useCallback(
    async (tx: Tx, key: string): Promise<boolean> => {
      setError(null);
      setWorking(true);
      try {
        // A grant's key is never used twice (a new grant makes a new one), so on v2, where revoking would
        // keep the key dormant toward the account's key limit, it is deleted instead.
        const deleteKey = account.address ? keepsGasKeys(await accountVersion(account.address)) : false;
        const sent = await tx.run(() => account.ownerExecute([ownerActions.revokeSession(key, deleteKey)]), { action: "Revoke Autopilot access", done: "Autopilot access revoked", pending: "Confirm with your passkey" });
        if (!sent) return false;
        const [{ rules }, { follows }] = await Promise.all([autopilot.rules(), autopilot.follows()]);
        await Promise.all([
          ...rules.filter((r) => r.status === "enabled").map((r) => autopilot.setStatus(r.id, "paused").catch(() => null)),
          ...follows.filter((f) => f.status === "active").map((f) => autopilot.setFollowStatus(f.id, "paused").catch(() => null)),
        ]);
        await refresh();
        return true;
      } catch (e) {
        setError(describeError(e));
        await refresh();
        return false;
      } finally {
        setWorking(false);
      }
    },
    [account, refresh],
  );

  return { grant, grantWallet, renewWallet, setFrozen, fundWallet, revoke, error, working, clearError: () => setError(null) };
}
