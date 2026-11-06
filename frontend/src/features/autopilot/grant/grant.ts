"use client";
import { useQueryClient } from "@tanstack/react-query";
import { seal } from "@tredio/autopilot";
import { useCallback, useState } from "react";
import { describeError, useAccount } from "@/lib/account/AccountProvider";
import { ApiError, autopilot } from "@/lib/api";
import { newKeyPair } from "@/lib/chain/keys";
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
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** USDC a day Autopilot may move (Hyperliquid margin lives on Hyperliquid, so this caps session outflows on NEAR). */
export const DAILY_CAPS = [100, 250, 500, 1000] as const;
/** How long a grant lasts; the API allows up to a week. */
export const VALID_DAYS = [1, 3, 7] as const;

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

  const refresh = useCallback(async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["ap-grant"] }),
      qc.invalidateQueries({ queryKey: ["sessions"] }),
      qc.invalidateQueries({ queryKey: ["dormant-keys"] }),
      qc.invalidateQueries({ queryKey: ["ap-rules"] }),
      qc.invalidateQueries({ queryKey: ["ap-rule"] }),
      qc.invalidateQueries({ queryKey: ["follows"] }),
    ]);
  }, [qc]);

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

  /** One passkey prompt: removes the session on chain, then pauses running rules and copies. */
  const revoke = useCallback(
    async (tx: Tx, key: string): Promise<boolean> => {
      setError(null);
      setWorking(true);
      try {
        const sent = await tx.run(() => account.ownerExecute([ownerActions.revokeSession(key)]), { action: "Revoke Autopilot access", done: "Autopilot access revoked", pending: "Confirm with your passkey" });
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

  return { grant, revoke, error, working, clearError: () => setError(null) };
}
