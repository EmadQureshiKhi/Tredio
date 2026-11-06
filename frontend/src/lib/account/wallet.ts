import type { NearConnector, NearWalletBase } from "@hot-labs/near-connect";
import type { Call } from "@tredio/contracts";
import { base58Decode, base64Encode, randomBytes } from "@/lib/chain/encoding";
import { failureOf, hashOf, type Outcome, refusalOf, returnValue, TxFailed } from "@/lib/chain/outcome";
import { NETWORK, SIGN_IN_RECIPIENT } from "@/lib/config";

/**
 * NEAR wallets through NEAR Connect (HOT, Meteor, Intear and the others its manifest lists). The
 * wallet signs in with a NEP-413 message (the same message and recipient as a session key) and
 * sends Tredio's call descriptors itself, paying its own gas. Wallets run in NEAR Connect's
 * sandboxed iframes, loaded only when someone picks one.
 */

let connecting: Promise<NearConnector> | null = null;

export function connector(): Promise<NearConnector> {
  connecting ??= import("@hot-labs/near-connect").then(async ({ NearConnector }) => {
    const c = new NearConnector({
      network: NETWORK,
      // Only wallets that can sign the sign-in message and send transactions on this network.
      features: { signMessage: true, signAndSendTransaction: true, [NETWORK]: true },
      autoConnect: false,
    });
    await c.whenManifestLoaded.catch(() => undefined);
    return c;
  });
  // A failed load (offline) is asked again next time.
  connecting.catch(() => {
    connecting = null;
  });
  return connecting;
}

export interface WalletAccount {
  wallet: NearWalletBase;
  accountId: string;
  name: string;
}

/** Opens NEAR Connect's picker and signs in with the chosen wallet. */
export async function connectWallet(): Promise<WalletAccount> {
  const c = await connector();
  const wallet = await c.connect();
  const accounts = await wallet.getAccounts({ network: NETWORK });
  const accountId = accounts[0]?.accountId;
  if (!accountId) throw new Error("The wallet did not share an account.");
  return { wallet, accountId, name: wallet.manifest.name };
}

/** The wallet this browser connected before, when it still holds `accountId`. */
export async function restoreWallet(accountId: string): Promise<WalletAccount | null> {
  try {
    const c = await connector();
    const { wallet, accounts } = await c.getConnectedWallet();
    return accounts.some((a) => a.accountId === accountId) ? { wallet, accountId, name: wallet.manifest.name } : null;
  } catch {
    return null;
  }
}

export async function disconnectWallet(wallet: NearWalletBase | null): Promise<void> {
  const c = await connector().catch(() => null);
  await c?.disconnect(wallet ?? undefined).catch(() => undefined);
}

/** NEP-413 signatures are base64; a few wallets answer `ed25519:<base58>`. */
function base64Signature(signature: string): string {
  return signature.startsWith("ed25519:") ? base64Encode(base58Decode(signature.slice("ed25519:".length))) : signature;
}

/** Signs `message` for Tredio's API with the wallet (one wallet prompt). */
export async function walletSignMessage(w: WalletAccount, message: string): Promise<{ signer: string; signature: string; nonce: string }> {
  const nonce = randomBytes(32);
  const signed = await w.wallet.signMessage({ message, recipient: SIGN_IN_RECIPIENT, nonce, network: NETWORK, signerId: w.accountId });
  if (!signed?.publicKey || !signed.signature) throw new Error("The wallet did not sign the message.");
  return { signer: signed.publicKey, signature: base64Signature(signed.signature), nonce: base64Encode(nonce) };
}

const action = (c: Call) => ({ type: "FunctionCall" as const, params: { methodName: c.methodName, args: c.args, gas: c.gas, deposit: c.deposit } });

/** Sends `calls` from the wallet, one transaction each, in order; the last one's result comes back. */
export async function walletSend<T = unknown>(w: WalletAccount, calls: Call[]): Promise<{ hash: string; value: T | undefined; outcome: Outcome }> {
  let outcomes: Outcome[];
  try {
    outcomes =
      calls.length === 1
        ? [(await w.wallet.signAndSendTransaction({ network: NETWORK, signerId: w.accountId, receiverId: calls[0]!.receiverId, actions: [action(calls[0]!)] })) as unknown as Outcome]
        : ((await w.wallet.signAndSendTransactions({ network: NETWORK, signerId: w.accountId, transactions: calls.map((c) => ({ receiverId: c.receiverId, actions: [action(c)] })) })) as unknown as Outcome[]);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (/reject|cancel|denied|closed/i.test(m)) throw new TxFailed("You declined it in your wallet, so nothing was sent.");
    throw new TxFailed(m);
  }
  for (const o of outcomes) {
    const failed = failureOf(o) ?? refusalOf(o);
    if (failed) throw new TxFailed(failed, hashOf(o) || null);
  }
  const last = outcomes[outcomes.length - 1]!;
  return { hash: hashOf(last), value: returnValue<T>(last), outcome: last };
}
