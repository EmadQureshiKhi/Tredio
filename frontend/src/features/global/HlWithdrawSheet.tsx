"use client";
import { useQueryClient } from "@tanstack/react-query";
import { APP_URL as HL_APP_URL, transferOutcome, type UserSignedAction, usdSendAction, withdrawAction } from "@tredio/hyperliquid";
import { Fingerprint } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button, ErrorNote, Field, Num, Row, Segmented, Sheet, Skeleton, TxStatus } from "@/components/ui";
import { portfolioKey } from "@/features/portfolio/keys";
import { useHlAccount } from "@/features/trend/data";
import { AmountField, confirmNote, Note, PasskeyOnly } from "@/features/trend/ticket";
import { useAccount } from "@/lib/account/AccountProvider";
import { ApiSignIn } from "@/lib/account/ApiSignIn";
import { parseAmount } from "@/lib/amount";
import { deposits } from "@/lib/api";
import { TxFailed } from "@/lib/chain/outcome";
import { HL_NETWORK, IS_MAINNET } from "@/lib/config";
import { shortAddress, tokenAmount, tokenNumber } from "@/lib/format";
import { type HlRoute, INTENTS_MIN_DEPOSIT, INTENTS_USD_SEND_SURCHARGE, intentsSendAmount, routeFee, signTransfer, transferPlan } from "@/lib/trade/hyperliquid";
import { useTx } from "@/lib/trade/useTx";

/**
 * USDC out of the account's Hyperliquid balance. No session may move it: the passkey approves one
 * `mpc_sign` owner request over the transfer's EIP-712 digest, the relayer submits it, the account's
 * Chain Signatures key signs, and the app posts the very same transfer to Hyperliquid.
 *
 * On mainnet the default goes back the way it came: to the account on NEAR through NEAR Intents
 * (a `usdSend` to a 1Click deposit address on Hyperliquid). NEAR Intents runs on mainnet only, so
 * testnet offers the bridge to Arbitrum Sepolia and sends to other Hyperliquid addresses.
 */

const ARBITRUM = IS_MAINNET ? "Arbitrum" : "Arbitrum Sepolia";
const ROUTES: ReadonlyArray<{ value: HlRoute; label: string }> = [
  ...(IS_MAINNET ? [{ value: "near" as const, label: "NEAR" }] : []),
  { value: "arbitrum", label: "Arbitrum" },
  { value: "hyperliquid", label: "Hyperliquid" },
];
const FIRST_ROUTE = ROUTES[0]!.value;
const TAKES: Record<HlRoute, string> = { near: "About a minute", arbitrum: "About five minutes", hyperliquid: "Seconds" };

/** What the last transfer did, for the note under the button. */
type Landed = { route: HlRoute; receive: bigint; to: string };

export function HlWithdrawSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const account = useAccount();
  const qc = useQueryClient();
  const passkey = account.kind === "passkey";
  const hl = useHlAccount(open && passkey ? account.address : undefined);
  const tx = useTx();
  const [route, setRoute] = useState<HlRoute>(FIRST_ROUTE);
  const [text, setText] = useState("");
  const [to, setTo] = useState("");
  const [landed, setLanded] = useState<Landed | null>(null);
  // Each opening starts a fresh form (adjusted while rendering, as the sheet cannot close mid-flight).
  const [shown, setShown] = useState(open);
  if (open !== shown) {
    setShown(open);
    if (open) {
      setRoute(FIRST_ROUTE);
      setText("");
      setTo("");
      setLanded(null);
      tx.reset();
    }
  }

  const state = hl.data?.state ?? null;
  const own = hl.data?.address ?? null;
  // Hyperliquid reports USD with six decimals; the epsilon keeps 0.57 from reading as 0.569999. No state: the address never held anything.
  const withdrawable = !hl.data ? null : state ? BigInt(Math.max(0, Math.floor(state.withdrawable * 1e6 + 1e-6))) : 0n;
  const inPositions = state ? Math.max(0, state.accountValue - state.withdrawable) : 0;
  const amount = parseAmount(text, 6);
  const check = transferPlan({ route, amount, withdrawable, destination: to, own });
  const amountError = text.trim() !== "" && amount === null ? "Enter an amount" : check.amountError;
  const plan = amountError ? null : check.plan;
  const fee = routeFee(route);
  const needsApi = route === "near" && !account.backendReady;
  const amountText = amount ? tokenAmount(amount, 6) : null;
  // What lands follows from the amount alone, so it shows before the address is in.
  const receive = plan?.receive ?? (amount !== null && !amountError && amount > fee ? amount - fee : null);
  const amountHint =
    route === "near"
      ? `At least ${tokenAmount(INTENTS_USD_SEND_SURCHARGE + INTENTS_MIN_DEPOSIT, 6)} USDC.`
      : route === "arbitrum"
        ? `More than ${tokenAmount(fee, 6)} USDC, which the bridge keeps.`
        : "Any amount up to what is free; it lands in that address's perps balance.";

  const submit = async () => {
    if (!plan || !own) return;
    setLanded(null);
    const label = route === "near" ? "Withdraw to NEAR" : route === "arbitrum" ? `Withdraw to ${ARBITRUM}` : "Send on Hyperliquid";
    const sentText = `${tokenAmount(plan.send, 6)} USDC`;
    let result: Landed | null = null;
    const r = await tx.run(
      async () => {
        let action: UserSignedAction;
        if (route === "near") {
          // NEAR Intents quotes what reaches it; the send adds the 1 USDC its `usdSend` intake keeps.
          const q = await deposits.quote({ direction: "from-hyperliquid", amount: (plan.send - INTENTS_USD_SEND_SURCHARGE).toString(), hyperliquidAddress: own });
          const depositAddress = q.deposit?.depositAddress ?? q.quote.depositAddress;
          if (q.dry || !depositAddress) throw new Error("NEAR Intents opened no deposit address, so nothing was sent.");
          action = usdSendAction(HL_NETWORK, depositAddress, intentsSendAmount(q.quote.amountIn));
          result = { route, receive: BigInt(q.quote.amountOut), to: account.address ?? "" };
        } else {
          action = route === "arbitrum" ? withdrawAction(HL_NETWORK, to, plan.send) : usdSendAction(HL_NETWORK, to, plan.send);
          result = { route, receive: plan.receive, to: action.destination };
        }
        const { sent, answer } = await signTransfer(account.ownerExecute, action);
        const out = transferOutcome(answer);
        if (!out.ok) throw new TxFailed(`Hyperliquid refused it: ${out.error}`, sent.hash);
        return sent;
      },
      { action: label, done: route === "near" ? `Sent ${sentText} to NEAR Intents` : route === "arbitrum" ? `Withdrew ${sentText} to ${ARBITRUM}` : `Sent ${sentText} on Hyperliquid`, pending: confirmNote(account.kind, true) },
    );
    if (r) {
      setLanded(result);
      setText("");
      void qc.invalidateQueries({ queryKey: ["hl-account"] });
      void qc.invalidateQueries({ queryKey: portfolioKey(account.address) }, { cancelRefetch: false });
      if (route === "near") void qc.invalidateQueries({ queryKey: ["deposits"] });
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Withdraw from Hyperliquid" description="USDC leaves your account's Hyperliquid balance, signed by its own NEAR Chain Signatures key." testId="hl-withdraw-sheet" busy={tx.busy}>
      {account.status === "loading" ? (
        <Skeleton className="h-40 rounded-2xl" />
      ) : !account.authenticated ? (
        <Button block size="lg" onClick={account.login}>
          Sign in to withdraw
        </Button>
      ) : !passkey ? (
        <PasskeyOnly>
          Hyperliquid transfers come from a passkey account&rsquo;s own Chain Signatures key, which its account contract signs with only when the passkey approves. A NEAR wallet has neither, so move USDC out of Hyperliquid from a passkey account.
        </PasskeyOnly>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="rounded-2xl border border-line bg-surface-2 p-4">
            <p className="text-[12.5px] text-text-3">Free to withdraw</p>
            <p className="num-display mt-1 font-display text-[34px] leading-none text-text">
              <Num value={withdrawable === null ? null : tokenNumber(withdrawable, 6)} testId="hl-withdrawable" /> <span className="font-sans text-[15px] text-text-3">USDC</span>
            </p>
            {own ? (
              <p className="mt-2 text-[12px] text-text-3">
                From{" "}
                <a href={`${HL_APP_URL[HL_NETWORK]}/explorer/address/${own}`} target="_blank" rel="noreferrer" className="num font-mono text-text-2 underline-offset-4 hover:text-text hover:underline">
                  {shortAddress(own)}
                </a>{" "}
                on Hyperliquid{IS_MAINNET ? "" : " testnet"}
                {inPositions >= 0.005 ? `, with ${tokenAmount(BigInt(Math.floor(inPositions * 1e6)), 6)} USDC more backing open positions` : ""}
              </p>
            ) : null}
          </div>
          {hl.error ? <ErrorNote message="Your Hyperliquid balance could not load." onRetry={() => void hl.refetch()} /> : null}
          {withdrawable === 0n ? <Note>{inPositions >= 0.005 ? "Nothing is free to withdraw: all of it backs open positions. Closing one frees its margin." : "This Hyperliquid address holds no USDC to withdraw."}</Note> : null}
          <Segmented
            label="Withdraw to"
            value={route}
            onChange={(v) => {
              setRoute(v);
              setLanded(null);
              tx.reset();
            }}
            options={ROUTES}
          />
          <AmountField label="Amount" unit="USDC" value={text} onChange={setText} balance={withdrawable ?? undefined} decimals={6} error={amountError} hint={amountHint} testId="hl-withdraw-amount" />
          {route === "near" ? null : (
            <Field
              label={route === "arbitrum" ? `Address on ${ARBITRUM}` : "Hyperliquid address"}
              placeholder="0x..."
              autoComplete="off"
              spellCheck={false}
              value={to}
              onChange={(e) => setTo(e.target.value.trim())}
              error={check.destinationError}
              hint="Where the USDC arrives. Double-check it: transfers cannot be reversed."
              reserveNote
              data-testid="hl-withdraw-destination"
            />
          )}
          <div className="flex flex-col gap-2 rounded-xl border border-line px-3.5 py-3">
            {route === "near" ? <Row label="Arrives in" value={`${shortAddress(account.address)} on NEAR`} /> : null}
            <Row label={route === "near" ? "NEAR Intents keeps" : route === "arbitrum" ? "Bridge fee" : "Fee"} value={fee === 0n ? "None" : `${tokenAmount(fee, 6)} USDC`} tone="muted" />
            <Row label="Arrives" value={receive !== null ? `${fee === 0n ? "" : "About "}${tokenAmount(receive, 6)} USDC` : "-"} />
            <Row label="Takes" value={TAKES[route]} tone="muted" />
          </div>
          {needsApi ? <ApiSignIn purpose="to get a NEAR Intents quote" /> : null}
          <Button block size="lg" disabled={!plan || !own || needsApi} loading={tx.busy} onClick={() => void submit()} icon={<Fingerprint className="size-[18px]" aria-hidden />} data-testid="hl-withdraw-submit">
            {route === "hyperliquid" ? `Send${amountText ? ` ${amountText} USDC` : ""}` : `Withdraw${amountText ? ` ${amountText} USDC` : ""} to ${route === "near" ? "NEAR" : "Arbitrum"}`}
          </Button>
          <TxStatus tx={tx} filledLabel="Signed" testId="hl-withdraw-tx" />
          {landed && tx.stage !== "failed" ? (
            <p className="num rounded-xl bg-up-soft px-3.5 py-2.5 text-[13px] leading-5 text-text" role="status" data-testid="hl-withdraw-result">
              {landed.route === "near" ? (
                <>
                  Hyperliquid took it. About {tokenAmount(landed.receive, 6)} USDC reaches your account on NEAR in a minute or so;{" "}
                  <Link href="/deposit" className="font-strong text-primary underline-offset-4 hover:underline" onClick={() => onOpenChange(false)}>
                    follow it
                  </Link>
                  .
                </>
              ) : landed.route === "arbitrum" ? (
                `Hyperliquid took it. About ${tokenAmount(landed.receive, 6)} USDC reaches ${shortAddress(landed.to)} on ${ARBITRUM} in about five minutes.`
              ) : (
                `Sent. ${tokenAmount(landed.receive, 6)} USDC is in ${shortAddress(landed.to)}'s Hyperliquid balance.`
              )}
            </p>
          ) : null}
          <Note>
            Your passkey approves this one transfer: your account contract asks NEAR&rsquo;s MPC network to sign it for your Hyperliquid address, and the app posts it to Hyperliquid. Trading sessions cannot move USDC out.
            {IS_MAINNET ? "" : " On mainnet the default sends it back to your account on NEAR through NEAR Intents, which runs on mainnet only."}
          </Note>
        </div>
      )}
    </Sheet>
  );
}
