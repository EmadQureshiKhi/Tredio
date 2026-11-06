"use client";
import type { OwnerAction, SessionAction } from "@tredio/contracts";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type Approve, auth, setReauth, setUserToken } from "@/lib/api";
import { explorerAddress } from "@/lib/config";
import { disablePush } from "@/lib/push";
import { notify } from "@/lib/toast";
import AccountSheet from "./AccountSheet";
import { describeError } from "./errors";
import { setAccountHint } from "./hint";
import { type ActiveAccount, AccountService, type Ceremony, type PrivateIdentity, SessionExpiredError, type TxResult } from "./service";

export { describeError, describeReason } from "./errors";
export type { ActiveAccount, Ceremony, PrivateIdentity, TxResult } from "./service";

/** Mirrors backend/src/api/user-auth.ts signInMessage. */
export const signInMessage = (account: string, signer: string, issuedAt: number) => `Tredio sign-in\naccount: ${account}\nkey: ${signer}\nissued: ${issuedAt}`;

export type AccountStatus = "loading" | "signed-out" | "working" | "session-expired" | "active";

/** The account the app trades with: a passkey account with a trading session, or a NEAR wallet. */
export interface Account {
  /** True once the account layer has restored whatever this device holds. */
  ready: boolean;
  /** True while an account can trade (an active session, or a connected wallet). */
  authenticated: boolean;
  status: AccountStatus;
  kind: "passkey" | "wallet" | null;
  /** The NEAR account id. */
  address: string | undefined;
  session: ActiveAccount | null;
  /** With status session-expired: the account whose session ended on this device. */
  endedAccount: string | null;
  /** True once Tredio's API accepted this account's sign-in (needed for Autopilot, follows, alerts). */
  backendReady: boolean;
  /** The caller identity and vault key, when this device holds them. */
  privateIdentity: PrivateIdentity | null;
  /** The ceremony running now (sign-up, sign-in, renewal) and its stage, for the account sheet. */
  ceremony: Ceremony | null;
  /** Opens the account sheet (create, sign in, connect a wallet, or inspect the account). */
  login(): void;
  signUp(): Promise<void>;
  signIn(): Promise<void>;
  connectWallet(): Promise<void>;
  renewSession(): Promise<void>;
  /** Signs in to Tredio's API again (a wallet prompt for wallets, none for sessions). */
  syncBackend(): Promise<void>;
  /** One passkey prompt: rebuilds the private-data keys on this device. */
  unlockPrivate(): Promise<PrivateIdentity>;
  /** Prompt-free for sessions (one wallet prompt for wallets): a typed trade within the session's limits. */
  trade<T = unknown>(action: SessionAction): Promise<TxResult<T>>;
  /** One passkey prompt: an owner request (limit orders, coin trades, withdrawals, session changes). */
  ownerExecute(actions: OwnerAction[]): Promise<TxResult>;
  /** One passkey prompt: adds Autopilot's session and fills its gas. */
  addSession: AccountService["addSession"];
  /** One passkey prompt: approves a backend action a session alone may not take. */
  approve: Approve;
  logout(): Promise<void>;
  error: string | null;
}

const AccountContext = createContext<Account | null>(null);

/** How long a finished ceremony's checklist stays before the sheet shows the account. */
const DONE_HOLD_MS = 900;
const TOKEN_KEY = "tredio.api-token";

interface StoredToken {
  account: string;
  signer: string;
  token: string;
  expiresAt: number;
}

/** Session keys sign in again without a prompt, so their token lives with the tab; a wallet's lives a day on the device. */
const tokenStore = (kind: ActiveAccount["kind"]): Storage | null => {
  try {
    return kind === "wallet" ? localStorage : sessionStorage;
  } catch {
    return null;
  }
};

function storedToken(a: ActiveAccount): string | null {
  try {
    const raw = tokenStore(a.kind)?.getItem(TOKEN_KEY);
    const t = raw ? (JSON.parse(raw) as StoredToken) : null;
    return t && t.account === a.address && (a.kind === "wallet" || t.signer === a.publicKey) && t.expiresAt > Date.now() / 1000 + 60 ? t.token : null;
  } catch {
    return null;
  }
}

function forgetTokens() {
  for (const s of [() => sessionStorage, () => localStorage]) {
    try {
      s().removeItem(TOKEN_KEY);
    } catch {
      // Nothing stored.
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function AccountProvider({ children }: { children: React.ReactNode }) {
  const service = useRef<AccountService | null>(null);
  const [status, setStatus] = useState<AccountStatus>("loading");
  const [session, setSession] = useState<ActiveAccount | null>(null);
  const [endedAccount, setEndedAccount] = useState<string | null>(null);
  const [privateIdentity, setPrivateIdentity] = useState<PrivateIdentity | null>(null);
  const [backendReady, setBackendReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [ceremony, setCeremony] = useState<Ceremony | null>(null);
  const tokenRef = useRef<string | null>(null);

  const get = useCallback(() => {
    service.current ??= new AccountService();
    return service.current;
  }, []);

  /**
   * Signs in to the API: with the session key (no prompt, retried briefly while a just-added key
   * reaches the API's view of the chain), or with the wallet (one prompt, only when asked).
   */
  const connectBackend = useCallback(
    async (active: ActiveAccount, opts: { fresh?: boolean; prompt?: boolean } = {}): Promise<string | null> => {
      const reuse = opts.fresh ? null : storedToken(active);
      if (!reuse && active.kind === "wallet" && !opts.prompt) {
        setBackendReady(false);
        return null;
      }
      let token = reuse;
      for (let attempt = 0; !token; attempt++) {
        try {
          const issuedAt = Math.floor(Date.now() / 1000);
          const signed = await get().signForApi((signer) => signInMessage(active.address, signer, issuedAt));
          const res = await auth.session({ account: active.address, signer: signed.signer, issuedAt, signature: signed.signature, nonce: signed.nonce });
          token = res.token;
          try {
            tokenStore(active.kind)?.setItem(TOKEN_KEY, JSON.stringify({ account: active.address, signer: signed.signer, token: res.token, expiresAt: res.expiresAt } satisfies StoredToken));
          } catch {
            // Private mode: the token lives in memory only.
          }
        } catch (e) {
          const settling = e instanceof ApiError && (e.status === 401 || e.status === 503) && active.kind === "passkey";
          if (!settling || attempt >= 5) throw e;
          await sleep(1_500);
        }
      }
      tokenRef.current = token;
      setUserToken(token);
      setBackendReady(true);
      return token;
    },
    [get],
  );

  const expire = useCallback(() => {
    setEndedAccount(get().endedAccount);
    setSession(null);
    setBackendReady(false);
    setUserToken(null);
    setReauth(null);
    setStatus("session-expired");
  }, [get]);

  /** Makes `active` the app's account; resolves once the API sign-in settled (either way). */
  const activate = useCallback(
    (active: ActiveAccount | null): Promise<void> => {
      setSession(active);
      setPrivateIdentity(get().privateIdentity);
      setEndedAccount(null);
      setStatus(active ? "active" : "signed-out");
      // A signed-in call the API refuses (the key was revoked or replaced, the token expired) signs in once more.
      setReauth(active ? () => connectBackend(active, { fresh: true, prompt: active.kind === "passkey" }) : null);
      return active ? connectBackend(active).then(() => undefined, () => setBackendReady(false)) : Promise.resolve();
    },
    [get, connectBackend],
  );

  useEffect(() => {
    let cancelled = false;
    get()
      .restore()
      .then((active) => {
        if (!cancelled) void activate(active);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof SessionExpiredError) expire();
        else setStatus("signed-out");
      });
    return () => {
      cancelled = true;
    };
  }, [get, activate, expire]);

  // The next visit paints the shell this one settled on: signed in (or ended), or signed out.
  useEffect(() => {
    if (status === "active" || status === "session-expired") setAccountHint(true);
    else if (status === "signed-out") setAccountHint(false);
  }, [status]);

  /** Runs a ceremony with its checklist; the last stage is the API sign-in. */
  const run = useCallback(
    async (fn: (progress: (c: Ceremony) => void) => Promise<ActiveAccount>, done: { title: string; description: string }) => {
      setError(null);
      setStatus("working");
      let flow: Ceremony["flow"] | null = null;
      try {
        const active = await fn((c) => {
          flow = c.flow;
          setCeremony(c);
        });
        if (flow) setCeremony({ flow, step: "sync" } as Ceremony);
        await activate(active);
        notify.success(done.title, done.description, explorerAddress(active.address));
        if (flow) {
          setCeremony({ flow, step: "done" } as Ceremony);
          await sleep(DONE_HOLD_MS);
        }
      } catch (e) {
        setError(describeError(e));
        const ended = get().endedAccount;
        setStatus(ended ? "session-expired" : "signed-out");
        setEndedAccount(ended);
      } finally {
        setCeremony(null);
      }
    },
    [activate, get],
  );

  const signUp = useCallback(() => run((p) => get().signUp(p), { title: "Account created", description: "Your passkey is the account. Trading works without prompts for a week." }), [get, run]);
  const signIn = useCallback(() => run((p) => get().signIn(p), { title: "Signed in", description: "Trading works without prompts for a week." }), [get, run]);
  const renewSession = useCallback(() => run((p) => get().renewSession(p), { title: "Session renewed", description: "Trading works without prompts for another week." }), [get, run]);

  const connectWallet = useCallback(async () => {
    setError(null);
    setStatus("working");
    try {
      const active = await get().connectWallet();
      setSession(active);
      setPrivateIdentity(null);
      setStatus("active");
      setReauth(() => connectBackend(active, { fresh: true, prompt: true }));
      // The wallet signs Tredio's sign-in message right away (one prompt).
      await connectBackend(active, { prompt: true }).catch((e: unknown) => {
        setBackendReady(false);
        setError(`Connected, but Tredio's sign-in did not go through: ${describeError(e)}`);
      });
      notify.success("Wallet connected", `${active.walletName ?? "Your wallet"} signs each trade itself.`, explorerAddress(active.address));
    } catch (e) {
      const m = describeError(e);
      // Closing NEAR Connect's picker is not an error.
      if (!/rejected|closed|cancel/i.test(m)) setError(m);
      setStatus(get().active ? "active" : "signed-out");
    }
  }, [get, connectBackend]);

  const syncBackend = useCallback(async () => {
    const active = get().active;
    if (!active) return;
    setError(null);
    try {
      await connectBackend(active, { fresh: true, prompt: true });
    } catch (e) {
      setError(describeError(e));
    }
  }, [get, connectBackend]);

  const login = useCallback(() => {
    setError(null);
    setSheetOpen(true);
  }, []);

  const unlockPrivate = useCallback(async () => {
    const p = await get().unlockPrivate();
    setPrivateIdentity(p);
    return p;
  }, [get]);

  const logout = useCallback(async () => {
    setReauth(null);
    // Free this browser's push endpoint first, so the next account signed in here can use it.
    await disablePush().catch(() => {});
    const token = tokenRef.current;
    if (token) await auth.revoke(token).catch(() => {});
    forgetTokens();
    tokenRef.current = null;
    setUserToken(null);
    setBackendReady(false);
    await get().logout();
    setSession(null);
    setEndedAccount(null);
    setPrivateIdentity(null);
    setStatus("signed-out");
    notify.success("Signed out", "Your passkey or wallet signs you back in on any device.");
  }, [get]);

  const trade = useCallback(
    async <T,>(action: SessionAction) => {
      try {
        return await get().trade<T>(action);
      } catch (e) {
        if (e instanceof SessionExpiredError) expire();
        throw e;
      }
    },
    [get, expire],
  ) as Account["trade"];
  const ownerExecute = useCallback((actions: OwnerAction[]) => get().ownerExecute(actions), [get]);
  const addSession = useCallback<Account["addSession"]>((s) => get().addSession(s), [get]);
  const approve = useCallback<Approve>((request) => get().approve(request), [get]);

  const value = useMemo<Account>(
    () => ({
      ready: status !== "loading",
      authenticated: status === "active" && session !== null,
      status,
      kind: session?.kind ?? null,
      address: session?.address,
      session,
      endedAccount,
      backendReady,
      privateIdentity,
      ceremony,
      login,
      signUp,
      signIn,
      connectWallet,
      renewSession,
      syncBackend,
      unlockPrivate,
      trade,
      ownerExecute,
      addSession,
      approve,
      logout,
      error,
    }),
    [status, session, endedAccount, backendReady, privateIdentity, ceremony, login, signUp, signIn, connectWallet, renewSession, syncBackend, unlockPrivate, trade, ownerExecute, addSession, approve, logout, error],
  );

  return (
    <AccountContext.Provider value={value}>
      {children}
      <AccountSheet open={sheetOpen} onOpenChange={setSheetOpen} />
    </AccountContext.Provider>
  );
}

export function useAccount(): Account {
  const account = useContext(AccountContext);
  if (!account) throw new Error("useAccount must be used inside AccountProvider");
  return account;
}
