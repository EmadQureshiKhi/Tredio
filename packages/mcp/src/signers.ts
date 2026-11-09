/**
 * Who signs for the trade tools. Two paths work without a person present:
 *
 * - A passkey account's session key (`TREDIO_SESSION_ACCOUNT`, `TREDIO_SESSION_KEY`): a
 *   function-call key, usually a gas key, that may only call `session_call` with typed actions,
 *   inside the session's scope, expiry and on-chain daily USDC limit. It trades Up/Down (anchored
 *   swaps) and opens and closes perps; coin trades and margin top-ups are owner actions the
 *   passkey signs, so a session cannot make them.
 * - A plain NEAR account's own full-access key (`TREDIO_TRADER_ACCOUNT`,
 *   `TREDIO_TRADER_PRIVATE_KEY`): it calls the contracts itself (`ft_transfer_call` with the
 *   matching `msg`), so it can do everything, coin trades included.
 *
 * A caller identity (calls on trends) is any ed25519 key; its public key in hex is the caller id.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58Decode, publicKeyOf, type RpcEndpoints, Sender } from "@tredio/chain";
import type { Call } from "@tredio/contracts";

/** What a sent transaction answers, as far as the trade tools read it. */
export interface TxOutcome {
  transaction?: { hash?: string };
  transaction_outcome?: { id?: string; outcome?: { logs?: string[] } };
  receipts_outcome?: Array<{ outcome: { logs?: string[]; executor_id?: string } }>;
}

export interface Signer {
  readonly kind: "session" | "account";
  readonly account: string;
  readonly publicKey: string;
  /** Sends one call signed by this key and waits for every receipt; a `TxError` from `@tredio/chain` when it fails. */
  send(call: Call): Promise<TxOutcome>;
}

interface SignerOptions {
  network: "testnet" | "mainnet";
  account: string;
  rpc: RpcEndpoints;
}

/** A NEAR account's own full-access key: one transaction at a time. */
export function accountSigner(o: SignerOptions & { privateKey: string }): Signer {
  const sender = new Sender({ network: o.network, accountId: o.account, privateKey: o.privateKey, rpc: o.rpc });
  return { kind: "account", account: o.account, publicKey: sender.publicKey, send: (call) => sender.sendOutcome(call) as Promise<TxOutcome> };
}

/**
 * A passkey account's session key. A gas key pays from its own prepaid balance and sends on nonce
 * lane 0 (the app's sessions use their own keys and lanes); a plain function-call key pays from
 * the account. Which one it is is read from the chain on the first send.
 */
export function sessionSigner(o: SignerOptions & { sessionKey: string; gasKey: (account: string, publicKey: string) => Promise<{ balance: bigint } | null> }): Signer {
  const publicKey = publicKeyOf(o.sessionKey);
  let sender: Promise<Sender> | null = null;
  const get = () =>
    (sender ??= o
      .gasKey(o.account, publicKey)
      .then((g) => new Sender({ network: o.network, accountId: o.account, privateKey: o.sessionKey, rpc: o.rpc, ...(g ? { gasKeyLanes: 1 } : {}) }))
      .catch((e: unknown) => {
        sender = null;
        throw e;
      }));
  return { kind: "session", account: o.account, publicKey, send: async (call) => (await get()).sendOutcome(call) as Promise<TxOutcome> };
}

/** An ed25519 key that signs calls: `identity` is its public key as 64 hex characters, `sign` answers base64. */
export interface CallerKey {
  readonly identity: string;
  sign(message: string): string;
}

/** A caller key from an `ed25519:<base58>` secret (the 64-byte secret NEAR tools write, or a 32-byte seed). */
export function callerKey(secret: string): CallerKey {
  const raw = base58Decode(secret.trim().replace(/^ed25519:/, ""));
  if (raw.length !== 64 && raw.length !== 32) throw new Error("a caller key is an ed25519 secret key (ed25519:<base58> of 32 or 64 bytes)");
  const seed = raw.slice(0, 32);
  return {
    identity: Buffer.from(ed25519.getPublicKey(seed)).toString("hex"),
    sign: (message) => Buffer.from(ed25519.sign(new TextEncoder().encode(message), seed)).toString("base64"),
  };
}
