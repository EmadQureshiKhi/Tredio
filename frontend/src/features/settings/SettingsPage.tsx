"use client";
import { Check, Copy, Fingerprint, LogOut } from "lucide-react";
import { useState } from "react";
import { Avatar } from "@/components/shell/AppShell";
import { Badge, Button, ErrorNote, ExplorerLink, Segmented, Skeleton } from "@/components/ui";
import { describeError, useAccount } from "@/lib/account/AccountProvider";
import { explorerAddress } from "@/lib/config";
import { countdown, shortAddress } from "@/lib/format";
import { useCopy } from "@/lib/hooks/useCopy";
import { type ThemeChoice, useTheme } from "@/lib/theme";
import { PageHeader } from "@/features/autopilot/shared/kit";
import { AlertsSection } from "./AlertsSection";
import { IdentitySection } from "./IdentitySection";
import { NotesSection } from "./NotesSection";
import { NotificationsSection } from "./NotificationsSection";
import { Section, SettingRow } from "./Section";

const NAV = [
  { id: "account", label: "Account" },
  { id: "identity", label: "Caller identity" },
  { id: "notes", label: "Private notes" },
  { id: "notifications", label: "Notifications" },
  { id: "alerts", label: "Attention alerts" },
  { id: "appearance", label: "Appearance" },
] as const;

/** /settings: the account, caller identity, private notes, notifications, attention alerts and theme. */
export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-6 [font-feature-settings:'calt'_0]">
      <PageHeader title="Settings" description="Your passkey account, the identity you post calls with, notes only you can read, and how Tredio reaches you." />
      <div className="grid items-start gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4 sm:mx-0 sm:px-0 lg:sticky lg:top-24 lg:flex-col lg:gap-0.5">
          {NAV.map((n) => (
            <a key={n.id} href={`#${n.id}`} className="h-8 shrink-0 rounded-full border border-line bg-surface px-3.5 font-strong text-[13px] leading-[30px] text-text-2 transition-colors hover:text-text lg:h-9 lg:rounded-xl lg:border-0 lg:bg-transparent lg:px-3 lg:leading-9 lg:hover:bg-surface">
              {n.label}
            </a>
          ))}
        </nav>
        <div className="flex min-w-0 flex-col gap-5">
          <AccountSection />
          <IdentitySection />
          <NotesSection />
          <NotificationsSection />
          <AlertsSection />
          <AppearanceSection />
        </div>
      </div>
    </div>
  );
}

const when = (sec: number) => new Date(sec * 1000).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function AccountSection() {
  const account = useAccount();
  const { copied, copy } = useCopy();
  const [renewError, setRenewError] = useState<string | null>(null);
  const [renewing, setRenewing] = useState(false);
  const s = account.session;
  return (
    <Section id="account" title="Account" description="An account owned by your passkey. No seed phrase; your passkey rebuilds it on any device.">
      {!account.ready ? (
        <Skeleton className="h-28 rounded-2xl" />
      ) : !account.authenticated || !s ? (
        <div className="flex flex-col gap-3">
          <p className="text-[13.5px] text-text-2">
            {account.status !== "session-expired"
              ? "You are signed out."
              : account.upgradeRequired
                ? "A safer account version is available. One passkey prompt upgrades yours; your address, funds and positions stay the same."
                : account.sessionOutdated
                  ? "Tredio tightened what a trading session may do. One passkey prompt renews yours with the new limits."
                  : "Your trading session ended. One passkey prompt renews it for a week."}
          </p>
          <Button className="self-start" icon={<Fingerprint className="size-4" aria-hidden />} onClick={account.login}>
            {account.status === "session-expired" ? (account.upgradeRequired ? "Upgrade account" : "Renew session") : "Sign in"}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col">
          <SettingRow label="Address" hint="Send USDC here.">
            <span className="flex items-center gap-2">
              <Avatar address={s.address} size={20} />
              <button
                type="button"
                onClick={() => void copy(s.address, "Address copied")}
                className="num flex items-center gap-1.5 font-mono text-[13px] text-text hover:text-primary"
                aria-label="Copy account address"
                data-testid="settings-address"
              >
                {shortAddress(s.address)}
                {copied ? <Check className="size-3.5 text-up" aria-hidden /> : <Copy className="size-3.5 text-text-3" aria-hidden />}
              </button>
              <ExplorerLink href={explorerAddress(s.address)} size="icon" />
            </span>
          </SettingRow>
          <SettingRow label="Trading session" hint={`Trades without a prompt, opening up to 500 USDC of trades a day, until ${when(s.validUntil)}. Withdrawals, new permissions, follows, enabling rules and identity links always ask for your passkey.`}>
            <Badge tone="up">{countdown(s.validUntil)} left</Badge>
            <Button
              size="sm"
              tone="secondary"
              loading={renewing}
              onClick={async () => {
                setRenewError(null);
                setRenewing(true);
                try {
                  await account.renewSession();
                } catch (e) {
                  setRenewError(describeError(e));
                } finally {
                  setRenewing(false);
                }
              }}
            >
              Renew
            </Button>
          </SettingRow>
          {renewError || account.error ? <ErrorNote message={renewError ?? account.error!} className="mt-1" /> : null}
          <SettingRow label="Private keys" hint="Caller identity and notes key, derived from your passkey and kept wrapped on this device.">
            {account.privateIdentity ? <Badge tone="primary">On this device</Badge> : <UnlockButton />}
          </SettingRow>
          <SettingRow label="This device" hint="Signing out deletes the session and keys stored here. Your account, rules and notes stay; your passkey brings them back.">
            <Button size="sm" tone="ghost" icon={<LogOut className="size-4" aria-hidden />} onClick={() => void account.logout()}>
              Sign out
            </Button>
          </SettingRow>
        </div>
      )}
    </Section>
  );
}

function UnlockButton() {
  const account = useAccount();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      tone="secondary"
      loading={busy}
      icon={<Fingerprint className="size-4" aria-hidden />}
      onClick={async () => {
        setBusy(true);
        await account.unlockPrivate().catch(() => null);
        setBusy(false);
      }}
    >
      Unlock
    </Button>
  );
}

const THEMES: Array<{ value: ThemeChoice; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function AppearanceSection() {
  const { choice, setChoice } = useTheme();
  return (
    <Section id="appearance" title="Appearance" description="System follows your device's light or dark setting.">
      <Segmented label="Theme" value={choice} onChange={setChoice} options={THEMES} className="max-w-sm" />
    </Section>
  );
}
