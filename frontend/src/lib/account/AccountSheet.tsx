"use client";
import { Check, Copy, Fingerprint, KeyRound, Loader2, LogOut, RefreshCw, Settings, ShieldCheck, Timer, Wallet } from "lucide-react";
import { useState } from "react";
import { Badge, Button, ButtonLink, cn, DrawnCheck, ErrorNote, ExplorerLink, Sheet } from "@/components/ui";
import { explorerAddress } from "@/lib/config";
import { shortAddress, usdc } from "@/lib/format";
import { useCopy } from "@/lib/hooks/useCopy";
import { WaitlistEntry } from "@/features/waitlist/WaitlistEntry";
import { useAccount } from "./AccountProvider";
import type { Ceremony } from "./service";

function formatUntil(seconds: number) {
  return new Date(seconds * 1000).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

type Step = { step: Ceremony["step"]; title: string; note: string };

const STEPS: Record<Ceremony["flow"], Step[]> = {
  "sign-up": [
    { step: "passkey", title: "Create your passkey", note: "Confirm with Face ID, Touch ID or your device's PIN." },
    { step: "confirm", title: "Approve your account", note: "Your passkey signs the account's first request: a week-long trading session." },
    { step: "account", title: "Open your account on NEAR", note: "Tredio pays the gas and the storage." },
    { step: "sync", title: "Sync with Tredio", note: "So Autopilot, follows and alerts know your account." },
  ],
  "sign-in": [
    { step: "find", title: "Find your account", note: "Your passkey's signature names the account it owns." },
    { step: "confirm", title: "Start a trading session", note: "One more passkey confirmation: a week of trades without prompts." },
    { step: "gas", title: "Fill the session's gas", note: "Tredio's relayer pays for the session's transactions." },
    { step: "sync", title: "Sync with Tredio", note: "So Autopilot, follows and alerts know your account." },
  ],
  renew: [
    { step: "confirm", title: "Start a new session", note: "One passkey confirmation: another week of trades without prompts." },
    { step: "gas", title: "Fill the session's gas", note: "Tredio's relayer pays for the session's transactions." },
    { step: "sync", title: "Sync with Tredio", note: "Signing in again with the session key." },
  ],
};

/** A ceremony as it happens: each real stage checks off as it completes. */
function Checklist({ ceremony }: { ceremony: Ceremony }) {
  const steps = STEPS[ceremony.flow];
  const at = ceremony.step === "done" ? steps.length : steps.findIndex((s) => s.step === ceremony.step);
  return (
    <ol className="flex flex-col gap-1 rounded-2xl border border-line bg-surface-2 p-2" aria-label="Progress" data-testid="signup-steps" data-step={ceremony.step} data-flow={ceremony.flow}>
      {steps.map((s, i) => {
        const state = i < at ? "done" : i === at ? "active" : "waiting";
        return (
          <li key={s.step} className="flex items-start gap-3 rounded-xl px-2.5 py-2.5" aria-current={state === "active" ? "step" : undefined}>
            <span
              className={cn(
                "mt-px flex size-6 shrink-0 items-center justify-center rounded-full transition-colors duration-300",
                state === "done" ? "bg-up-soft text-up" : state === "active" ? "bg-primary-soft text-primary" : "border border-line text-text-3",
              )}
            >
              {state === "done" ? <DrawnCheck className="size-3.5" /> : state === "active" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <span className="num text-[11px]">{i + 1}</span>}
            </span>
            <span className="min-w-0">
              <span className={cn("block font-strong text-[14px] leading-6 transition-colors duration-300", state === "waiting" ? "text-text-3" : "text-text")}>{s.title}</span>
              <span className={cn("block text-[12.5px] leading-[18px] transition-colors duration-300", state === "waiting" ? "text-text-3" : "text-text-2")}>{s.note}</span>
            </span>
            <span className="sr-only">{state === "done" ? "done" : state === "active" ? "in progress" : "waiting"}</span>
          </li>
        );
      })}
    </ol>
  );
}

const TITLES: Record<Ceremony["flow"], [string, string]> = {
  "sign-up": ["Creating your account", "You are in"],
  "sign-in": ["Signing in", "You are in"],
  renew: ["Renewing your session", "Session renewed"],
};

/** Create, sign in, connect a wallet, renew, and inspect the account. */
export default function AccountSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const account = useAccount();
  const { status, session, error, ceremony } = account;
  const working = status === "working";
  const active = status === "active" && session && !ceremony;
  const wallet = active && session.kind === "wallet";

  const title = ceremony
    ? TITLES[ceremony.flow][ceremony.step === "done" ? 1 : 0]
    : active
      ? wallet
        ? "Your NEAR wallet"
        : "Your Tredio account"
      : status === "session-expired"
        ? "Renew your session"
        : "Trade attention with a passkey";
  const description = ceremony
    ? "Your passkey confirms, Tredio does the rest. No gas, no seed phrase."
    : active
      ? wallet
        ? `${session.walletName ?? "Your wallet"} signs and pays for each trade itself.`
        : "A NEAR account owned by your passkey."
      : status === "session-expired"
        ? "One passkey prompt starts a new week of trading without prompts."
        : "No seed phrase, no extension, no gas. Your passkey is the account.";

  return (
    <Sheet open={open} onOpenChange={onOpenChange} busy={working} testId="account-sheet" title={title} description={description}>
      <div className="flex flex-col gap-5">
        {ceremony ? <Checklist ceremony={ceremony} /> : active ? <ActiveView onClose={() => onOpenChange(false)} /> : status === "session-expired" ? <Expired /> : <SignedOut />}
        {error ? <ErrorNote message={error} className="[&_p]:text-[13px]" /> : null}
        {error ? (
          <span data-testid="account-error" className="sr-only">
            {error}
          </span>
        ) : null}
      </div>
    </Sheet>
  );
}

function AddressPill({ address }: { address: string }) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      onClick={() => void copy(address, "Account copied")}
      data-testid="account-address"
      data-address={address}
      className="num flex max-w-full items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 font-mono text-[13px] text-text-2 transition-colors hover:text-text"
    >
      <span className="truncate">{shortAddress(address)}</span>
      {copied ? <Check className="size-3.5 shrink-0 text-up" aria-hidden /> : <Copy className="size-3.5 shrink-0" aria-hidden />}
      <span className="sr-only">Copy account id</span>
    </button>
  );
}

function ActiveView({ onClose }: { onClose: () => void }) {
  const { session, backendReady, privateIdentity, logout, syncBackend } = useAccount();
  if (!session) return null;
  const wallet = session.kind === "wallet";
  return (
    <>
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-surface-2 px-4 py-5 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-primary-soft text-primary">{wallet ? <Wallet className="size-6" aria-hidden /> : <ShieldCheck className="size-6" aria-hidden />}</div>
        <AddressPill address={session.address} />
        <div className="flex flex-wrap justify-center gap-1.5">
          <Badge tone="up">{wallet ? "Wallet signs" : "Gas-free"}</Badge>
          <Badge tone={backendReady ? "primary" : "neutral"}>{backendReady ? "Synced" : wallet ? "Not synced" : "Connecting"}</Badge>
          {wallet ? null : <Badge tone={privateIdentity ? "primary" : "neutral"}>{privateIdentity ? "Private keys on this device" : "Private keys locked"}</Badge>}
        </div>
      </div>
      {wallet ? (
        <>
          {!backendReady ? (
            <div className="flex flex-col gap-3 rounded-2xl border border-line p-4">
              <p className="text-[13.5px] leading-5 text-text-2">Sign Tredio&rsquo;s sign-in message with your wallet so alerts, proposals and your history know this account. It moves nothing.</p>
              <Button tone="secondary" icon={<RefreshCw className="size-4" aria-hidden />} onClick={() => void syncBackend()}>
                Sign in to Tredio
              </Button>
            </div>
          ) : null}
          <div className="flex items-start gap-3 rounded-2xl border border-line p-4">
            <KeyRound className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
            <p className="text-[13.5px] leading-5 text-text-2">
              Your wallet confirms every trade. Hyperliquid perps, Autopilot, copy trading and calls need a passkey account, whose guarded session and Chain Signatures key a wallet does not have.
            </p>
          </div>
        </>
      ) : session.validUntil ? (
        <div className="flex items-start gap-3 rounded-2xl border border-line p-4">
          <Timer className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
          <p className="text-[13.5px] leading-5 text-text-2">
            Trading works without prompts until <span className="text-text">{formatUntil(session.validUntil)}</span>, opening up to {usdc(Number(session.dailyLimit ?? 0n) / 1e6)} USDC of trades a day. Withdrawals, limit orders, coin trades, follows, enabling rules and identity links always ask for your passkey.
          </p>
        </div>
      ) : null}
      <WaitlistEntry account={session.address} onOpen={onClose} />
      <div className="flex flex-col gap-2">
        <ButtonLink href="/settings" tone="secondary" block onClick={onClose}>
          <Settings className="size-4" aria-hidden />
          Settings
        </ButtonLink>
        <ExplorerLink href={explorerAddress(session.address)} className="justify-center self-center py-1 text-[13px] text-text-2" testId="account-explorer" />
        <Button tone="secondary" block icon={<LogOut className="size-4" aria-hidden />} onClick={() => void logout()}>
          {wallet ? "Disconnect on this device" : "Sign out on this device"}
        </Button>
      </div>
    </>
  );
}

function Expired() {
  const { renewSession, signIn, endedAccount, status } = useAccount();
  return (
    <>
      <p className="text-[14px] leading-6 text-text-2">
        The trading session on this device ended{endedAccount ? (
          <>
            {" "}
            for <span className="num font-mono text-[13px] text-text">{shortAddress(endedAccount)}</span>
          </>
        ) : null}
        . One passkey prompt starts a new one; your funds and positions are where you left them.
      </p>
      <Button size="lg" block loading={status === "working"} icon={<Fingerprint className="size-[18px]" aria-hidden />} onClick={() => void renewSession()} data-testid="renew-session">
        Renew with passkey
      </Button>
      <Button tone="ghost" block disabled={status === "working"} onClick={() => void signIn()}>
        Use another passkey
      </Button>
    </>
  );
}

function SignedOut() {
  const { status, signUp, signIn, connectWallet } = useAccount();
  const working = status === "working";
  // The spinner sits on the way in that was chosen; the others wait, disabled.
  const [chosen, setChosen] = useState<"create" | "passkey" | "wallet">("create");
  return (
    <>
      <ul className="flex flex-col gap-3 text-[13.5px] leading-5 text-text-2">
        <li className="flex gap-3">
          <Fingerprint className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
          Two passkey confirmations create your NEAR account and a week-long trading session.
        </li>
        <li className="flex gap-3">
          <KeyRound className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
          Clear this browser or switch devices: your passkey finds your account again.
        </li>
        <li className="flex gap-3">
          <ShieldCheck className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
          Tredio pays the gas. Nothing moves your funds without your passkey or a capped session.
        </li>
      </ul>
      <div className="flex flex-col gap-2">
        <Button
          size="lg"
          block
          loading={working && chosen === "create"}
          disabled={working && chosen !== "create"}
          data-testid="create-account"
          icon={<Fingerprint className="size-[18px]" aria-hidden />}
          onClick={() => {
            setChosen("create");
            void signUp();
          }}
        >
          Create account
        </Button>
        <Button
          size="lg"
          tone="secondary"
          block
          loading={working && chosen === "passkey"}
          disabled={working && chosen !== "passkey"}
          data-testid="sign-in"
          onClick={() => {
            setChosen("passkey");
            void signIn();
          }}
        >
          I already have a passkey
        </Button>
      </div>
      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <Button
          tone="ghost"
          block
          loading={working && chosen === "wallet"}
          disabled={working && chosen !== "wallet"}
          icon={<Wallet className="size-4" aria-hidden />}
          onClick={() => {
            setChosen("wallet");
            void connectWallet();
          }}
          data-testid="connect-wallet"
        >
          Connect a NEAR wallet
        </Button>
        <p className="text-center text-[12px] leading-4 text-text-3">Meteor, Intear and other NEAR wallets. Your wallet signs and pays for each trade.</p>
      </div>
    </>
  );
}
