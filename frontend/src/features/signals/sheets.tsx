"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { OwnerAction } from "@tredio/contracts";
import { ACCESS_MEMO_PREFIX, AUTOPILOT_MARKETS, COMMIT_AMOUNT, COMMIT_MEMO_PREFIX, channelMessage, signalCommitment, signalMessage } from "@tredio/autopilot";
import { Check, Eye, Fingerprint, KeyRound, Lock } from "lucide-react";
import { useState } from "react";
import { Button, ErrorNote, Field, Segmented, Sheet } from "@/components/ui";
import { describeError, useAccount } from "@/lib/account/AccountProvider";
import { parseAmount } from "@/lib/amount";
import { type SignalChannel, signals } from "@/lib/api";
import { DEPLOYMENT, USDC_DECIMALS } from "@/lib/config";
import { tokenAmount } from "@/lib/format";
import { signAsCaller } from "@/lib/social";
import { notify } from "@/lib/toast";
import { owner, ownerCall, storage } from "@/lib/trade/calls";
import { isRegistered } from "@/lib/trade/reads";
import { useTx } from "@/lib/trade/useTx";
import { SelectPill, TextArea } from "@/features/autopilot/shared/kit";
import { useCallerIdentity } from "@/features/callers/identity";
import { channelName, days } from "./data";

/** What signals keep private, said the same way wherever someone pays for them or publishes one. */
export const PRIVACY_NOTE = "Positions on chain stay public; what is private is the signal and its timing.";

const PERIODS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
] as const;
const DELAYS = [
  { value: "900", label: "15 min" },
  { value: "3600", label: "1 hour" },
  { value: "21600", label: "6 hours" },
  { value: "86400", label: "1 day" },
] as const;

/** A leader opens or changes its channel: price, period and reveal delay, signed by its caller key. */
export function ChannelSheet({ open, onOpenChange, current }: { open: boolean; onOpenChange: (o: boolean) => void; current: SignalChannel | null }) {
  const me = useCallerIdentity();
  const qc = useQueryClient();
  const [price, setPrice] = useState(current ? tokenAmount(BigInt(current.price_usdc), USDC_DECIMALS, 6) : "5");
  const [period, setPeriod] = useState<"7" | "30">(current?.period_days === 7 ? "7" : "30");
  const [delay, setDelay] = useState<(typeof DELAYS)[number]["value"]>((DELAYS.find((d) => Number(d.value) === current?.reveal_delay_sec)?.value ?? "3600") as (typeof DELAYS)[number]["value"]);
  const atomic = parseAmount(price, USDC_DECIMALS);
  const save = useMutation({
    mutationFn: async () => {
      if (!me.identity) throw new Error("Unlock your caller identity first.");
      if (!atomic || atomic <= 0n) throw new Error("Set a price above zero.");
      const body = { priceUsdc: atomic.toString(), periodDays: Number(period), revealDelaySec: Number(delay) };
      const signed = await signAsCaller(me.identity, (issuedAt) => channelMessage({ ...body, issuedAt }));
      return signals.setChannel({ caller: signed.caller, ...body, issuedAt: signed.issuedAt, signature: signed.signature });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["signal-channels"] });
      notify.success(current ? "Channel saved" : "Signals channel open", "Publish a signal from your profile.");
      onOpenChange(false);
    },
  });
  return (
    <Sheet open={open} onOpenChange={onOpenChange} busy={save.isPending} testId="signal-channel-sheet" title={current ? "Channel settings" : "Sell your signals"} description="Followers pay you in USDC on NEAR to read your signals early and to copy them with Autopilot. Everyone else reads them after your delay.">
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        noValidate
      >
        <Field label="Price of early access" suffix="USDC" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} error={price && !atomic ? "A USDC amount" : undefined} hint="Paid straight to your trading account." data-testid="channel-price" />
        <div className="flex flex-col gap-2">
          <p className="font-strong text-[12.5px] text-text-2">For</p>
          <Segmented label="Access period" value={period} onChange={setPeriod} options={PERIODS} />
        </div>
        <div className="flex flex-col gap-2">
          <p className="font-strong text-[12.5px] text-text-2">Public after</p>
          <Segmented label="Reveal delay" size="sm" value={delay} onChange={setDelay} options={DELAYS} />
        </div>
        <div className="flex gap-3 rounded-2xl border border-line bg-surface-2 p-4">
          <Eye className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
          <p className="text-[13px] leading-5 text-text-2">{PRIVACY_NOTE} Each signal&rsquo;s hash goes on chain from your account before anyone can read it, so nobody can change or backdate it.</p>
        </div>
        {save.error ? <ErrorNote message={describeError(save.error)} /> : null}
        <Button type="submit" size="lg" block loading={save.isPending} disabled={!atomic} data-testid="channel-save">
          {current ? "Sign and save" : "Sign and open channel"}
        </Button>
      </form>
    </Sheet>
  );
}

/**
 * Publishing a signal: the caller key signs it, the leader's account commits its hash on chain (a
 * 0.000001 USDC transfer to the treasury whose memo is the hash, one passkey prompt), then the API
 * stamps the market's mark and stores it sealed until the channel's delay passes.
 */
export function PublishSheet({ open, onOpenChange, channel }: { open: boolean; onOpenChange: (o: boolean) => void; channel: SignalChannel }) {
  const account = useAccount();
  const me = useCallerIdentity();
  const qc = useQueryClient();
  const tx = useTx();
  const [kind, setKind] = useState<"open" | "close">("open");
  const [market, setMarket] = useState<string>(AUTOPILOT_MARKETS[0]);
  const [side, setSide] = useState<"long" | "short">("long");
  const [margin, setMargin] = useState("100");
  const [leverage, setLeverage] = useState("3");
  const [note, setNote] = useState("");
  const m = Number(margin);
  const lev = Number(leverage);
  const bad = kind === "open" && (!(m > 0) || !(lev >= 1 && lev <= 10));
  const publish = useMutation({
    mutationFn: async () => {
      if (!me.identity) throw new Error("Unlock your caller identity first.");
      const fields = { kind, market, side, marginUsdc: kind === "open" ? m : null, leverage: kind === "open" ? lev : null, note: note.trim() };
      const identity = me.identity;
      const signed = await signAsCaller(identity, (issuedAt) => signalMessage(identity.id, { ...fields, issuedAt }));
      const commitment = await signalCommitment(identity.id, { ...fields, issuedAt: signed.issuedAt });
      const sent = await tx.run(() => account.ownerExecute([ownerCall(owner.sendUsdc(DEPLOYMENT.treasury, COMMIT_AMOUNT, COMMIT_MEMO_PREFIX + commitment))]), {
        action: "Commit signal",
        done: "Signal committed on chain",
        pending: "Confirm with your passkey",
      });
      if (!sent?.sender) throw new Error("The commitment did not go through.");
      const signal = kind === "open" ? { kind, market, side, marginUsdc: m, leverage: lev, note: fields.note } : { kind, market, side, note: fields.note };
      return signals.publish({ caller: signed.caller, signal, issuedAt: signed.issuedAt, signature: signed.signature, commitTx: sent.hash, commitSender: sent.sender });
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["signal-feed"] });
      await qc.invalidateQueries({ queryKey: ["signal-channels"] });
      notify.success("Signal published", `Public ${new Date(r.signal.revealAt * 1000).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}. Early access holders read it now.`);
      onOpenChange(false);
    },
  });
  return (
    <Sheet open={open} onOpenChange={onOpenChange} busy={publish.isPending} testId="signal-publish-sheet" title="Publish a signal" description={`A trade in one of Autopilot's markets. Paying followers read it now and can copy it; everyone else after ${days(channel.reveal_delay_sec)}.`}>
      <form
        className="flex flex-col gap-5 [font-feature-settings:'calt'_0]"
        onSubmit={(e) => {
          e.preventDefault();
          if (!bad && note.length <= 280) publish.mutate();
        }}
        noValidate
      >
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-2">
            <p className="font-strong text-[12.5px] text-text-2">Signal</p>
            <Segmented
              label="Signal"
              value={kind}
              onChange={setKind}
              options={[
                { value: "open", label: "Open" },
                { value: "close", label: "Close" },
              ]}
            />
          </div>
          <div className="flex flex-col gap-2">
            <p className="font-strong text-[12.5px] text-text-2">Market</p>
            <SelectPill label="Market" value={market} onChange={setMarket} options={AUTOPILOT_MARKETS.map((x) => ({ value: x, label: `${x}-PERP` }))} className="w-full [&_select]:h-11 [&_select]:w-full" testId="signal-market" />
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <p className="font-strong text-[12.5px] text-text-2">{kind === "open" ? "Side" : "Close the"}</p>
          <Segmented
            label="Side"
            value={side}
            onChange={setSide}
            options={[
              { value: "long", label: "Long", tone: "up" },
              { value: "short", label: "Short", tone: "down" },
            ]}
          />
        </div>
        {kind === "open" ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Margin" suffix="USDC" inputMode="decimal" value={margin} onChange={(e) => setMargin(e.target.value)} error={margin && !(m > 0) ? "Above zero" : undefined} hint="Copies scale it" data-testid="signal-margin" />
            <Field label="Leverage" suffix="x" inputMode="decimal" value={leverage} onChange={(e) => setLeverage(e.target.value)} error={leverage && !(lev >= 1 && lev <= 10) ? "1 to 10" : undefined} data-testid="signal-leverage" />
          </div>
        ) : null}
        <TextArea label="Why (optional)" value={note} onChange={setNote} max={280} rows={3} placeholder="The thesis in a line or two" testId="signal-note" />
        <div className="flex gap-3 rounded-2xl border border-line bg-surface-2 p-4">
          <Lock className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
          <p className="text-[13px] leading-5 text-text-2">
            Your passkey sends 0.000001 USDC from your account to Tredio&rsquo;s treasury with the signal&rsquo;s hash as the memo, so the chain shows when you called it. {PRIVACY_NOTE}
          </p>
        </div>
        {publish.error ? <ErrorNote message={describeError(publish.error)} /> : null}
        <Button type="submit" size="lg" block loading={publish.isPending} disabled={bad || note.length > 280} icon={<Fingerprint className="size-[18px]" aria-hidden />} data-testid="signal-submit">
          Sign, commit and publish
        </Button>
      </form>
    </Sheet>
  );
}

/**
 * Early access: a USDC transfer from the account to the leader's account (one passkey prompt), then
 * the API reads the payment back from the chain and opens the channel's viewing keys for the period.
 * A claim that fails after the payment can be sent again with the same transaction.
 */
export function AccessSheet({ open, onOpenChange, channel, onCopy }: { open: boolean; onOpenChange: (o: boolean) => void; channel: SignalChannel; onCopy?: () => void }) {
  const account = useAccount();
  const qc = useQueryClient();
  const tx = useTx();
  const [paid, setPaid] = useState<{ hash: string; sender: string } | null>(null);
  const price = BigInt(channel.price_usdc);
  const name = channelName(channel);
  const claim = useMutation({
    mutationFn: (p: { hash: string; sender: string }) => signals.claim(channel.leader, p.hash, p.sender),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ["signal-access", channel.leader] }), qc.invalidateQueries({ queryKey: ["signal-opened", channel.leader] })]),
  });
  const pay = useMutation({
    mutationFn: async () => {
      if (!channel.account) throw new Error("This channel has no account to pay.");
      const to = channel.account;
      const actions: OwnerAction[] = [];
      if (!(await isRegistered(DEPLOYMENT.contracts.usdc, to))) actions.push(ownerCall(storage.usdc(to)));
      actions.push(ownerCall(owner.sendUsdc(to, price, ACCESS_MEMO_PREFIX + channel.leader)));
      const sent = await tx.run(() => account.ownerExecute(actions), { action: "Buy early access", done: `Paid ${tokenAmount(price, USDC_DECIMALS)} USDC to ${name}`, pending: "Confirm with your passkey" });
      if (!sent?.sender) throw new Error("The payment did not go through.");
      const p = { hash: sent.hash, sender: sent.sender };
      setPaid(p);
      await claim.mutateAsync(p);
    },
  });
  const done = claim.data;
  return (
    <Sheet open={open} onOpenChange={onOpenChange} busy={pay.isPending || claim.isPending} testId="signal-access-sheet" title={`Early access to ${name}`} description={`Read each signal as it is published instead of ${days(channel.reveal_delay_sec)} later, and let Autopilot copy them.`}>
      {done ? (
        <div className="flex flex-col gap-4" data-testid="signal-access-done">
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-surface-2 px-4 py-6 text-center">
            <span className="flex size-11 items-center justify-center rounded-full bg-up-soft text-up">
              <Check className="size-5" aria-hidden />
            </span>
            <p className="font-strong text-[15px] text-text">Early access until {new Date(done.expiresAt * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</p>
            <p className="max-w-xs text-[13px] leading-5 text-text-2">New signals open on this device as they land. Renew before then to keep reading them early.</p>
          </div>
          {onCopy && account.kind !== "wallet" ? (
            <Button size="lg" block onClick={onCopy} data-testid="signal-copy">
              Copy them with Autopilot
            </Button>
          ) : null}
        </div>
      ) : !account.authenticated ? (
        <Button block size="lg" icon={<Fingerprint className="size-[18px]" aria-hidden />} onClick={account.login}>
          Sign in to buy early access
        </Button>
      ) : (
        <div className="flex flex-col gap-5">
          <dl className="grid grid-cols-3 gap-2.5">
            <Fact label="Price" value={`${tokenAmount(price, USDC_DECIMALS)} USDC`} />
            <Fact label="For" value={`${channel.period_days} days`} />
            <Fact label="Public after" value={days(channel.reveal_delay_sec)} />
          </dl>
          <ul className="flex list-disc flex-col gap-1.5 rounded-2xl border border-line bg-surface-2 p-4 pl-8 text-[12.5px] leading-[18px] text-text-2">
            <li>{PRIVACY_NOTE} Copies you place are ordinary Hyperliquid orders anyone can see.</li>
            <li>The USDC goes straight to the leader&rsquo;s account, {channel.account}, with this channel in the memo. Tredio reads the payment from the chain.</li>
            <li>Each signal&rsquo;s hash was committed on chain before anyone could read it, so you can check it was not changed or backdated.</li>
            <li>Signals are not advice. Tredio&rsquo;s server holds the keys it sells, so it can read every signal too.</li>
          </ul>
          {paid && claim.error ? (
            <div className="flex flex-col gap-2">
              <ErrorNote message={`You paid, but the claim failed: ${describeError(claim.error)}`} />
              <Button tone="secondary" block loading={claim.isPending} onClick={() => claim.mutate(paid)} icon={<KeyRound className="size-4" aria-hidden />} data-testid="signal-claim-retry">
                Claim again with the same payment
              </Button>
            </div>
          ) : pay.error ? (
            <ErrorNote message={describeError(pay.error)} />
          ) : null}
          <Button size="lg" block loading={pay.isPending || claim.isPending} disabled={Boolean(paid)} icon={<Fingerprint className="size-[18px]" aria-hidden />} onClick={() => pay.mutate()} data-testid="signal-buy">
            Pay {tokenAmount(price, USDC_DECIMALS)} USDC
          </Button>
        </div>
      )}
    </Sheet>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-2xl border border-line bg-surface-2/60 px-3 py-2.5">
      <dt className="truncate text-[11px] uppercase tracking-[0.08em] text-text-3">{label}</dt>
      <dd className="num truncate font-strong text-[14px] text-text">{value}</dd>
    </div>
  );
}
