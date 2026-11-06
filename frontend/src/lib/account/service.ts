import { ed25519 } from "@noble/curves/ed25519.js";
import {
  type AccountVersion,
  type Call,
  keepsGasKeys,
  type OwnerAction,
  type OwnerApproval,
  type OwnerApprovalRequest,
  ownerApprovalDigest,
  ownerRequest,
  requestChallenge,
  requestJson,
  type Session,
  type SessionAction,
  sessionCallPrepaid,
  sessionCallTgas,
  upgradeToV2,
} from "@tredio/contracts";
import { activation, ownerApprovals } from "@/lib/api";
import { accessKey, accountState, view } from "@/lib/chain/client";
import { base64Encode, hexEncode, randomBytes, utf8 } from "@/lib/chain/encoding";
import { newKeyPair, publicKeyOf, signNep413 } from "@/lib/chain/keys";
import { type Outcome, refusalOf, TxFailed } from "@/lib/chain/outcome";
import { follow, GasKeySender, type Sent } from "@/lib/chain/sender";
import { DEPLOYMENT, NETWORK, SIGN_IN_RECIPIENT } from "@/lib/config";
import { C, ownerActions, storage, walletCalls } from "@/lib/trade/calls";
import { RelayerError, relayer } from "./relayer";
import {
  clearPrivateKeys,
  clearSession,
  derivePrivateKeys,
  knownPasskey,
  loadPrivateKeys,
  loadSession,
  type PrivateKeys,
  pendingPasskey,
  rememberPasskey,
  savePrivateKeys,
  saveSession,
  type StoredSession,
  storedSessionMeta,
} from "./store";
import { sessionsToRetire } from "./session-room";
import { accountVersion, accountVersions } from "./version";
import { connectWallet, disconnectWallet, restoreWallet, type WalletAccount, walletSend, walletSignMessage } from "./wallet";
import { assert, type Assertion, candidateOwnerKeys, createPasskey, type PrfOutputs } from "./webauthn";

/**
 * The account layer. A Tredio account is a NEAR account of one of two kinds:
 *
 * - A passkey account: a universal account (`0u...`) the accounts factory derives from the
 *   passkey's P-256 key, running the Tredio account contract. A trading session (an ed25519 gas key
 *   made on this device, limited to `session_call`, a week long, 500 USDC a day) trades without
 *   prompts straight to NEAR; everything else is an owner request the passkey signs and the relayer
 *   sends. No seed phrase: the passkey is the account.
 * - A NEAR wallet through NEAR Connect: it signs in with a NEP-413 message and sends every trade
 *   itself. It has no sessions, so passkey-only features (Hyperliquid, Autopilot, follows, caller
 *   identity) are not available to it.
 */

export type Ceremony =
  | { flow: "sign-up"; step: "passkey" | "confirm" | "account" | "sync" | "done" }
  | { flow: "sign-in"; step: "find" | "confirm" | "gas" | "sync" | "done" }
  | { flow: "renew"; step: "confirm" | "gas" | "sync" | "done" };

export type CeremonyStep = Ceremony["step"];
/** Hears each stage of a ceremony as it starts, for the account sheet's checklist. */
export type Progress = (c: Ceremony) => void;

export interface ActiveAccount {
  kind: "passkey" | "wallet";
  /** The NEAR account id. */
  address: string;
  /** The key that signs for the app: the session key, or the wallet's key. */
  publicKey: string;
  /** When the trading session ends (passkey accounts). */
  validUntil: number | null;
  /** USDC (raw) the session may move per UTC day. */
  dailyLimit: bigint | null;
  ownerKey: string | null;
  credentialId: string | null;
  walletName: string | null;
}

/** A transaction the account sent: its hash, return value, who signed it (for finality) and its outcome when known. */
export interface TxResult<T = unknown> {
  hash: string;
  value: T | undefined;
  sender: string | null;
  outcome: Outcome | null;
}

/** The trading session ended (or this device lost it); one passkey prompt starts a new one. */
export class SessionExpiredError extends Error {}
/** A passkey answered, but no Tredio account exists for it. */
export class AccountNotFoundError extends Error {}
/** A wallet account asked for something only a passkey account can do. */
export class PasskeyOnlyError extends Error {}

/** The trading session the app asks for: a week, 500 USDC of trades a day, every market. */
export const SESSION_DAYS = 7;
export const SESSION_DAILY_LIMIT = 500_000_000n;
export const SESSION_LABEL = "app";
export const SESSION_SCOPE = { outcomes: true, perps: true, hyperliquid: true } as const;
/**
 * NEAR a new account moves into its first session's gas key (prepaid gas is bought at 1e9 yocto a
 * gas unit): enough for a v1 account's 300 Tgas calls, so it suits accounts born on either code.
 */
export const FIRST_SESSION_GAS = 320_000_000_000_000_000_000_000n;
/**
 * Below this the app asks the relayer to refill a session gas key: what one session call prepays
 * for the gas it attaches (0.001 NEAR per Tgas: 0.3 NEAR for v1's 300 Tgas, 0.15 for v2's 150)
 * and 0.01 NEAR for the gas it burns.
 */
export const gasKeyMin = (version: AccountVersion) => sessionCallPrepaid(version) + 10n ** 22n;
export const GAS_KEY_MIN = gasKeyMin(1);
const LANES = 4;

const WALLET_KEY = "tredio.wallet";

const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const rpId = () => process.env.NEXT_PUBLIC_PASSKEY_RP_ID || window.location.hostname;

/** The caller identity and vault key on this device. */
export interface PrivateIdentity {
  /** The identity's id: its ed25519 public key as 64 lowercase hex characters. */
  id: string;
  /** Signs `message` (UTF-8) with the identity key; the signature is base64. */
  sign(message: string): Promise<string>;
  vaultKey: CryptoKey;
}

function identityOf(keys: PrivateKeys): PrivateIdentity {
  const seed = keys.identitySeed;
  return {
    id: hexEncode(ed25519.getPublicKey(seed)),
    sign: async (message) => base64Encode(ed25519.sign(utf8(message), seed)),
    vaultKey: keys.vaultKey,
  };
}

export class AccountService {
  private passkey: { meta: StoredSession; secretKey: string; sender: GasKeySender } | null = null;
  private wallet: WalletAccount | null = null;
  private identity: PrivateIdentity | null = null;
  /** The session this device had when it ended, so renewing prompts for its own passkey. */
  private ended: StoredSession | null = null;
  private restoring: Promise<ActiveAccount | null> | null = null;

  get active(): ActiveAccount | null {
    if (this.passkey) {
      const m = this.passkey.meta;
      return { kind: "passkey", address: m.account, publicKey: m.publicKey, validUntil: m.expiresAt, dailyLimit: BigInt(m.dailyLimit), ownerKey: m.ownerKey, credentialId: m.credentialId, walletName: null };
    }
    if (this.wallet) {
      const stored = readWallet();
      return { kind: "wallet", address: this.wallet.accountId, publicKey: stored?.publicKey ?? "", validUntil: null, dailyLimit: null, ownerKey: null, credentialId: null, walletName: this.wallet.name };
    }
    return null;
  }

  get privateIdentity(): PrivateIdentity | null {
    return this.identity;
  }

  /** The account a session that ended belonged to (for the renew screen). */
  get endedAccount(): string | null {
    return this.ended?.account ?? null;
  }

  /** Restores what this device holds, without a prompt. Concurrent calls share one restore. */
  restore(): Promise<ActiveAccount | null> {
    this.restoring ??= this.restoreOnce().finally(() => {
      this.restoring = null;
    });
    return this.restoring;
  }

  private async restoreOnce(): Promise<ActiveAccount | null> {
    const w = readWallet();
    if (w) {
      const restored = await restoreWallet(w.account);
      if (restored) {
        this.wallet = restored;
        return this.active;
      }
      clearWallet();
    }
    const stored = await loadSession();
    if (!stored) {
      const meta = await storedSessionMeta();
      if (meta) {
        // The record is there but its key no longer opens (storage partly cleared): renew.
        this.ended = meta;
        throw new SessionExpiredError("This device lost its trading session key.");
      }
      return null;
    }
    const onChain = await this.readSession(stored.meta.account, stored.meta.publicKey);
    if (!onChain || onChain.expires_at <= nowSec()) {
      this.ended = stored.meta;
      throw new SessionExpiredError("Your trading session ended.");
    }
    this.usePasskeySession({ ...stored.meta, expiresAt: onChain.expires_at, dailyLimit: onChain.daily_limit }, stored.secretKey);
    const keys = await loadPrivateKeys(stored.meta.account);
    if (keys) this.identity = identityOf(keys);
    return this.active;
  }

  private usePasskeySession(meta: StoredSession, secretKey: string) {
    this.passkey = { meta, secretKey, sender: new GasKeySender(meta.account, secretKey, LANES) };
    this.wallet = null;
    this.ended = null;
  }

  /** The account's session for `publicKey` as its contract reports it, or null. */
  async readSession(account: string, publicKey: string): Promise<Session | null> {
    return view<Session | null>(account, "session", { public_key: publicKey });
  }

  /** The account a passkey owner key derives to (the factory's view). */
  private accountOf(ownerKey: string): Promise<string> {
    return view<string>(DEPLOYMENT.contracts.accounts, "account_id_of", { owner_key: ownerKey });
  }

  // --- Passkey ceremonies ----------------------------------------------------------------------

  /**
   * Creates a passkey and its account: one prompt makes the passkey, a second approves the account's
   * first request (its trading session), and the relayer creates the account with it.
   */
  async signUp(progress: Progress): Promise<ActiveAccount> {
    progress({ flow: "sign-up", step: "passkey" });
    const created = await createPasskey({ id: rpId(), name: "Tredio" }, `Tredio ${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`);
    rememberPasskey(created.credentialId, created.ownerKey, true);
    return this.activate(created.ownerKey, created.credentialId, created.prf, progress);
  }

  /** The account's first request (a session), signed and sent to the relayer, which creates the account. */
  private async activate(ownerKey: string, credentialId: string, prf: PrfOutputs, progress: Progress): Promise<ActiveAccount> {
    const account = await this.accountOf(ownerKey);
    // Asked while the passkey signs, so it adds no wait.
    const ticketing = activation.ticket(ownerKey);
    ticketing.catch(() => undefined);
    const key = newKeyPair();
    const expiresAt = nowSec() + SESSION_DAYS * 86_400;
    // Once v2 account code is published, the first request also moves the account onto it: still
    // one prompt, and the account never trades on v1. Until then deployments names no v2 code.
    const upgrade = upgradeToV2(DEPLOYMENT);
    const first = ownerActions.addSession({ publicKey: key.publicKey, label: SESSION_LABEL, scope: SESSION_SCOPE, expiresAt, dailyLimit: SESSION_DAILY_LIMIT, gasFunding: FIRST_SESSION_GAS });
    const request = requestJson(ownerRequest(account, NETWORK, upgrade ? [first, upgrade] : [first]));
    progress({ flow: "sign-up", step: "confirm" });
    const a = await assert(rpId(), await requestChallenge(request), credentialId);
    progress({ flow: "sign-up", step: "account" });
    const ticket = await ticketing;
    try {
      await relayer.createAccount({ ownerKey, request, proof: a.proof, ticket });
    } catch (e) {
      if (e instanceof RelayerError && e.status === 409) {
        rememberPasskey(credentialId, ownerKey, false);
        throw new Error("This passkey already has a Tredio account. Sign in with it instead.");
      }
      if (!(await this.sessionLanded(e, account, key.publicKey, expiresAt))) {
        if (e instanceof RelayerError && e.status >= 500) throw new Error("Tredio's relayer did not confirm the new account. Your passkey is saved: choose \u201cI already have a passkey\u201d to finish setting it up.");
        throw e;
      }
    }
    rememberPasskey(credentialId, ownerKey, false);
    const meta: StoredSession = { kind: "passkey", account, ownerKey, credentialId, publicKey: key.publicKey, expiresAt, dailyLimit: SESSION_DAILY_LIMIT.toString() };
    await saveSession(meta, key.secretKey, prf.session ?? a.prf.session);
    this.usePasskeySession(meta, key.secretKey);
    await this.capturePrivate(account, prf.private ?? a.prf.private);
    clearWallet();
    return this.active!;
  }

  /**
   * Signs in with a passkey on a device that has no session: the first prompt finds the account
   * (WebAuthn reveals a key only at creation, so the account is found from the signature), the
   * second starts a trading session on it.
   */
  async signIn(progress: Progress): Promise<ActiveAccount> {
    progress({ flow: "sign-in", step: "find" });
    const first = await assert(rpId(), randomBytes(32));
    const found = await this.findAccount(first);
    if (!found) {
      // A passkey made here whose account was never created: finish creating it.
      const pending = pendingPasskey();
      const mine = knownPasskey(first.credentialId);
      const ownerKey = mine?.pending ? mine.ownerKey : pending && candidateOwnerKeys(first).includes(pending.ownerKey) ? pending.ownerKey : null;
      if (ownerKey) return this.activate(ownerKey, first.credentialId, first.prf, progress);
      throw new AccountNotFoundError("This passkey has no Tredio account yet. Create one instead.");
    }
    await this.capturePrivate(found.account, first.prf.private);
    return this.startSession(found.account, found.ownerKey, first.credentialId, first.prf.session, "sign-in", progress);
  }

  /** One prompt: a new week-long session for the account this device had, or a full sign-in without one. */
  async renewSession(progress: Progress): Promise<ActiveAccount> {
    const meta = this.passkey?.meta ?? this.ended ?? (await storedSessionMeta());
    if (!meta) return this.signIn(progress);
    return this.startSession(meta.account, meta.ownerKey, meta.credentialId, null, "renew", progress, meta);
  }

  /** This device's session key for `meta`, when the stored copy still opens; null otherwise. */
  private async storedKey(meta: StoredSession): Promise<{ publicKey: string; secretKey: string } | null> {
    const p = this.passkey;
    if (p && p.meta.account === meta.account && p.meta.publicKey === meta.publicKey) return { publicKey: meta.publicKey, secretKey: p.secretKey };
    const stored = await loadSession();
    if (!stored || stored.meta.account !== meta.account || stored.meta.publicKey !== meta.publicKey) return null;
    try {
      return publicKeyOf(stored.secretKey) === meta.publicKey ? { publicKey: meta.publicKey, secretKey: stored.secretKey } : null;
    } catch {
      return null;
    }
  }

  /** The Tredio account a passkey assertion belongs to, if one exists. */
  private async findAccount(a: Assertion): Promise<{ account: string; ownerKey: string } | null> {
    const known = knownPasskey(a.credentialId);
    const candidates = known ? [known.ownerKey] : candidateOwnerKeys(a);
    for (const ownerKey of candidates) {
      const account = await this.accountOf(ownerKey);
      if (!(await accountState(account))) continue;
      const onChain = await view<string>(account, "owner_key").catch(() => null);
      if (onChain === ownerKey) {
        rememberPasskey(a.credentialId, ownerKey, false);
        return { account, ownerKey };
      }
    }
    return null;
  }

  /** The account's keys to retire so one more session fits (session-room.ts), read on chain; none when the read fails. */
  private async sessionsToRetire(account: string, version: AccountVersion, keep: string): Promise<string[]> {
    try {
      const [sessions, dormant] = await Promise.all([
        view<Array<[string, { expires_at: number }]>>(account, "sessions"),
        keepsGasKeys(version) ? view<string[]>(account, "dormant_keys") : Promise.resolve([] as string[]),
      ]);
      return sessionsToRetire(sessions.map(([publicKey, s]) => ({ publicKey, expiresAt: s.expires_at })), dormant, nowSec(), keep);
    } catch {
      return [];
    }
  }

  /**
   * Adds a session to the account (one prompt) and asks the relayer to fill its gas. Signing in
   * makes a new key: the account keeps any earlier sessions, so other devices stay signed in.
   * Renewing on v2 account code renews this device's own key in place (`renewing`), so its gas key
   * keeps the gas it holds; v1 cannot add a key it already has, so there renewal takes a new key.
   */
  private async startSession(
    account: string,
    ownerKey: string,
    credentialId: string,
    prfSession: Uint8Array | null,
    flow: "sign-in" | "renew",
    progress: Progress,
    renewing: StoredSession | null = null,
  ): Promise<ActiveAccount> {
    progress({ flow, step: "confirm" });
    const version = await accountVersion(account);
    const key = (renewing && keepsGasKeys(version) ? await this.storedKey(renewing) : null) ?? newKeyPair();
    const expiresAt = nowSec() + SESSION_DAYS * 86_400;
    // At the session limit the same prompt first retires what it must (deleting keys on v2, so the slots really free up).
    const retire = await this.sessionsToRetire(account, version, key.publicKey);
    const request = requestJson(
      ownerRequest(account, NETWORK, [
        ...retire.map((k) => ownerActions.revokeSession(k, keepsGasKeys(version))),
        ownerActions.addSession({ publicKey: key.publicKey, label: SESSION_LABEL, scope: SESSION_SCOPE, expiresAt, dailyLimit: SESSION_DAILY_LIMIT, gasFunding: 0n }),
      ]),
    );
    const a = await assert(rpId(), await requestChallenge(request), credentialId);
    try {
      await relayer.ownerExecute({ account, request, proof: a.proof });
    } catch (e) {
      if (!(await this.sessionLanded(e, account, key.publicKey, expiresAt))) throw e;
    }
    progress({ flow, step: "gas" });
    await this.fundGas(account, key.publicKey, true, version);
    const meta: StoredSession = { kind: "passkey", account, ownerKey, credentialId, publicKey: key.publicKey, expiresAt, dailyLimit: SESSION_DAILY_LIMIT.toString() };
    await saveSession(meta, key.secretKey, prfSession ?? a.prf.session);
    this.usePasskeySession(meta, key.secretKey);
    if (!this.identity) await this.capturePrivate(account, a.prf.private);
    clearWallet();
    return this.active!;
  }

  /**
   * After the relayer answered with an error that is not a refusal (it went down, or lost track of
   * a transaction it had sent while waiting on its RPC), whether the session landed on the account
   * anyway: then the sign-up or sign-in carries on instead of stranding a created account. The
   * expiry tells this request's session from the one a renewal replaces.
   */
  private async sessionLanded(e: unknown, account: string, publicKey: string, expiresAt: number): Promise<boolean> {
    if (e instanceof RelayerError && e.status < 500) return false;
    for (let i = 0; i < 10; i++) {
      if ((await this.readSession(account, publicKey).catch(() => null))?.expires_at === expiresAt) return true;
      await sleep(2_000);
    }
    return false;
  }

  /**
   * Makes sure a session gas key can pay for a transaction on an account of `version`, asking the
   * relayer to refill it when it runs low. Right after a key is added the relayer may not see it
   * for a block or two, so a fresh key is retried briefly.
   */
  private async fundGas(account: string, publicKey: string, fresh: boolean, version: AccountVersion): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const key = await accessKey(account, publicKey).catch(() => null);
      if (key?.gasKey && key.gasKey.balance >= gasKeyMin(version)) return;
      try {
        await relayer.fundSession({ account, publicKey });
        return;
      } catch (e) {
        const early = e instanceof RelayerError && (e.status === 409 || e.status === 403 || e.status === 503);
        if (!fresh || !early || attempt >= 6) {
          if (e instanceof RelayerError && e.status === 429) throw new TxFailed(`The session's gas needs a refill, and the relayer refused for now: ${e.message}`);
          throw e;
        }
        await sleep(1_500);
      }
    }
  }

  /** One prompt: rebuilds the caller identity and vault key on this device. */
  async unlockPrivate(): Promise<PrivateIdentity> {
    const a = this.active;
    if (!a) throw new Error("Sign in first.");
    if (a.kind === "wallet") throw new PasskeyOnlyError("Caller identities come from a passkey. Sign in with a passkey account to make calls.");
    const r = await assert(rpId(), randomBytes(32), a.credentialId);
    await this.capturePrivate(a.address, r.prf.private);
    if (!this.identity) throw new Error("This passkey provider does not support the passkey extension Tredio needs for private keys (PRF). iCloud Keychain, Google Password Manager and 1Password do.");
    return this.identity;
  }

  private async capturePrivate(account: string, prf: Uint8Array | null) {
    if (!prf) return;
    const keys = await derivePrivateKeys(prf);
    prf.fill(0);
    await savePrivateKeys(account, keys).catch(() => undefined);
    this.identity = identityOf(keys);
  }

  // --- Acting for the account --------------------------------------------------------------------

  /** Prompt-free: a typed session action within the session's scope and daily limit (wallets: one wallet prompt). */
  async trade<T = unknown>(action: SessionAction): Promise<TxResult<T>> {
    if (this.wallet) return this.walletTrade<T>(action);
    const p = this.passkey;
    if (!p) throw new SessionExpiredError("Sign in to trade.");
    if (p.meta.expiresAt <= nowSec()) {
      this.ended = p.meta;
      this.passkey = null;
      throw new SessionExpiredError("Your trading session ended.");
    }
    const version = await accountVersion(p.meta.account);
    await this.fundGas(p.meta.account, p.meta.publicKey, false, version);
    const sent: Sent<T> = await p.sender.send<T>(C.account.sessionCall(p.meta.account, action, sessionCallTgas(version)));
    return { hash: sent.hash, value: sent.value, sender: p.meta.account, outcome: sent.outcome };
  }

  /** A wallet does a session action itself; it registers storage with a contract first when it needs to. */
  private async walletTrade<T>(action: SessionAction): Promise<TxResult<T>> {
    const w = this.wallet!;
    const calls = walletCalls(action);
    const needs: Array<{ contract: string; call: Call }> = [];
    const receives = typeof action === "object" ? Object.keys(action)[0] : action;
    if (receives === "swap" || receives === "mint_sets") needs.push({ contract: DEPLOYMENT.contracts.outcomes, call: storage.outcomes(w.accountId) });
    if (receives === "perp_open") needs.push({ contract: DEPLOYMENT.contracts.perps, call: storage.perps(w.accountId) });
    if (receives !== "faucet") needs.push({ contract: DEPLOYMENT.contracts.usdc, call: storage.usdc(w.accountId) });
    const missing = await Promise.all(needs.map(async (n) => ((await view<unknown>(n.contract, "storage_balance_of", { account_id: w.accountId }).catch(() => null)) ? null : n.call)));
    return { ...(await walletSend<T>(w, [...missing.filter((x): x is Call => x !== null), ...calls])), sender: w.accountId };
  }

  /**
   * One passkey prompt: an owner request for the account, sent by the relayer. Wallets send the
   * `call` and `transfer` parts themselves; session changes are passkey-only.
   */
  async ownerExecute(actions: OwnerAction[]): Promise<TxResult> {
    if (this.wallet) return { ...(await walletSend(this.wallet, actions.map(walletCallOf))), sender: this.wallet.accountId };
    const a = this.active;
    if (!a || a.kind !== "passkey" || !a.credentialId) throw new Error("Sign in first.");
    const request = requestJson(ownerRequest(a.address, NETWORK, actions));
    const r = await assert(rpId(), await requestChallenge(request), a.credentialId);
    let sent: { hash: string; value: unknown; outcome?: Outcome };
    try {
      sent = await relayer.ownerExecute({ account: a.address, request, proof: r.proof });
    } catch (e) {
      // The relayer reports a failed transaction as "the transaction failed: <the contract's reason>",
      // and an RPC error after it broadcast the same way, though the transaction may have run.
      if (e instanceof RelayerError && /^the transaction failed: /.test(e.message)) {
        const reason = e.message.replace(/^the transaction failed: /, "");
        if (/HTTP 5\d\d|Internal Server Error|timed? ?out|fetch failed/i.test(reason)) throw new TxFailed("The relayer lost track of this transaction, so it may have gone through. Check your balances before trying again.");
        throw new TxFailed(reason);
      }
      throw e;
    }
    // An upgrade changes the account's code version: read it again next time.
    if (actions.some((x) => "upgrade" in x)) accountVersions.forget(a.address);
    // The receipts' logs say what the calls did (an order's id, or a refusal that returned the funds).
    // The relayer sends them with its answer; an older relayer does not, so then the app follows the transaction.
    const by = await relayer.account();
    const outcome = sent.outcome ?? (by ? await follow(sent.hash, by, Date.now() + 20_000).catch(() => null) : null);
    const refused = outcome ? refusalOf(outcome) : null;
    if (refused) throw new TxFailed(refused, sent.hash);
    return { hash: sent.hash, value: sent.value, sender: by, outcome };
  }

  /** Adds a session for someone else's key (Autopilot's grant), with one prompt, and fills its gas. */
  async addSession(session: { publicKey: string; label: string; scope: { outcomes: boolean; perps: boolean; hyperliquid: boolean }; expiresAt: number; dailyLimit: bigint }): Promise<TxResult> {
    const a = this.active;
    if (!a || a.kind !== "passkey") throw new PasskeyOnlyError("Autopilot trades through a passkey account's own session.");
    const r = await this.ownerExecute([ownerActions.addSession({ ...session, gasFunding: 0n })]);
    await this.fundGas(a.address, session.publicKey, true, await accountVersion(a.address));
    return r;
  }

  /** One prompt: approves a backend request a session alone may not make (a follow, enabling a rule, a link). */
  async approve(request: OwnerApprovalRequest): Promise<OwnerApproval> {
    const a = this.active;
    if (!a) throw new SessionExpiredError("Sign in first.");
    if (a.kind !== "passkey" || !a.credentialId) throw new PasskeyOnlyError("This needs a passkey account's approval, which a NEAR wallet cannot give.");
    const challenge = await ownerApprovals.challenge(request.action);
    if (challenge.network !== NETWORK) throw new Error(`Tredio's server runs on ${challenge.network}, but this app is on ${NETWORK}.`);
    const digest = await ownerApprovalDigest({ network: NETWORK, account: a.address, request, nonce: challenge.nonce, expiresAt: challenge.expiresAt });
    const r = await assert(rpId(), digest, a.credentialId);
    return { nonce: challenge.nonce, ...r.proof };
  }

  /** Signs Tredio's sign-in message: with the session key (no prompt), or the wallet (one prompt). */
  async signForApi(message: (signer: string) => string): Promise<{ signer: string; signature: string; nonce: string }> {
    if (this.passkey) {
      const signer = this.passkey.meta.publicKey;
      const s = signNep413(this.passkey.secretKey, message(signer), SIGN_IN_RECIPIENT);
      return { signer, signature: s.signature, nonce: s.nonce };
    }
    if (this.wallet) {
      const stored = readWallet();
      // The message names the signing key, which only the wallet's answer reveals: sign, then check it matches.
      const guess = stored?.publicKey ?? "";
      const first = await walletSignMessage(this.wallet, message(guess));
      if (first.signer === guess) return first;
      writeWallet({ account: this.wallet.accountId, publicKey: first.signer, name: this.wallet.name });
      return walletSignMessage(this.wallet, message(first.signer));
    }
    throw new SessionExpiredError("Sign in first.");
  }

  // --- NEAR wallets ------------------------------------------------------------------------------

  /** Connects a NEAR wallet (NEAR Connect's picker) and makes it the app's account. */
  async connectWallet(): Promise<ActiveAccount> {
    const w = await connectWallet();
    const accounts = await w.wallet.getAccounts({ network: NETWORK }).catch(() => []);
    const publicKey = accounts.find((x) => x.accountId === w.accountId)?.publicKey ?? "";
    this.wallet = w;
    this.passkey = null;
    this.identity = null;
    writeWallet({ account: w.accountId, publicKey, name: w.name });
    return this.active!;
  }

  /** Ends the in-memory session; the encrypted copy stays on this device. */
  lock() {
    this.passkey = null;
    this.identity = null;
  }

  /** Signs out on this device: forgets the session, the private keys and any connected wallet. */
  async logout() {
    const w = this.wallet;
    this.lock();
    this.wallet = null;
    this.ended = null;
    clearWallet();
    if (w) await disconnectWallet(w.wallet);
    await clearSession();
    await clearPrivateKeys();
  }
}

/** A wallet does an owner request's calls and transfers itself. */
function walletCallOf(action: OwnerAction): Call {
  if ("call" in action) {
    const c = action.call;
    return { receiverId: c.receiver_id, methodName: c.method_name, args: JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(c.args), (x) => x.charCodeAt(0)))) as Record<string, unknown>, deposit: c.deposit, gas: c.gas };
  }
  throw new PasskeyOnlyError("Sessions, freezing and transfers from the account are passkey actions.");
}

interface StoredWallet {
  account: string;
  publicKey: string;
  name: string;
}

function readWallet(): StoredWallet | null {
  try {
    return JSON.parse(localStorage.getItem(WALLET_KEY) ?? "null") as StoredWallet | null;
  } catch {
    return null;
  }
}

function writeWallet(w: StoredWallet) {
  try {
    localStorage.setItem(WALLET_KEY, JSON.stringify(w));
  } catch {
    // Storage blocked: the wallet connects again on the next visit.
  }
}

function clearWallet() {
  try {
    localStorage.removeItem(WALLET_KEY);
  } catch {
    // Nothing stored.
  }
}
