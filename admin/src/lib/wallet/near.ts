"use client";
import type { NearConnector } from "@hot-labs/near-connect";
import { useSyncExternalStore } from "react";
import { NEAR_NETWORK } from "@/src/lib/config";

/**
 * The admin's NEAR wallet through NEAR Connect (HOT, Meteor, Intear, MyNearWallet and others).
 * Only the account and `signMessage` are used: the panel never sends a transaction.
 */

/** A NEP-413 signature as wallets return it (base64 signature, `ed25519:` key). */
export interface SignedMessage {
  accountId: string;
  publicKey: string;
  signature: string;
}

export interface WalletState {
  ready: boolean;
  accountId: string | null;
  connecting: boolean;
  error: string | null;
}

const SERVER_STATE: WalletState = { ready: false, accountId: null, connecting: false, error: null };
let state: WalletState = SERVER_STATE;
let connector: Promise<NearConnector> | null = null;
const listeners = new Set<() => void>();

function setState(patch: Partial<WalletState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

/** The connector, created once in the browser (the module touches `window`, so it loads lazily). */
function getConnector(): Promise<NearConnector> {
  connector ??= import("@hot-labs/near-connect").then(({ NearConnector }) => {
    const c = new NearConnector({ network: NEAR_NETWORK, autoConnect: true });
    c.on("wallet:signIn", (t: { accounts: Array<{ accountId: string }> }) => setState({ accountId: t.accounts[0]?.accountId ?? null, connecting: false, error: null }));
    c.on("wallet:signOut", () => setState({ accountId: null }));
    void c
      .wallet()
      .then(async (w) => setState({ accountId: (await w.getAccounts())[0]?.accountId ?? null }))
      .catch(() => undefined)
      .finally(() => setState({ ready: true }));
    return c;
  });
  return connector;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  void getConnector();
  return () => {
    listeners.delete(listener);
  };
}

export function useWallet(): WalletState {
  return useSyncExternalStore(subscribe, () => state, () => SERVER_STATE);
}

export async function connectWallet(): Promise<void> {
  setState({ connecting: true, error: null });
  try {
    await (await getConnector()).connect();
  } catch (e) {
    setState({ error: e instanceof Error && e.message ? e.message : "The wallet did not connect." });
  } finally {
    setState({ connecting: false });
  }
}

export async function disconnectWallet(): Promise<void> {
  try {
    await (await getConnector()).disconnect();
  } finally {
    setState({ accountId: null });
  }
}

/** NEP-413 `signMessage` by the connected account. */
export async function signMessage(message: string, recipient: string, nonce: Uint8Array): Promise<SignedMessage> {
  const wallet = await (await getConnector()).wallet();
  return wallet.signMessage({ message, recipient, nonce, network: NEAR_NETWORK });
}
