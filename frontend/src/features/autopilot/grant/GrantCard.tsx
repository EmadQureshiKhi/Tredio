"use client";
import { keepsGasKeys } from "@tredio/contracts";
import { Cpu, Fingerprint, ShieldCheck, ShieldOff, Snowflake } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Card, ErrorNote, ExplorerLink, Row, Skeleton, TxStatus, cn } from "@/components/ui";
import { useAccount } from "@/lib/account/AccountProvider";
import { useAccountVersion } from "@/lib/account/version";
import type { GrantWallet } from "@/lib/api";
import { explorerAddress } from "@/lib/config";
import { countdown, shortAddress, usdc } from "@/lib/format";
import { useTx } from "@/lib/trade/useTx";
import { Meter, useConfirm } from "../shared/kit";
import { useFollows, useGrant, useRules } from "../shared/data";
import { useGrantActions, WALLET_GAS_NEAR } from "./grant";
import { GrantSheet, grantLabel, Scope } from "./GrantSheet";

/** Below this the wallet cannot pay for a session call: OutLayer sends one only while the wallet holds the 0.15 NEAR of gas it attaches. */
const WALLET_GAS_LOW = 0.16;

const day = (sec: number) => new Date(sec * 1000).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

/**
 * Autopilot's access to the account at a glance: what it may move today, when it ends, and the
 * controls to renew or revoke it. `compact` is the one-line version for the Copy screen.
 */
export function GrantCard({ compact, className }: { compact?: boolean; className?: string }) {
  const account = useAccount();
  const grant = useGrant();
  const rules = useRules();
  const follows = useFollows();
  const actions = useGrantActions();
  const tx = useTx();
  const confirm = useConfirm(6000);
  const [sheet, setSheet] = useState(false);
  const g = grant.data;
  const keepsKeys = keepsGasKeys(useAccountVersion(account.kind === "passkey" ? account.address : null).data ?? 1);

  if (account.kind === "wallet") {
    return (
      <Card className={cn("p-5", className)} data-testid="grant-card" data-state="wallet">
        <div className="flex gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-text-2">
            <ShieldOff className="size-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="font-strong text-[15px] leading-6 text-text">Autopilot access</h2>
            <p className="mt-0.5 text-[13px] leading-5 text-text-2">Autopilot and copies trade Hyperliquid through a passkey account&rsquo;s guarded session. A NEAR wallet has none; sign in with a passkey to use them.</p>
          </div>
        </div>
      </Card>
    );
  }

  if (grant.isLoading || !g) {
    return (
      <Card className={cn("p-5", className)}>
        {grant.error ? (
          <ErrorNote message="Autopilot access could not be checked." onRetry={() => void grant.refetch()} />
        ) : (
          <div className="flex flex-col gap-3" aria-busy>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-full max-w-sm" />
            {compact ? null : <Skeleton className="h-9 w-32" />}
          </div>
        )}
      </Card>
    );
  }

  const running = (rules.data?.rules ?? []).filter((r) => r.status === "enabled").length;
  const copying = (follows.data?.follows ?? []).filter((f) => f.status === "active").length;
  const active = g.state === "active";
  const tone = active ? "up" : g.state === "none" ? "neutral" : "warn";
  const revoke = async () => {
    if (!g.sessionKey || !confirm.confirm("revoke")) return;
    await actions.revoke(tx, g.sessionKey);
  };

  return (
    <Card className={cn("p-5", className)} data-testid="grant-card" data-state={g.state}>
      <div className={cn("flex gap-4", compact ? "flex-col sm:flex-row sm:items-center" : "flex-col")}>
        <div className="flex min-w-0 flex-1 gap-3">
          <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", active ? "bg-up-soft text-up" : "bg-surface-2 text-text-2")}>
            {active ? <ShieldCheck className="size-5" aria-hidden /> : <ShieldOff className="size-5" aria-hidden />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-strong text-[15px] leading-6 text-text">Autopilot access</h2>
              <Badge tone={tone}>{grantLabel(g)}</Badge>
            </div>
            <p className="mt-0.5 text-[13px] leading-5 text-text-2">
              {active
                ? `Hyperliquid orders only, within 2% of the oracle's mark and up to 10x. Ends ${day(g.validUntil)}, in ${countdown(g.validUntil)}.`
                : g.state === "none"
                  ? "Rules and copies trade through a Hyperliquid-only session your account contract guards. One passkey prompt grants it."
                  : g.state === "revoked"
                    ? "You revoked Autopilot's session. Rules and copies cannot trade until you grant access again."
                    : "Autopilot's session has ended. Rules and copies cannot trade until you renew it."}
            </p>
          </div>
        </div>
        {active && !compact ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
              <span className="text-text-2">Used today</span>
              <span className="num font-strong text-text">
                {usdc(g.spentToday)} <span className="font-sans text-text-3">of {usdc(g.dailyLimit)} USDC</span>
              </span>
            </div>
            <Meter value={g.spentToday} max={g.dailyLimit} label="USDC used today" tone={g.spentToday >= g.dailyLimit * 0.9 ? "warn" : "primary"} />
          </div>
        ) : null}
        {active && g.wallet && !compact ? (
          <WalletPanel
            wallet={g.wallet}
            busy={actions.working || tx.busy}
            onFreeze={(frozen) => void actions.setFrozen(tx, g.wallet!, frozen)}
            onFund={() => void actions.fundWallet(tx, g.wallet!)}
          />
        ) : null}
        {g.state === "none" && !compact ? (
          <div className="rounded-2xl border border-line p-4">
            <Scope compact />
          </div>
        ) : null}
        <div className={cn("flex flex-wrap gap-2", compact ? "sm:shrink-0" : "")}>
          {active ? (
            <>
              <Button
                tone="secondary"
                size="sm"
                onClick={() => setSheet(true)}
                disabled={actions.working || tx.busy}
                data-testid="grant-renew"
              >
                Renew
              </Button>
              <Button tone={confirm.armed === "revoke" ? "danger" : "ghost"} size="sm" loading={actions.working || tx.busy} onClick={() => void revoke()} onBlur={confirm.disarm} data-testid="grant-revoke">
                {confirm.armed === "revoke" ? "Confirm with passkey" : "Revoke"}
              </Button>
            </>
          ) : (
            <Button size={compact ? "sm" : "md"} icon={<Fingerprint className="size-4" aria-hidden />} onClick={() => setSheet(true)} data-testid="grant-open">
              {g.state === "none" ? "Grant access" : "Grant again"}
            </Button>
          )}
        </div>
      </div>
      {confirm.armed === "revoke" ? (
        <p className="mt-3 text-[12.5px] leading-5 text-warn" role="status">
          {g.wallet
            ? "Revoking ends Autopilot\u2019s session, so the account refuses the wallet\u2019s calls (the NEAR it holds for gas stays in it)"
            : keepsKeys
              ? "Revoking ends Autopilot\u2019s session (its key stays on your account, unable to trade)"
              : "Revoking removes the key from your account"}
          {running + copying > 0 ? ` and pauses ${[running ? `${running} running rule${running === 1 ? "" : "s"}` : "", copying ? `${copying} cop${copying === 1 ? "y" : "ies"}` : ""].filter(Boolean).join(" and ")}` : ""}. Open positions stay on Hyperliquid until you close them.
        </p>
      ) : null}
      {tx.stage !== "idle" || actions.error ? (
        <div className="mt-3 flex flex-col gap-2">
          <TxStatus tx={tx} filledLabel="Done" />
          {actions.error ? <ErrorNote message={actions.error} /> : null}
        </div>
      ) : null}
      <GrantSheet open={sheet} onOpenChange={setSheet} />
    </Card>
  );
}

/**
 * A policy wallet behind the grant: where its key signs, whether the account froze it, its gas,
 * and the account's own controls (each one passkey prompt, straight to the chain or the Agent API).
 */
function WalletPanel({ wallet, busy, onFreeze, onFund }: { wallet: GrantWallet; busy: boolean; onFreeze: (frozen: boolean) => void; onFund: () => void }) {
  const frozen = wallet.frozen === true;
  const gas = wallet.balance === null ? null : Number(BigInt(wallet.balance) / 10n ** 18n) / 1e6;
  const low = gas !== null && gas < WALLET_GAS_LOW;
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-line p-4" data-testid="grant-wallet" data-frozen={frozen}>
      <div className="flex flex-wrap items-center gap-2">
        {frozen ? <Snowflake className="size-4 text-warn" aria-hidden /> : <Cpu className="size-4 text-primary" aria-hidden />}
        <p className="font-strong text-[13.5px] text-text">{wallet.kind === "agent-api" ? "Signed by an Agent API agent in OutLayer\u2019s TEE" : "Signed in OutLayer\u2019s TEE"}</p>
        <Badge tone={frozen ? "warn" : wallet.frozen === null ? "neutral" : "up"}>{frozen ? "Frozen" : wallet.frozen === null ? "Checking" : "Signing"}</Badge>
      </div>
      <p className="text-[12.5px] leading-5 text-text-2">
        {frozen
          ? "You froze the wallet, so its enclave signs nothing and rules and copies wait. Unfreeze it to let Autopilot trade again."
          : "The wallet signs only Autopilot\u2019s session calls to your account, with no NEAR attached. Freezing it stops every signature at once, whatever Tredio\u2019s servers do."}
      </p>
      <div className="flex flex-col gap-1.5">
        <Row
          label="Wallet"
          value={
            <ExplorerLink href={explorerAddress(wallet.account)} className="text-text">
              <span className="num">{shortAddress(wallet.account)}</span>
            </ExplorerLink>
          }
        />
        <Row label="Gas" value={gas === null ? "-" : `${gas.toFixed(3)} NEAR`} tone={low ? "warn" : undefined} />
        {low ? <p className="text-[12px] leading-4 text-warn">Below what a call needs: Autopilot waits until the wallet has gas again.</p> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button tone={frozen ? "primary" : "secondary"} size="sm" loading={busy} disabled={wallet.frozen === null} onClick={() => onFreeze(!frozen)} data-testid={frozen ? "grant-wallet-unfreeze" : "grant-wallet-freeze"}>
          {frozen ? "Unfreeze" : "Freeze"}
        </Button>
        <Button tone="ghost" size="sm" disabled={busy} onClick={onFund} data-testid="grant-wallet-fund">
          Add {WALLET_GAS_NEAR} NEAR of gas
        </Button>
      </div>
    </div>
  );
}
