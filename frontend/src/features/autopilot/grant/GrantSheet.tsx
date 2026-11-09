"use client";
import { acceptsWalletSessions, latestAccountCode } from "@tredio/contracts";
import { DEFAULT_CALLS_PER_HOUR } from "@tredio/custody";
import { Check, Cpu, Fingerprint, KeyRound, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button, ErrorNote, Segmented, Sheet, TxStatus } from "@/components/ui";
import { useAccount } from "@/lib/account/AccountProvider";
import { useAccountVersion } from "@/lib/account/version";
import { DEPLOYMENT, NETWORK } from "@/lib/config";
import { useTx } from "@/lib/trade/useTx";
import { type GrantView, useGrant } from "../shared/data";
import { DAILY_CAPS, useGrantActions, VALID_DAYS, WALLET_GAS_NEAR } from "./grant";

type Cap = `${(typeof DAILY_CAPS)[number]}`;
type Days = `${(typeof VALID_DAYS)[number]}`;
type Signer = "key" | "wallet";

/** Where Autopilot's policy wallet lives: OutLayer custody on testnet, a NEAR Intents Agent API agent (OutLayer custody too) on mainnet. */
const WALLET_HOST = NETWORK === "mainnet" ? "an Agent API agent in OutLayer's TEE" : "OutLayer's TEE";

/** The account contract's guard on every session order to Hyperliquid. */
export const SESSION_MAX_LEVERAGE = 10;

/**
 * Grants Autopilot a Hyperliquid-only session with one passkey prompt, after saying plainly what it
 * can and can never do. `onGranted` continues whatever needed the access (enabling a rule,
 * following a leader).
 */
export function GrantSheet({ open, onOpenChange, onGranted, reason }: { open: boolean; onOpenChange: (o: boolean) => void; onGranted?: () => void; reason?: string }) {
  const account = useAccount();
  const grant = useGrant();
  const actions = useGrantActions();
  const tx = useTx();
  const [cap, setCap] = useState<Cap>(() => {
    const now = String(Math.round(grant.data?.dailyLimit ?? 0));
    return grant.data?.state === "active" && (DAILY_CAPS as readonly number[]).includes(Number(now)) ? (now as Cap) : "500";
  });
  const [days, setDays] = useState<Days>("7");
  const [done, setDone] = useState(false);
  const renewing = grant.data?.state === "active";
  // Renewing keeps how Autopilot signs: a policy wallet's session is renewed in place for the same wallet.
  const current = grant.data?.wallet ?? null;
  const [signer, setSigner] = useState<Signer>("key");
  const signs: Signer = renewing ? (current ? "wallet" : "key") : signer;
  const version = useAccountVersion(account.kind === "passkey" ? account.address : null).data;
  const walletReady = acceptsWalletSessions(version ?? 1);

  const change = (o: boolean) => {
    onOpenChange(o);
    if (!o)
      setTimeout(() => {
        setDone(false);
        tx.reset();
        actions.clearError();
      }, 250);
  };

  const busy = actions.working || tx.busy;
  const blocked = signs === "wallet" && !renewing && !walletReady;
  const submit = async () => {
    const ok =
      renewing && current
        ? await actions.renewWallet(tx, current, Number(cap), Number(days))
        : signs === "wallet"
          ? await actions.grantWallet(tx, Number(cap), Number(days))
          : await actions.grant(tx, Number(cap), Number(days));
    if (!ok) return;
    setDone(true);
    onGranted?.();
  };

  const wallet = account.kind === "wallet";
  return (
    <Sheet
      open={open}
      onOpenChange={change}
      busy={busy}
      testId="grant-sheet"
      title={renewing ? "Renew Autopilot access" : "Give Autopilot access"}
      description={reason ?? "One passkey prompt lets Autopilot trade Hyperliquid perps from your account, inside limits you set here."}
      footer={
        wallet ? undefined : done ? (
          <Button block size="lg" tone="secondary" onClick={() => change(false)}>
            Done
          </Button>
        ) : (
          <div className="flex flex-col gap-3">
            <TxStatus tx={tx} filledLabel={renewing ? "Renewed" : "Granted"} />
            {actions.error ? <ErrorNote message={actions.error} /> : null}
            <Button block size="lg" loading={busy} disabled={blocked} data-testid="grant-approve" icon={<Fingerprint className="size-[18px]" aria-hidden />} onClick={() => void submit()}>
              {renewing ? "Renew with passkey" : "Approve with passkey"}
            </Button>
          </div>
        )
      }
    >
      <div className="flex flex-col gap-5">
        {wallet ? (
          <p className="rounded-2xl border border-line p-4 text-[13.5px] leading-5 text-text-2">Autopilot trades through a session on a passkey account, which its account contract guards before NEAR&rsquo;s MPC network signs each Hyperliquid order. A NEAR wallet has neither, so use a passkey account for Autopilot and copy trading.</p>
        ) : done ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-surface-2 px-4 py-6 text-center" data-testid="grant-done">
            <span className="flex size-11 items-center justify-center rounded-full bg-up-soft text-up">
              <Check className="size-5" aria-hidden />
            </span>
            <p className="font-strong text-[15px] text-text">Autopilot can trade for you</p>
            <p className="max-w-xs text-[13px] leading-5 text-text-2">
              Hyperliquid orders only, for {days} {days === "1" ? "day" : "days"}.
              {signs === "wallet" ? ` Each one is signed in ${WALLET_HOST}, inside your policy. Freeze the wallet or revoke access any time from Autopilot.` : " Revoke it any time from Autopilot."}
            </p>
          </div>
        ) : (
          <>
            <Scope />
            <div className="flex flex-col gap-2">
              <p className="font-strong text-[12.5px] text-text-2">Daily cap</p>
              <Segmented label="Daily cap in USDC" value={cap} onChange={setCap} options={DAILY_CAPS.map((c) => ({ value: `${c}` as Cap, label: c.toLocaleString("en-US") }))} />
              <p className="text-[12px] leading-4 text-text-3">USDC the session may move out of your NEAR account per UTC day. Hyperliquid orders draw on your Hyperliquid balance.</p>
            </div>
            <div className="flex flex-col gap-2">
              <p className="font-strong text-[12.5px] text-text-2">Ends after</p>
              <Segmented label="Access lasts" value={days} onChange={setDays} options={VALID_DAYS.map((d) => ({ value: `${d}` as Days, label: `${d} ${d === 1 ? "day" : "days"}` }))} />
            </div>
            {renewing ? null : (
              <div className="flex flex-col gap-2">
                <p className="font-strong text-[12.5px] text-text-2">Who signs Autopilot&rsquo;s orders</p>
                <Segmented
                  label="Who signs Autopilot's orders"
                  value={signer}
                  onChange={setSigner}
                  options={[
                    { value: "key" as Signer, label: "Sealed key" },
                    { value: "wallet" as Signer, label: "Policy wallet" },
                  ]}
                />
              </div>
            )}
            {signs === "wallet" ? <WalletTerms ready={renewing || walletReady} renewing={renewing} /> : (
              <div className="flex gap-3 rounded-2xl border border-line p-4">
                <KeyRound className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
                <p className="text-[12.5px] leading-5 text-text-2">
                  Your device makes a separate key for Autopilot and seals it so only the Autopilot executor can open it: Tredio&rsquo;s servers never see it. Your passkey never leaves your device.
                  {renewing ? " Renewing adds a fresh key; the current one keeps trading until the new one is on chain." : ""}
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}

/**
 * What a policy wallet adds, and what it does not check. Its enclave is a second limit beside the
 * session: the account stores its policy and alone can freeze it.
 */
function WalletTerms({ ready, renewing }: { ready: boolean; renewing: boolean }) {
  // Deployments names code that takes the wallet's calls, so the passkey can move the account onto it.
  const upgradable = acceptsWalletSessions(latestAccountCode(DEPLOYMENT)?.version ?? 1);
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-line p-4" data-testid="grant-wallet-terms">
      <div className="flex gap-3">
        <Cpu className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
        <div className="flex flex-col gap-2 text-[12.5px] leading-5 text-text-2">
          <p>
            Autopilot&rsquo;s key lives in {WALLET_HOST} and signs only inside a policy your account stores and alone controls: calls to your own account, with no NEAR attached, at most {DEFAULT_CALLS_PER_HOUR} an hour, and nothing while you have frozen it.
            Your account contract still checks every order against this session.
          </p>
          <p>The TEE does not read what a call asks your account to do; the session does: Hyperliquid orders only, within 2% of the mark, up to 10x.</p>
          {renewing ? (
            <p>Renewing extends the session for the same wallet; its policy stays as it is.</p>
          ) : (
            <p>
              One passkey prompt stores the policy and moves {WALLET_GAS_NEAR} NEAR from your account to the wallet for gas{NETWORK === "mainnet" ? ", after two prompts that create the agent and let the executor use it" : ", plus about 0.01 NEAR for the policy's storage"}.
            </p>
          )}
        </div>
      </div>
      {ready ? null : (
        <p className="rounded-xl bg-warn-soft px-3 py-2 text-[12.5px] leading-5 text-warn" role="status" data-testid="grant-wallet-unavailable">
          {upgradable ? (
            <>
              Your account runs code that takes session calls only from its own keys, so it would refuse the wallet&rsquo;s. Upgrade it to version 3 in{" "}
              <Link href="/settings" className="font-strong underline underline-offset-2">
                Settings
              </Link>{" "}
              (one passkey prompt), or use a sealed key.
            </>
          ) : (
            <>Your account&rsquo;s code takes session calls only from its own keys, so it would refuse the wallet&rsquo;s. This opens once your account runs code that accepts them; until then, use a sealed key.</>
          )}
        </p>
      )}
    </div>
  );
}

/** What the grant allows and what it never allows. */
export function Scope({ compact }: { compact?: boolean }) {
  return (
    <div className="@container">
      <div className={compact ? "grid gap-4 @lg:grid-cols-2" : "flex flex-col gap-4"}>
        <div className="flex flex-col gap-2">
          <p className="font-strong text-[12.5px] text-text-2">Autopilot can</p>
          <ul className="flex flex-col gap-2 text-[13.5px] leading-5 text-text">
            <Item ok>Open and close Hyperliquid perps from your account&rsquo;s Hyperliquid address, at up to {SESSION_MAX_LEVERAGE}x</Item>
            <Item ok>Only at prices within 2% of Tredio&rsquo;s oracle mark, checked by your account contract</Item>
          </ul>
        </div>
        <div className="flex flex-col gap-2">
          <p className="font-strong text-[12.5px] text-text-2">Autopilot can never</p>
          <ul className="flex flex-col gap-2 text-[13.5px] leading-5 text-text">
            <Item>Withdraw, transfer or send USDC anywhere</Item>
            <Item>Touch your Up/Down tokens, attention perps or coins</Item>
            <Item>Act after the access ends or once you revoke it</Item>
          </ul>
        </div>
      </div>
    </div>
  );
}

function Item({ ok, children }: { ok?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className={`mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full ${ok ? "bg-up-soft text-up" : "bg-down-soft text-down"}`}>
        {ok ? <Check className="size-3" strokeWidth={3} aria-hidden /> : <X className="size-3" strokeWidth={3} aria-hidden />}
      </span>
      <span>{children}</span>
    </li>
  );
}

export const grantLabel = (g: GrantView | undefined) => (g?.state === "active" ? "Active" : g?.state === "expired" ? "Expired" : g?.state === "revoked" ? "Revoked" : "Not granted");
