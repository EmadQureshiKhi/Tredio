"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { keepsGasKeys, latestAccountCode, type OwnerAction, type Session, upgradeToLatest } from "@tredio/contracts";
import { Check, Copy, Fingerprint, LogOut, Snowflake } from "lucide-react";
import { useState } from "react";
import { Avatar } from "@/components/shell/AppShell";
import { Badge, Button, ErrorNote, ExplorerLink, Field, Skeleton, Switch, TxStatus } from "@/components/ui";
import { describeError, useAccount } from "@/lib/account/AccountProvider";
import { useAccountVersion } from "@/lib/account/version";
import { accountState, view } from "@/lib/chain/client";
import { DEPLOYMENT, explorerAddress, USDC_DECIMALS } from "@/lib/config";
import { countdown, shortAddress, tokenAmount, usdc } from "@/lib/format";
import { useUsdcBalance } from "@/lib/hooks/queries";
import { useCopy } from "@/lib/hooks/useCopy";
import { owner, ownerActions, ownerCall, storage } from "@/lib/trade/calls";
import { parseAmount } from "@/lib/trade/math";
import { isRegistered } from "@/lib/trade/reads";
import { useTx } from "@/lib/trade/useTx";
import { useNow } from "@/features/portfolio/parts";
import { Section, SettingRow } from "./Section";

const when = (sec: number) => new Date(sec * 1000).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const nearText = (yocto: bigint) => (Number(yocto / 10n ** 18n) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 4 });

/** The account: its id, its trading sessions on chain (with revoke and freeze), withdrawals, and this device. */
export function AccountSection() {
  const account = useAccount();
  const s = account.session;
  return (
    <Section
      id="account"
      title="Account"
      description={s?.kind === "wallet" ? "Your NEAR wallet. It signs and pays for each trade itself." : "A NEAR account owned by your passkey. No seed phrase; your passkey finds it again on any device."}
    >
      {!account.ready ? (
        <Skeleton className="h-28 rounded-2xl" />
      ) : !account.authenticated || !s ? (
        <div className="flex flex-col gap-3">
          <p className="text-[13.5px] text-text-2">{account.status === "session-expired" ? "Your trading session ended. One passkey prompt starts a new week." : "You are signed out."}</p>
          <Button className="self-start" icon={<Fingerprint className="size-4" aria-hidden />} onClick={account.login}>
            {account.status === "session-expired" ? "Renew session" : "Sign in"}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col">
          <AddressRow address={s.address} />
          {s.kind === "passkey" ? (
            <>
              <CodeRow />
              <SessionRow />
              <Sessions />
              <RevokedKeys />
              <FreezeRow />
              <Withdraw />
              <SettingRow label="Private keys" hint="Caller identity and notes key, derived from your passkey and kept wrapped on this device.">
                {account.privateIdentity ? <Badge tone="primary">On this device</Badge> : <UnlockButton />}
              </SettingRow>
            </>
          ) : (
            <SettingRow label="Wallet" hint="Trades go out from the wallet, which confirms and pays for each one. Passkey-only features (Hyperliquid, Autopilot, copies, calls, notes) need a passkey account.">
              <Badge>{s.walletName ?? "NEAR wallet"}</Badge>
            </SettingRow>
          )}
          {account.error ? <ErrorNote message={account.error} className="mt-1" /> : null}
          <SettingRow label="This device" hint={s.kind === "wallet" ? "Disconnecting forgets the wallet on this device." : "Signing out deletes the session and keys stored here. Your account, rules and notes stay; your passkey brings them back."}>
            <Button size="sm" tone="ghost" icon={<LogOut className="size-4" aria-hidden />} onClick={() => void account.logout()}>
              {s.kind === "wallet" ? "Disconnect" : "Sign out"}
            </Button>
          </SettingRow>
        </div>
      )}
    </Section>
  );
}

function AddressRow({ address }: { address: string }) {
  const { copied, copy } = useCopy();
  const near = useQuery({ queryKey: ["near-balance", address], queryFn: () => accountState(address), refetchInterval: 30_000 });
  return (
    <SettingRow label="Account" hint={`Send USDC on NEAR here.${near.data ? ` It holds ${nearText(near.data.amount)} NEAR for its own storage.` : ""}`}>
      <span className="flex min-w-0 items-center gap-2">
        <Avatar address={address} size={20} />
        <button type="button" onClick={() => void copy(address, "Account copied")} className="num flex min-w-0 items-center gap-1.5 font-mono text-[13px] text-text hover:text-primary" aria-label="Copy account id" data-testid="settings-address">
          <span className="truncate">{shortAddress(address)}</span>
          {copied ? <Check className="size-3.5 shrink-0 text-up" aria-hidden /> : <Copy className="size-3.5 shrink-0 text-text-3" aria-hidden />}
        </button>
        <ExplorerLink href={explorerAddress(address)} size="icon" />
      </span>
    </SettingRow>
  );
}

/**
 * The account's code: an account runs the code it was born on, or moved to, until its passkey moves
 * it onto the newest published version (new accounts move in their first request). The code is
 * published by hash, so no one can change it afterwards, and only the passkey can switch an account to other code.
 */
function CodeRow() {
  const account = useAccount();
  const me = account.session!;
  const qc = useQueryClient();
  const tx = useTx();
  const version = useAccountVersion(me.address).data;
  const upgrade = upgradeToLatest(DEPLOYMENT);
  const latest = latestAccountCode(DEPLOYMENT)?.version ?? 1;
  if (version === undefined) return <Skeleton className="my-4 h-10 rounded-2xl" />;
  const run = async () => {
    if (!upgrade) return;
    if (await tx.run(() => account.ownerExecute([upgrade]), { action: "Upgrade account", done: `Account upgraded to version ${latest}`, pending: "Confirm with your passkey" })) {
      void qc.invalidateQueries({ queryKey: ["account-version"] });
      void qc.invalidateQueries({ queryKey: ["dormant-keys"] });
    }
  };
  if (version >= latest || !upgrade) {
    return (
      <SettingRow label="Account code" hint="The code your account runs. It is published by hash, so no one can change it, and only your passkey can move the account to other code.">
        <Badge tone={version >= 2 ? "primary" : undefined}>Version {version}</Badge>
        <TxStatus tx={tx} filledLabel="Upgraded" className="w-full" />
      </SettingRow>
    );
  }
  return (
    <SettingRow
      label="Account code"
      hint={`Version ${latest} is out. ${version < 2 ? "Renewing or revoking a session keeps the gas its key holds instead of burning it, and each trade reserves half the gas. " : ""}${latest >= 3 ? "Autopilot can also trade through a policy wallet your account controls. " : ""}One passkey prompt moves your account onto it; no one else can.`}
    >
      <Badge tone="warn">Version {version}</Badge>
      <Button size="sm" tone="secondary" icon={<Fingerprint className="size-4" aria-hidden />} loading={tx.busy} onClick={() => void run()} data-testid="upgrade-account">
        Upgrade
      </Button>
      <TxStatus tx={tx} filledLabel="Upgraded" className="w-full" />
    </SettingRow>
  );
}

function SessionRow() {
  const account = useAccount();
  const s = account.session!;
  const [busy, setBusy] = useState(false);
  return (
    <SettingRow
      label="Trading session"
      hint={`Trades without a prompt, opening up to ${usdc(Number(s.dailyLimit ?? 0n) / 1e6)} USDC of trades a day, until ${when(s.validUntil ?? 0)}. Withdrawals, limit orders, coin trades, follows, enabling rules and identity links always ask for your passkey.`}
    >
      <Badge tone="up">{countdown(s.validUntil ?? 0)} left</Badge>
      <Button
        size="sm"
        tone="secondary"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          await account.renewSession();
          setBusy(false);
        }}
      >
        Renew
      </Button>
    </SettingRow>
  );
}

/** Every session the account contract holds: this device's, other devices', Autopilot's. */
function Sessions() {
  const account = useAccount();
  const me = account.session!;
  const qc = useQueryClient();
  const tx = useTx();
  const [revoking, setRevoking] = useState<string | null>(null);
  const keepsKeys = keepsGasKeys(useAccountVersion(me.address).data ?? 1);
  const sessions = useQuery({ queryKey: ["sessions", me.address], queryFn: () => view<Array<[string, Session]>>(me.address, "sessions"), refetchInterval: 30_000 });
  const now = useNow(60_000) / 1000;
  const list = (sessions.data ?? []).filter(([key, s]) => key !== me.publicKey && s.expires_at > now);
  if (sessions.isLoading) return <Skeleton className="my-4 h-14 rounded-2xl" />;
  if (list.length === 0) return null;
  const revoke = async (key: string) => {
    setRevoking(key);
    if (await tx.run(() => account.ownerExecute([ownerActions.revokeSession(key)]), { action: "Revoke session", done: "Session revoked", pending: "Confirm with your passkey" })) {
      void qc.invalidateQueries({ queryKey: ["sessions"] });
      void qc.invalidateQueries({ queryKey: ["dormant-keys"] });
    }
    setRevoking(null);
  };
  return (
    <SettingRow
      top
      label="Other sessions"
      hint={`Keys this account trusts besides this device's: other devices you signed in on, and Autopilot. ${keepsKeys ? "Revoking one ends its session; its key stays on the account, unable to trade, so the gas it holds is not burned." : "Revoking one removes its key from the account."}`}
    >
      <ul className="flex w-full flex-col gap-2 sm:w-[320px]" data-testid="sessions">
        {list.map(([key, s]) => (
          <li key={key} className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2">
            <span className="min-w-0">
              <span className="block truncate font-strong text-[13px] text-text">{s.label === "autopilot" ? "Autopilot" : s.label === "app" ? "Another device" : s.label}</span>
              <span className="num block truncate text-[11.5px] text-text-3">
                {shortAddress(key.replace(/^ed25519:/, ""))} · ends {countdown(s.expires_at)}
              </span>
            </span>
            <Button size="sm" tone="ghost" className="-my-1 shrink-0" loading={tx.busy && revoking === key} disabled={tx.busy} onClick={() => void revoke(key)}>
              Revoke
            </Button>
          </li>
        ))}
      </ul>
      <TxStatus tx={tx} filledLabel="Revoked" className="w-full" />
    </SettingRow>
  );
}

/**
 * Account v2 keeps the gas key of a revoked session on the account, unable to act, since deleting
 * a gas key burns the gas it holds; renewing on the device that holds it brings it back. Here the
 * passkey can delete one for good.
 */
function RevokedKeys() {
  const account = useAccount();
  const me = account.session!;
  const qc = useQueryClient();
  const tx = useTx();
  const [deleting, setDeleting] = useState<string | null>(null);
  const keepsKeys = keepsGasKeys(useAccountVersion(me.address).data ?? 1);
  const keys = useQuery({ queryKey: ["dormant-keys", me.address], queryFn: () => view<string[]>(me.address, "dormant_keys"), enabled: keepsKeys, refetchInterval: 60_000 });
  const list = keys.data ?? [];
  if (!keepsKeys || list.length === 0) return null;
  const remove = async (key: string) => {
    setDeleting(key);
    if (await tx.run(() => account.ownerExecute([ownerActions.revokeSession(key, true)]), { action: "Delete key", done: "Key deleted", pending: "Confirm with your passkey" })) void qc.invalidateQueries({ queryKey: ["dormant-keys"] });
    setDeleting(null);
  };
  return (
    <SettingRow top label="Revoked keys" hint="Keys of sessions you revoked: still on the account, unable to trade, keeping the gas they hold. Renewing the session on the device that holds one brings it back. Deleting one removes it for good and burns that gas.">
      <ul className="flex w-full flex-col gap-2 sm:w-[320px]" data-testid="revoked-keys">
        {list.map((key) => (
          <li key={key} className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2">
            <span className="min-w-0">
              <span className="block truncate font-strong text-[13px] text-text">{key === me.publicKey ? "This device" : "Revoked key"}</span>
              <span className="num block truncate text-[11.5px] text-text-3">{shortAddress(key.replace(/^ed25519:/, ""))}</span>
            </span>
            <Button size="sm" tone="ghost" className="-my-1 shrink-0" loading={tx.busy && deleting === key} disabled={tx.busy} onClick={() => void remove(key)}>
              Delete
            </Button>
          </li>
        ))}
      </ul>
      <TxStatus tx={tx} filledLabel="Deleted" className="w-full" />
    </SettingRow>
  );
}

/** Freezing stops every session from trading until the passkey unfreezes them. */
function FreezeRow() {
  const account = useAccount();
  const qc = useQueryClient();
  const tx = useTx();
  const frozen = useQuery({ queryKey: ["frozen", account.address], queryFn: () => view<boolean>(account.address!, "frozen"), enabled: Boolean(account.address), refetchInterval: 30_000 });
  const set = async (on: boolean) => {
    if (await tx.run(() => account.ownerExecute([ownerActions.freeze(on)]), { action: on ? "Freeze sessions" : "Unfreeze sessions", done: on ? "Sessions frozen" : "Sessions unfrozen", pending: "Confirm with your passkey" })) void qc.invalidateQueries({ queryKey: ["frozen"] });
  };
  return (
    <SettingRow label="Freeze sessions" hint="If a device is lost: no session, Autopilot's included, can trade until you unfreeze. Your passkey keeps working.">
      {frozen.data ? (
        <Badge tone="warn" icon={<Snowflake className="size-3" aria-hidden />}>
          Frozen
        </Badge>
      ) : null}
      <Switch checked={frozen.data ?? false} disabled={frozen.data === undefined || tx.busy} onChange={(v) => void set(v)} label="Freeze sessions" />
      <TxStatus tx={tx} filledLabel="Done" className="w-full" />
    </SettingRow>
  );
}

/** Withdraw USDC to any NEAR account, with one passkey prompt (registering the receiver with USDC when it is new). */
function Withdraw() {
  const account = useAccount();
  const qc = useQueryClient();
  const balance = useUsdcBalance(account.address);
  const tx = useTx();
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const amount = parseAmount(text, USDC_DECIMALS);
  const receiver = to.trim().toLowerCase();
  const validTo = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(receiver) && receiver.length >= 2 && receiver.length <= 64;
  const tooMuch = amount !== null && balance.data !== undefined && amount > balance.data.raw;
  const error = to && !validTo ? "Not a NEAR account id" : receiver === account.address ? "That is this account" : null;
  const send = async () => {
    if (!amount || !validTo) return;
    const actions: OwnerAction[] = [];
    if (!(await isRegistered(DEPLOYMENT.contracts.usdc, receiver))) actions.push(ownerCall(storage.usdc(receiver)));
    actions.push(ownerCall(owner.sendUsdc(receiver, amount)));
    if (await tx.run(() => account.ownerExecute(actions), { action: "Withdraw USDC", done: `Sent ${tokenAmount(amount, USDC_DECIMALS)} USDC to ${shortAddress(receiver)}`, pending: "Confirm with your passkey" })) {
      setText("");
      void qc.invalidateQueries({ queryKey: ["usdc"] });
    }
  };
  return (
    <SettingRow top label="Withdraw" hint="Send USDC from this account to any NEAR account. Your passkey confirms each withdrawal; a session never can.">
      <div className="flex w-full flex-col gap-2 sm:w-[320px]">
        <Field label="To" placeholder="name.near or account id" value={to} onChange={(e) => setTo(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} error={error} data-testid="withdraw-to" />
        <Field
          label="Amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          suffix="USDC"
          value={text}
          onChange={(e) => setText(e.target.value.replace(/[^\d.,]/g, ""))}
          error={tooMuch ? "More than your balance" : null}
          action={
            balance.data ? (
              <button type="button" className="num text-[12px] text-text-3 hover:text-text" onClick={() => setText(tokenAmount(balance.data!.raw, USDC_DECIMALS, 6).replace(/,/g, ""))}>
                Balance {tokenAmount(balance.data.raw, USDC_DECIMALS)} <span className="ml-1 font-strong text-primary">Max</span>
              </button>
            ) : undefined
          }
          data-testid="withdraw-amount"
        />
        <Button tone="secondary" icon={<Fingerprint className="size-4" aria-hidden />} disabled={!amount || !validTo || tooMuch || Boolean(error)} loading={tx.busy} onClick={() => void send()} data-testid="withdraw-submit">
          Withdraw
        </Button>
        <TxStatus tx={tx} filledLabel="Sent" testId="withdraw-tx" />
      </div>
    </SettingRow>
  );
}

function UnlockButton() {
  const account = useAccount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        size="sm"
        tone="secondary"
        loading={busy}
        icon={<Fingerprint className="size-4" aria-hidden />}
        onClick={async () => {
          setBusy(true);
          setError(null);
          await account.unlockPrivate().catch((e: unknown) => setError(describeError(e)));
          setBusy(false);
        }}
      >
        Unlock
      </Button>
      {error ? <p className="w-full text-[12px] text-down">{error}</p> : null}
    </>
  );
}
