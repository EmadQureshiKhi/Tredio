"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, Fingerprint, KeyRound, Link2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { PrivateIdentity } from "@/lib/account/service";
import { Avatar } from "@/components/shell/AppShell";
import { Badge, Button, ErrorNote, Field, Skeleton } from "@/components/ui";
import { describeError, useAccount } from "@/lib/account/AccountProvider";
import { ApiError, social } from "@/lib/api";
import { shortAddress } from "@/lib/format";
import { useCopy } from "@/lib/hooks/useCopy";
import { linkMessage, profileMessage, signAsCaller } from "@/lib/social";
import { notify } from "@/lib/toast";
import { useCaller } from "@/features/autopilot/shared/data";
import { TextArea } from "@/features/autopilot/shared/kit";
import { useCallerIdentity } from "@/features/callers/identity";
import { Section } from "./Section";

const HANDLE = /^[a-z0-9_]{3,20}$/;

/** The caller identity: its public profile (signed), and linking it to the trading account. */
export function IdentitySection() {
  const account = useAccount();
  const me = useCallerIdentity();
  return (
    <Section
      id="identity"
      title="Caller identity"
      description="Calls and posts are signed by a caller key your passkey derives apart from your trading account. Nobody can tie the two together unless you link them."
    >
      {!account.authenticated ? (
        <Button onClick={account.login} icon={<Fingerprint className="size-4" aria-hidden />}>
          Sign in
        </Button>
      ) : !me.available ? (
        <p className="rounded-2xl border border-line p-4 text-[13.5px] leading-5 text-text-2">A caller identity comes from a passkey, apart from the trading account. A NEAR wallet cannot derive one, so calls, posts and private notes need a passkey account.</p>
      ) : !me.identity || !me.address ? (
        <div className="flex flex-col gap-3">
          <div className="flex gap-3 rounded-2xl border border-line p-4">
            <KeyRound className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
            <p className="text-[13.5px] leading-5 text-text-2">This device does not hold your caller key yet. One passkey prompt rebuilds it, along with your notes key.</p>
          </div>
          {me.unlockError ? <ErrorNote message={me.unlockError} /> : null}
          <Button className="self-start" loading={me.unlocking} icon={<Fingerprint className="size-4" aria-hidden />} onClick={me.unlock} data-testid="unlock-identity">
            Unlock with passkey
          </Button>
        </div>
      ) : (
        <Loaded identity={me.identity} />
      )}
    </Section>
  );
}

function Loaded({ identity: signer }: { identity: PrivateIdentity }) {
  const identity = signer.id;
  const caller = useCaller(identity);
  const missing = !caller.data && caller.error instanceof ApiError && caller.error.status === 404;
  if (caller.isLoading) return <Skeleton className="h-48 rounded-2xl" />;
  if (!caller.data && !missing) return <ErrorNote message="Your caller profile could not load." onRetry={() => void caller.refetch()} />;
  const profile = caller.data?.caller ?? null;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Avatar address={identity} size={44} />
        <div className="min-w-0">
          <p className="truncate font-strong text-[15px] text-text">{profile?.handle ? `@${profile.handle}` : "No handle yet"}</p>
          <CopyAddress address={identity} />
        </div>
        <Link href={`/c/${profile?.handle ?? identity}`} className="ml-auto inline-flex shrink-0 items-center gap-1 font-strong text-[13px] text-text-2 hover:text-text">
          Public profile <ExternalLink className="size-3.5" aria-hidden />
        </Link>
      </div>
      <ProfileForm key={`${profile?.handle ?? ""}|${profile?.bio ?? ""}`} signer={signer} handle={profile?.handle ?? ""} bio={profile?.bio ?? ""} />
      <LinkBlock signer={signer} linked={profile?.linked_account ?? null} />
    </div>
  );
}

function ProfileForm({ signer, handle: savedHandle, bio: savedBio }: { signer: PrivateIdentity; handle: string; bio: string }) {
  const qc = useQueryClient();
  const [handle, setHandle] = useState(savedHandle);
  const [bio, setBio] = useState(savedBio);
  const valid = HANDLE.test(handle) && bio.length <= 160;
  const changed = handle !== savedHandle || bio !== savedBio;
  const save = useMutation({
    mutationFn: async () => {
      const text = bio.trim();
      const signed = await signAsCaller(signer, (issuedAt) => profileMessage({ handle, bio: text, issuedAt }));
      return social.profile({ caller: signed.caller, handle, bio: text, issuedAt: signed.issuedAt, signature: signed.signature });
    },
    onSuccess: async () => {
      notify.success("Profile saved", "Your handle and bio show on your caller page.");
      await qc.invalidateQueries({ queryKey: ["caller"] });
      await qc.invalidateQueries({ queryKey: ["callers-leaderboard"] });
    },
  });
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && changed) save.mutate();
      }}
      data-testid="profile-form"
    >
      <Field
        label="Handle"
        value={handle}
        onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20))}
        placeholder="your_handle"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        error={handle && !HANDLE.test(handle) ? "3 to 20 of a-z, 0-9 and _" : null}
        hint="Shown on the leaderboard and your calls. You can change it; others cannot take it while it is yours."
        data-testid="profile-handle"
      />
      <TextArea label="Bio" value={bio} onChange={setBio} max={160} rows={2} placeholder="What you watch, in a line" testId="profile-bio" />
      {save.error ? <ErrorNote message={save.error instanceof Error ? save.error.message : "The profile could not be saved."} /> : null}
      <div className="flex items-center gap-3">
        <Button type="submit" tone={changed || !savedHandle ? "primary" : "secondary"} loading={save.isPending} disabled={!valid || !changed} data-testid="profile-save">
          {changed || !savedHandle ? "Sign and save" : "Saved"}
        </Button>
        <p className="text-[12px] leading-4 text-text-3">Signed by your caller key; no passkey prompt.</p>
      </div>
    </form>
  );
}

function LinkBlock({ signer, linked }: { signer: PrivateIdentity; linked: string | null }) {
  const account = useAccount();
  const identity = signer.id;
  const qc = useQueryClient();
  const [understood, setUnderstood] = useState(false);
  const self = account.address?.toLowerCase();
  const link = useMutation({
    mutationFn: async () => {
      if (!self) throw new Error("Sign in first.");
      // The caller key signs the link with no prompt; the account's passkey approves it (one prompt).
      const signed = await signAsCaller(signer, (issuedAt) => linkMessage(identity, self, issuedAt));
      return social.link({ identity, account: self, issuedAt: signed.issuedAt, identitySignature: signed.signature }, account.approve);
    },
    onSuccess: async () => {
      notify.success("Caller and trading account linked", "Your calls now show the trades behind them.");
      await qc.invalidateQueries({ queryKey: ["caller"] });
      await qc.invalidateQueries({ queryKey: ["callers-leaderboard"] });
    },
  });
  if (linked) {
    const mine = linked.toLowerCase() === self;
    return (
      <div className="flex items-start gap-3 rounded-2xl border border-line bg-surface-2 p-4" data-testid="link-status" data-linked={linked}>
        <Link2 className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-strong text-[13.5px] text-text">
            Linked to {mine ? "this trading account" : "another trading account"} <Badge tone={mine ? "up" : "warn"}>{shortAddress(linked)}</Badge>
          </p>
          <p className="mt-1 text-[12.5px] leading-[18px] text-text-2">Your profile shows this account&rsquo;s trading record, and anyone can copy its Hyperliquid trades. Links are permanent.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-line p-4" data-testid="link-block">
      <div className="flex gap-3">
        <Link2 className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
        <div>
          <p className="font-strong text-[13.5px] text-text">Link to your trading account</p>
          <p className="mt-1 text-[12.5px] leading-[18px] text-text-2">
            Linking publishes that this caller trades as <span className="num font-mono text-text">{shortAddress(self)}</span>, so your profile shows its trading record and people can copy your Hyperliquid trades. Your caller key signs it and your passkey approves it. It is public and permanent: it cannot be undone.
          </p>
        </div>
      </div>
      <label className="flex cursor-pointer items-start gap-2.5 text-[13px] leading-5 text-text">
        <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" data-testid="link-understood" />I understand the link is public and permanent.
      </label>
      {link.error ? <ErrorNote message={describeError(link.error)} /> : null}
      <Button className="self-start" tone="secondary" icon={<Fingerprint className="size-4" aria-hidden />} loading={link.isPending} disabled={!understood} onClick={() => link.mutate()} data-testid="link-submit">
        Link accounts
      </Button>
    </div>
  );
}

function CopyAddress({ address }: { address: string }) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      onClick={() => void copy(address, "Caller id copied")}
      className="num flex items-center gap-1.5 font-mono text-[12.5px] text-text-3 hover:text-text"
      aria-label="Copy caller id"
      data-testid="identity-address"
      data-address={address}
    >
      {shortAddress(address)}
      {copied ? <Check className="size-3 text-up" aria-hidden /> : <Copy className="size-3" aria-hidden />}
    </button>
  );
}
