"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Droplets, Link2, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Badge, Button, DrawnCheck, ErrorNote, Field, Num, Sheet, Skeleton } from "@/components/ui";
import { useAccount } from "@/lib/account/AccountProvider";
import { ApiError, faucet, type LinkResult, links } from "@/lib/api";
import { USDC_DECIMALS, explorerTx, IS_MAINNET } from "@/lib/config";
import { usdc, shortAddress, tokenNumber } from "@/lib/format";
import { useUsdcBalance } from "@/lib/hooks/queries";
import { useCopy } from "@/lib/hooks/useCopy";
import { useSheets } from "@/lib/sheets";
import { notify } from "@/lib/toast";
import { WaitlistSheet } from "@/features/waitlist/Waitlist";
import { faucetButton, faucetState, isAlreadyClaimed, recordClaim, useFaucetClaim } from "./faucet-claims";

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
  const info = useQuery({ queryKey: ["faucet"], queryFn: () => faucet.info(), enabled: open && !IS_MAINNET });
  const address = account.address;
  const claim = useFaucetClaim(address);
  const now = useMinute(open);
  // The amount just claimed, shown as the button's success state for a moment.
  const [justClaimed, setJustClaimed] = useState<string | null>(null);
  useEffect(() => {
    if (!justClaimed) return;
    const t = setTimeout(() => setJustClaimed(null), SUCCESS_MS);
    return () => clearTimeout(t);
  }, [justClaimed]);
  const drip = useMutation({
    mutationFn: () => faucet.drip(),
    onSuccess: (r) => {
      if (address) recordClaim(address, { at: Date.now(), known: true });
      setJustClaimed(usdc(Number(r.amount) / 1e6));
      notify.success(`Added ${usdc(Number(r.amount) / 1e6)} test USDC`, "It is in your balance, ready to trade.", explorerTx(r.hash));
      void qc.invalidateQueries({ queryKey: ["usdc"] });
    },
    onError: (e) => {
      // Claimed earlier, from another browser or before this one remembered it.
      if (address && e instanceof ApiError && isAlreadyClaimed(e.status, (e.body as { error?: string } | null)?.error)) recordClaim(address, { at: Date.now(), known: false });
    },
  });
  const faucetNow = faucetState(claim, now);
  const button = faucetButton(faucetNow, now, justClaimed);
  const refused = drip.error instanceof ApiError && isAlreadyClaimed(drip.error.status, (drip.error.body as { error?: string } | null)?.error);
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Add funds" description="Tredio settles everything in USDC, a dollar stablecoin." testId="deposit-sheet" busy={drip.isPending}>
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
                  <Badge tone="warn" className="ml-auto">Testnet</Badge>
                </div>
                <p className="text-[13px] leading-5 text-text-2">This is Testnet. Test USDC has no value; take {info.data?.amount ? usdc(Number(info.data.amount) / 1e6) : "100.00"} a day to try every market.</p>
                {button.tone === "success" ? (
                  // The claim landed: a moment of green, the size of the button it replaces.
                  <p role="status" className="flex h-10 items-center justify-center gap-2 rounded-xl bg-up-soft font-strong text-sm text-up transition-opacity duration-200 starting:opacity-0" data-testid="faucet-claim" data-state="success">
                    <DrawnCheck />
                    {button.label}
                  </p>
                ) : (
                  <Button block loading={drip.isPending} disabled={info.data?.available === false || button.tone !== "ready"} onClick={() => drip.mutate()} data-testid="faucet-claim" data-state={button.tone}>
                    {button.label}
                  </Button>
                )}
                {faucetNow.kind === "refused" ? (
                  <p className="text-[12.5px] leading-[18px] text-text-3">This account already took today&rsquo;s test USDC. The faucet pays each account once every 24 hours.</p>
                ) : drip.error && !refused ? (
                  <ErrorNote message={drip.error instanceof ApiError ? drip.error.message : "The faucet did not answer."} />
                ) : null}
              </section>
            ) : null}
            <section className="flex flex-col gap-2 rounded-2xl border border-line p-4">
              <h3 className="font-strong text-[14px] text-text">From a wallet</h3>
              <p className="text-[13px] leading-5 text-text-2">Send USDC to your account address.</p>
              <button
                type="button"
                onClick={() => address && void copy(address, "Address copied")}
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
          <Button type="submit" size="lg" block loading={propose.isPending || !account.backendReady} disabled={!url.trim() || !account.backendReady}>
            Propose
          </Button>
          {propose.error ? <ErrorNote message={propose.error instanceof ApiError ? propose.error.message : "The proposal failed."} /> : null}
        </form>
      )}
    </Sheet>
  );
}
