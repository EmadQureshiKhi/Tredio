"use client";
import { Check, Fingerprint, KeyRound, X } from "lucide-react";
import { useState } from "react";
import { Button, ErrorNote, Segmented, Sheet, TxStatus } from "@/components/ui";
import { useAccount } from "@/lib/account/AccountProvider";
import { useTx } from "@/lib/trade/useTx";
import { type GrantView, useGrant } from "../shared/data";
import { DAILY_CAPS, useGrantActions, VALID_DAYS } from "./grant";

type Cap = `${(typeof DAILY_CAPS)[number]}`;
type Days = `${(typeof VALID_DAYS)[number]}`;

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
  const submit = async () => {
    const ok = await actions.grant(tx, Number(cap), Number(days));
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
            <Button block size="lg" loading={busy} data-testid="grant-approve" icon={<Fingerprint className="size-[18px]" aria-hidden />} onClick={() => void submit()}>
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
              Hyperliquid orders only, for {days} {days === "1" ? "day" : "days"}. Revoke it any time from Autopilot.
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
            <div className="flex gap-3 rounded-2xl border border-line p-4">
              <KeyRound className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
              <p className="text-[12.5px] leading-5 text-text-2">
                Your device makes a separate key for Autopilot and seals it so only the Autopilot executor can open it: Tredio&rsquo;s servers never see it. Your passkey never leaves your device.
                {renewing ? " Renewing adds a fresh key; the current one keeps trading until the new one is on chain." : ""}
              </p>
            </div>
          </>
        )}
      </div>
    </Sheet>
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
