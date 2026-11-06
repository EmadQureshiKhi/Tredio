"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Droplets, Globe2, Link2, Sparkles } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Badge, Button, DrawnCheck, ErrorNote, Field, Num, Sheet, Skeleton, TxStatus } from "@/components/ui";
import { confirmNote } from "@/features/trend/ticket";
import { useAccount } from "@/lib/account/AccountProvider";
import { ApiSignIn } from "@/lib/account/ApiSignIn";
import { ApiError, faucet, type LinkResult, links } from "@/lib/api";
import { IS_MAINNET, USDC_DECIMALS } from "@/lib/config";
import { usdc, shortAddress, tokenNumber } from "@/lib/format";
import { useUsdcBalance } from "@/lib/hooks/queries";
import { useCopy } from "@/lib/hooks/useCopy";
import { useSheets } from "@/lib/sheets";
import { WaitlistSheet } from "@/features/waitlist/Waitlist";
import { session } from "@/lib/trade/calls";
import { useTx } from "@/lib/trade/useTx";
import { faucetButton, faucetState, isCooldown, untilText } from "./faucet-claims";

/** The panels any screen can open: add funds, propose a trend from a link, and the Mainnet waitlist. */
export default function GlobalSheets() {
  const { current, close } = useSheets();
  return (
    <>
      <DepositSheet open={current === "deposit"} onOpenChange={(o) => !o && close()} />
      <ProposeSheet open={current === "propose"} onOpenChange={(o) => !o && close()} />
      <WaitlistSheet open={current === "waitlist"} onOpenChange={(o) => !o && close()} />
    </>
  );
}

function DepositSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const account = useAccount();
  const qc = useQueryClient();
  const balance = useUsdcBalance(account.address);
  const { copied, copy } = useCopy();
  const address = account.address;
  const info = useQuery({ queryKey: ["faucet", address], queryFn: () => faucet.info(address), enabled: open && !IS_MAINNET && Boolean(address), refetchInterval: open ? 30_000 : false });
  const tx = useTx();
  const now = useMinute(open);
  // The amount just claimed, shown as the button's success state for a moment.
  const [justClaimed, setJustClaimed] = useState<string | null>(null);
  useEffect(() => {
    if (!justClaimed) return;
    const t = setTimeout(() => setJustClaimed(null), SUCCESS_MS);
    return () => clearTimeout(t);
  }, [justClaimed]);
  const amount = info.data?.amount ? usdc(Number(info.data.amount) / 1e6) : null;
  const drip = async () => {
    const r = await tx.run(() => account.trade(session.faucet), { action: "Get test USDC", done: `Added ${amount ?? "test"} USDC`, pending: confirmNote(account.kind, false) });
    if (r) setJustClaimed(amount ?? "");
    void qc.invalidateQueries({ queryKey: ["usdc"] });
    void qc.invalidateQueries({ queryKey: ["faucet"] });
  };
  const faucetNow = faucetState(info.data?.nextAt, now);
  const button = faucetButton(faucetNow, now, justClaimed);
  const cooldown = tx.stage === "failed" && isCooldown(tx.error);
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Add funds" description="Tredio settles everything in USDC, a dollar stablecoin on NEAR." testId="deposit-sheet" busy={tx.busy}>
      <div className="flex flex-col gap-5">
        <div className="rounded-2xl border border-line bg-surface-2 p-4">
          <p className="text-[12.5px] text-text-3">Balance</p>
          <p className="num-display mt-1 font-display text-[34px] leading-none text-text">
            <Num value={balance.data ? tokenNumber(balance.data.raw, USDC_DECIMALS) : null} testId="deposit-balance" /> <span className="font-sans text-[15px] text-text-3">USDC</span>
          </p>
        </div>
        {account.status === "loading" ? (
          <Skeleton className="h-40 rounded-2xl" />
        ) : !account.authenticated ? (
          <Button block size="lg" onClick={account.login}>
            Sign in to add funds
          </Button>
        ) : (
          <>
            {!IS_MAINNET ? (
              <section className="flex flex-col gap-3 rounded-2xl border border-line p-4">
                <div className="flex items-center gap-2">
                  <Droplets className="size-[18px] text-primary" aria-hidden />
                  <h3 className="font-strong text-[14px] text-text">Test USDC</h3>
                  <Badge tone="warn" className="ml-auto">
                    Testnet
                  </Badge>
                </div>
                <p className="text-[13px] leading-5 text-text-2">
                  This is NEAR testnet. Test USDC has no value; the token&rsquo;s own faucet pays {amount ?? "a fixed amount"} USDC{info.data?.cooldownSec ? ` every ${untilText(info.data.cooldownSec * 1000)}` : ""} to try every market{account.kind === "passkey" ? ", gas-free through your session" : ""}.
                </p>
                {button.tone === "success" ? (
                  // The draw landed: a moment of green, the size of the button it replaces.
                  <p role="status" className="flex h-10 items-center justify-center gap-2 rounded-xl bg-up-soft font-strong text-sm text-up transition-opacity duration-200 starting:opacity-0" data-testid="faucet-claim" data-state="success">
                    <DrawnCheck />
                    {button.label}
                  </p>
                ) : (
                  // Until the faucet says when this account may draw, the button waits: a draw inside the cooldown only fails.
                  <Button block loading={tx.busy || !info.data} disabled={!info.data || info.data.available === false || button.tone !== "ready"} onClick={() => void drip()} data-testid="faucet-claim" data-state={info.data ? button.tone : "loading"}>
                    {button.label}
                  </Button>
                )}
                {cooldown ? null : <TxStatus tx={tx} filledLabel="Claimed" testId="faucet-tx" />}
                {cooldown ? <p className="text-[12.5px] leading-[18px] text-text-3">This account drew test USDC a short while ago. The faucet pays once per cooldown.</p> : null}
              </section>
            ) : null}
            <section className="flex flex-col gap-3 rounded-2xl border border-line p-4">
              <div className="flex items-center gap-2">
                <Globe2 className="size-[18px] text-primary" aria-hidden />
                <h3 className="font-strong text-[14px] text-text">From any chain</h3>
              </div>
              <p className="text-[13px] leading-5 text-text-2">
                {IS_MAINNET
                  ? "Send USDC, USDT, ETH or BTC from Ethereum, Base, Arbitrum, Solana, Bitcoin and more. NEAR Intents delivers it to your account as USDC."
                  : "Any-chain deposits through NEAR Intents run on mainnet, where real assets move. On testnet you can preview the route and its price."}
              </p>
              <Link href="/deposit" className="font-strong text-[13.5px] text-primary underline-offset-4 hover:underline" onClick={() => onOpenChange(false)}>
                {IS_MAINNET ? "Start a deposit" : "Preview a deposit"}
              </Link>
            </section>
            <section className="flex flex-col gap-2 rounded-2xl border border-line p-4">
              <h3 className="font-strong text-[14px] text-text">From a NEAR wallet</h3>
              <p className="text-[13px] leading-5 text-text-2">Send {IS_MAINNET ? "native USDC" : "Tredio's test USDC"} on NEAR to your account.</p>
              <button
                type="button"
                onClick={() => address && void copy(address, "Account copied")}
                className="num flex items-center justify-between gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2.5 font-mono text-[13px] text-text-2 hover:text-text"
              >
                <span className="truncate">{address}</span>
                {copied ? <Check className="size-4 shrink-0 text-up" aria-hidden /> : <Copy className="size-4 shrink-0" aria-hidden />}
                <span className="sr-only">Copy {shortAddress(address)}</span>
              </button>
            </section>
          </>
        )}
      </div>
    </Sheet>
  );
}

/** How long the faucet button shows its success before the countdown to the next claim. */
const SUCCESS_MS = 2_400;

/** The time (ms) to the half minute, ticking while `active`, for the faucet's countdown. */
function useMinute(active: boolean): number {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!active) return () => {};
      const t = setInterval(notify, 30_000);
      return () => clearInterval(t);
    },
    [active],
  );
  return useSyncExternalStore(subscribe, () => Math.floor(Date.now() / 30_000) * 30_000, () => 0);
}

function ProposeSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const account = useAccount();
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<LinkResult | null>(null);
  const propose = useMutation({
    mutationFn: () => links.propose(url.trim()),
    onSuccess: (r) => setResult(r),
  });
  const reset = () => {
    setUrl("");
    setResult(null);
    propose.reset();
  };
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setTimeout(reset, 250);
      }}
      busy={propose.isPending}
      title="Propose a trend"
      description="Paste a link to what everyone is talking about. If it becomes a market, you earn a share of its fees as its first curator."
      testId="propose-sheet"
    >
      {account.status === "loading" ? (
        <Skeleton className="h-40 rounded-2xl" />
      ) : !account.authenticated ? (
        <Button block size="lg" onClick={account.login}>
          Sign in to propose
        </Button>
      ) : !account.backendReady ? (
        <ApiSignIn purpose="so the proposal is credited to this account" />
      ) : result ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2 rounded-2xl border border-line bg-surface-2 p-4">
            <div className="flex items-center gap-2">
              <Sparkles className="size-[18px] text-primary" aria-hidden />
              <p className="font-strong text-[15px] text-text">{result.displayName ?? "Proposal received"}</p>
            </div>
            {result.identifier ? <p className="font-mono text-[12px] text-text-3">{result.identifier}</p> : null}
            {result.summary ? <p className="text-[13.5px] leading-5 text-text-2">{result.summary}</p> : null}
            <div className="flex flex-wrap gap-1.5 pt-1">
              <Badge tone={result.status === "approved" || result.status === "live" ? "up" : result.status === "pending" ? "warn" : "down"}>
                {result.status === "approved" ? "Approved: measuring attention" : result.status === "live" ? "Already live" : result.status === "pending" ? "Waiting for review" : result.status === "failed" ? "Could not read the link" : "Not listed"}
              </Badge>
              {result.firstSurfacer ? <Badge tone="primary">You are the first curator</Badge> : null}
            </div>
            <p className="text-[12.5px] leading-5 text-text-3">{result.reason}</p>
          </div>
          <Button tone="secondary" block onClick={reset}>
            Propose another
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) propose.mutate();
          }}
        >
          <Field label="Link" placeholder="https://x.com/... or any news article" value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" autoComplete="off" />
          <ul className="flex flex-col gap-1.5 text-[12.5px] leading-5 text-text-3">
            <li className="flex gap-2">
              <Link2 className="mt-0.5 size-3.5 shrink-0" aria-hidden /> Posts on X, YouTube, TikTok and Reddit, Wikipedia articles and news pages.
            </li>
            <li className="flex gap-2">
              <Sparkles className="mt-0.5 size-3.5 shrink-0" aria-hidden /> Tredio&rsquo;s AI names the topic, checks it against market policy and approves it automatically, and the oracle measures its attention before it lists.
            </li>
          </ul>
          <Button type="submit" size="lg" block loading={propose.isPending} disabled={!url.trim()}>
            Propose
          </Button>
          {propose.error ? <ErrorNote message={propose.error instanceof ApiError ? propose.error.message : "The proposal failed."} /> : null}
        </form>
      )}
    </Sheet>
  );
}
