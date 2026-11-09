"use client";
import { useMutation } from "@tanstack/react-query";
import { describeError, useAccount } from "@/lib/account/AccountProvider";
import type { PrivateIdentity } from "@/lib/account/service";
import { social } from "@/lib/api";
import { identitySignInMessage, signAsCaller } from "@/lib/social";

/**
 * The caller identity on this device: an ed25519 key the passkey's PRF derives, apart from the
 * trading account, so nobody can tie calls to an account unless the owner links them. Its id is
 * the public key as 64 hex characters. When the device lost it, one passkey prompt rebuilds it.
 */
export function useCallerIdentity() {
  const account = useAccount();
  const identity = account.privateIdentity;
  const unlock = useMutation({ mutationFn: () => account.unlockPrivate() });
  return {
    identity,
    /** The identity's id once it is usable here. */
    address: identity?.id ?? null,
    /** The identity this device knows (to recognise your own profile). */
    known: identity?.id ?? null,
    /** Wallet accounts have no passkey to derive one from. */
    available: account.kind !== "wallet",
    unlock: () => unlock.mutate(),
    unlocking: unlock.isPending,
    unlockError: unlock.error ? describeError(unlock.error) : null,
  };
}

let session: { identity: string; token: string; expiresAt: number } | null = null;

/** A vault session for the identity: one signature (no prompt), kept until it nears expiry. */
export async function identityToken(identity: PrivateIdentity): Promise<string> {
  if (session && session.identity === identity.id && session.expiresAt > Date.now() / 1000 + 120) return session.token;
  const { issuedAt, signature } = await signAsCaller(identity, (t) => identitySignInMessage(identity.id, t));
  const res = await social.identitySession(identity.id, issuedAt, signature);
  session = { identity: identity.id, token: res.token, expiresAt: res.expiresAt };
  return res.token;
}

/** Forgets the vault session (after a 401). */
export const dropIdentityToken = () => {
  session = null;
};
