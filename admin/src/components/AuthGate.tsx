"use client";
import { LoaderCircle, PenLine, ShieldCheck, Wallet } from "lucide-react";
import { signIn, useSession, type SignInProblem } from "@/src/lib/auth/session";
import { ADMIN_ACCOUNT_HINT, BACKEND_URL, NEAR_NETWORK } from "@/src/lib/config";
import { shortAddress } from "@/src/lib/format";
import { connectWallet, disconnectWallet, useWallet } from "@/src/lib/wallet/near";
import { StatusDot } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Notice } from "./ui/Notice";

const PROBLEM_TITLES: Record<SignInProblem["kind"], string> = {
  "not-admin": "This account is not an admin",
  rejected: "Signature declined",
  clock: "Clock out of sync",
  network: "Backend unreachable",
  other: "Sign-in failed",
};

function ProblemNotice({ problem }: { problem: SignInProblem }) {
  return (
    <Notice tone="bad" title={PROBLEM_TITLES[problem.kind]}>
      {problem.kind === "not-admin" ? (
        <>
          <p>The backend answered &ldquo;{problem.message}&rdquo; for</p>
          <p className="my-1.5 break-all font-mono text-xs text-fg">{problem.account}</p>
          <p>Switch to an allowlisted account in your wallet, or ask an operator to add this account to the backend&rsquo;s ADMIN_ACCOUNTS. The key that signs must be one of the account&rsquo;s full-access keys.</p>
        </>
      ) : (
        problem.message
      )}
    </Notice>
  );
}

function SignIn() {
  const wallet = useWallet();
  const { signingIn, problem, notice } = useSession();
  const address = wallet.accountId;
  const offHint = address !== null && ADMIN_ACCOUNT_HINT.length > 0 && !ADMIN_ACCOUNT_HINT.includes(address);
  // A refusal is about one account; once the wallet switches it no longer applies.
  const shownProblem = problem && !(problem.kind === "not-admin" && (!address || problem.account !== address)) ? problem : null;

  let walletStep: React.ReactNode;
  if (!wallet.ready) {
    walletStep = <div className="h-9 animate-pulse rounded-lg bg-raised" aria-hidden />;
  } else if (!address) {
    walletStep = (
      <Button variant="primary" className="w-full" icon={<Wallet size={16} aria-hidden />} loading={wallet.connecting} onClick={() => void connectWallet()}>
        Connect wallet
      </Button>
    );
  } else {
    walletStep = (
      <>
        <div className="flex h-12 items-center gap-3 rounded-lg border border-line bg-raised px-3">
          <StatusDot tone="ok" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium uppercase tracking-wide text-subtle">Connected account, {NEAR_NETWORK}</p>
            <p className="truncate font-mono text-[13px] text-fg" title={address} data-testid="connected-address">
              {shortAddress(address)}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void disconnectWallet()} disabled={signingIn}>
            Disconnect
          </Button>
        </div>
        <Button variant="primary" className="w-full" icon={<PenLine size={16} aria-hidden />} loading={signingIn} onClick={() => void signIn(address)}>
          Sign in with this wallet
        </Button>
      </>
    );
  }

  return (
    <section aria-labelledby="sign-in-title" className="mx-auto mt-4 w-full max-w-md sm:mt-12">
      <div className="rounded-2xl border border-line bg-surface p-6 shadow-card sm:p-8">
        <div className="flex size-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <ShieldCheck size={20} aria-hidden />
        </div>
        <h1 id="sign-in-title" className="mt-5 text-xl font-semibold tracking-tight text-fg">
          Sign in to Tredio admin
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted">
          Connect a NEAR wallet (HOT, Meteor, Intear and others) and sign one message. The backend checks the signature against the account&rsquo;s full-access keys and its admin list, then opens a 12 hour session. Nothing is sent on chain.
        </p>

        <div className="mt-6 space-y-3">
          {notice && <Notice tone="info">{notice}</Notice>}
          {walletStep}
          {offHint && (
            <Notice tone="warn" title="Not on this panel's admin list">
              {shortAddress(address)} is not in NEXT_PUBLIC_ADMIN_ACCOUNTS. The backend has the final say, so you can still try.
            </Notice>
          )}
          {wallet.error && <Notice tone="bad">{wallet.error}</Notice>}
          {shownProblem && <ProblemNotice problem={shownProblem} />}
        </div>
      </div>
      <p className="mt-4 text-center text-xs text-subtle">
        Backend <span className="font-mono">{BACKEND_URL}</span>
      </p>
    </section>
  );
}

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const { ready, session } = useSession();

  if (!ready) {
    return (
      <div className="flex justify-center pt-24" aria-label="Loading">
        <LoaderCircle size={20} className="animate-spin text-subtle" aria-hidden />
      </div>
    );
  }
  return session ? <>{children}</> : <SignIn />;
}
