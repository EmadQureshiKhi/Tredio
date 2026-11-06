"use client";
import { ArrowDown, ArrowUp, Clock } from "lucide-react";
import Link from "next/link";
import { AnimatePresence, m } from "framer-motion";
import { useState } from "react";
import { Badge, Button, Delta, Field, listItem, Row, Sheet, TxStatus } from "@/components/ui";
import { useBook, useFairUp } from "@/features/trend/data";
import { confirmNote } from "@/features/trend/ticket";
import { useAccount } from "@/lib/account/AccountProvider";
import { cents, countdown, points, usdc } from "@/lib/format";
import { session, TAKER_FEE_BPS } from "@/lib/trade/calls";
import { anchoredLimit, mid, minimumOut, quoteSell } from "@/lib/trade/math";
import { useTx } from "@/lib/trade/useTx";
import { trendName } from "@/lib/trends";
import { type OutcomeHolding, useRefreshPortfolio } from "./hooks";
import { toUsdc, winningsRaw } from "./math";
import { amountText, Figure, parseAmount, SectionCard, SignedUsdc, signedPct, toneOf, tokens, useNow, windowShort } from "./parts";

const SLIPPAGE_BPS = 100;
const DECIMALS = 6;

/** UP and DOWN tokens, one block per series: what is held, what it is worth, and what can be done. */
export function OutcomeSection({ holdings, total }: { holdings: OutcomeHolding[]; total: number | null }) {
  const [selling, setSelling] = useState<{ holding: OutcomeHolding; side: "up" | "down" } | null>(null);
  const sorted = [...holdings].sort((a, b) => (a.phase === "settled" ? 0 : 1) - (b.phase === "settled" ? 0 : 1) || a.expiry - b.expiry);
  return (
    <>
      {holdings.length > 0 ? (
        <SectionCard id="outcomes-title" testId="outcome-section" title="Up or down" count={holdings.length} subtitle="Outcome tokens on each trend's attention. A pair of UP and DOWN always redeems for 1 USDC; each winning token pays 1 USDC at settlement and each losing token nothing." total={total === null ? "-" : usdc(total)}>
          <ul className="relative divide-y divide-line border-t border-line">
            <AnimatePresence initial={false} mode="popLayout">
              {sorted.map((h) => (
                <m.li key={h.series} {...listItem}>
                  <OutcomeRow h={h} onSell={(side) => setSelling({ holding: h, side })} />
                </m.li>
              ))}
            </AnimatePresence>
          </ul>
        </SectionCard>
      ) : null}
      {/* The sheet stays mounted when the last row goes, so a finished trade keeps its result on screen. */}
      <SellOutcomeSheet target={selling} onClose={() => setSelling(null)} />
    </>
  );
}

function PhaseBadge({ h, now }: { h: OutcomeHolding; now: number }) {
  if (h.phase === "open") {
    return (
      <Badge icon={<Clock className="size-3" aria-hidden />}>
        <span className="num">{countdown(h.expiry, now)}</span>
      </Badge>
    );
  }
  if (h.phase === "settling") return <Badge tone="warn">Settling</Badge>;
  if (h.outcome === "void") return <Badge>Void</Badge>;
  return <Badge tone={h.outcome === "up" ? "up" : "down"}>{h.outcome === "up" ? "UP won" : "DOWN won"}</Badge>;
}

function OutcomeRow({ h, onSell }: { h: OutcomeHolding; onSell: (side: "up" | "down") => void }) {
  const account = useAccount();
  const now = useNow();
  const refresh = useRefreshPortfolio();
  const redeem = useTx();
  const name = h.trendInfo ? trendName(h.trendInfo) : h.trend;
  const current = h.trendInfo?.index ?? null;
  const shownIndex = h.settlementIndex ?? current;
  const move = shownIndex !== null && h.openingIndex > 0 ? ((shownIndex - h.openingIndex) / h.openingIndex) * 100 : null;
  const payout = winningsRaw(h.outcome, h.up, h.down);
  const settled = h.phase === "settled";
  const tradable = h.phase === "open" && h.listed;

  const runRedeemSets = async () => {
    const sets = h.sets;
    if (await redeem.run(() => account.trade(session.redeemSets(h.series, sets)), { action: "Redeem sets", done: `Redeemed ${tokens(sets)} ${sets === 1_000_000n ? "set" : "sets"} for ${usdc(toUsdc(sets))} USDC`, pending: confirmNote(account.kind, false) })) refresh();
  };
  const runRedeemWinnings = async () => {
    const paid = payout;
    if (await redeem.run(() => account.trade(session.redeemWinnings(h.series, h.up, h.down)), { action: "Redeem winnings", done: paid > 0n ? `Redeemed ${usdc(toUsdc(paid))} USDC of winnings` : "Cleared the losing tokens", pending: confirmNote(account.kind, false) })) refresh();
  };

  return (
    <div className="flex flex-col gap-3.5 px-4 py-4 sm:px-6" data-testid="outcome-row" data-series={h.series}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Link href={`/t/${h.trend}`} className="truncate font-strong text-[15px] leading-6 text-text underline-offset-4 hover:underline">
              {name}
            </Link>
            <Badge tone="primary">{windowShort(h.window)}</Badge>
            <PhaseBadge h={h} now={now} />
          </div>
          <p className="num mt-1 text-[12.5px] leading-5 text-text-2">
            Opened at {points(h.openingIndex)}
            {shownIndex !== null ? (
              <>
                <span className="text-text-3"> · {h.settlementIndex !== null ? "settled at" : "now"} </span>
                {points(shownIndex)} <Delta value={move} className="text-[12px]" digits={1} />
              </>
            ) : null}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="num font-strong text-[15px] leading-6 text-text">{h.value === null ? "-" : usdc(h.value)}</p>
          <p className="text-[11.5px] text-text-3">{h.value === null ? "no price yet" : "USDC"}</p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {(["up", "down"] as const).map((side) => {
          const bal = side === "up" ? h.up : h.down;
          if (bal === 0n) return null;
          const midPrice = side === "up" ? h.upMid : h.downMid;
          const won = h.outcome === "open" ? null : h.outcome === "void" ? 0.5 : (h.outcome === "up") === (side === "up") ? 1 : 0;
          const priceText = won !== null ? usdc(won) : midPrice === null ? "-" : cents(midPrice);
          const cost = side === "up" ? h.cost.up : h.cost.down;
          const at = won ?? midPrice;
          const entry = cost !== null && bal > 0n ? { average: Number(cost) / Number(bal), pnl: at === null ? null : toUsdc(bal) * at - toUsdc(cost) } : null;
          return (
            <div key={side} className="grid grid-cols-[72px_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 rounded-xl bg-surface-2/70 px-3 py-2 sm:grid-cols-[84px_150px_150px_minmax(0,1fr)_auto]" data-testid={`holding-${side}`}>
              <Badge tone={side === "up" ? "up" : "down"} icon={side === "up" ? <ArrowUp className="size-3" aria-hidden /> : <ArrowDown className="size-3" aria-hidden />} className="justify-self-start">
                {side === "up" ? "UP" : "DOWN"}
              </Badge>
              <Figure label="Tokens">
                <span data-testid={`balance-${side}`}>{tokens(bal)}</span>
              </Figure>
              <Figure label={won !== null ? "Pays" : "Mid"}>{priceText}</Figure>
              <Figure label={entry ? "Entry and PnL" : "Entry"} className="order-last col-span-full sm:order-none sm:col-span-1">
                {entry ? (
                  <>
                    {cents(entry.average)}{" "}
                    {entry.pnl !== null ? (
                      <span className={toneOf(entry.pnl)} data-testid="outcome-pnl">
                        <SignedUsdc value={entry.pnl} /> <span className="font-sans text-[12px]">({signedPct((entry.pnl / Math.max(toUsdc(cost!), 1e-9)) * 100)})</span>
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="font-sans text-[12.5px] font-normal text-text-3" data-testid="outcome-entry-missing">
                    Not indexed yet
                  </span>
                )}
              </Figure>
              {tradable ? (
                <Button size="sm" tone="secondary" onClick={() => onSell(side)} disabled={redeem.busy} data-testid={`sell-${side}`}>
                  Sell
                </Button>
              ) : (
                <span />
              )}
            </div>
          );
        })}
      </div>

      {h.sets > 0n || settled ? (
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[12.5px] leading-5 text-text-2">
            {settled
              ? payout > 0n
                ? `Redeem ${tokens(h.up + h.down)} tokens for ${usdc(toUsdc(payout))} USDC.`
                : "These tokens lost. Clearing them tidies the portfolio and pays nothing."
              : `${tokens(h.sets)} complete ${h.sets === 1_000_000n ? "set" : "sets"} (one UP and one DOWN) redeem for ${usdc(toUsdc(h.sets))} USDC at any time.`}
          </p>
          {settled ? (
            <Button size="sm" tone={payout > 0n ? "primary" : "ghost"} onClick={runRedeemWinnings} loading={redeem.busy} disabled={redeem.stage === "filled" || redeem.stage === "final"} data-testid="redeem-winnings" className="shrink-0">
              {payout > 0n ? `Redeem ${usdc(toUsdc(payout))}` : "Clear"}
            </Button>
          ) : (
            <Button size="sm" tone="secondary" onClick={runRedeemSets} loading={redeem.busy} data-testid="redeem-sets" className="shrink-0">
              Redeem {tokens(h.sets)} {h.sets === 1_000_000n ? "set" : "sets"}
            </Button>
          )}
        </div>
      ) : null}
      {h.phase === "settling" ? <p className="text-[12.5px] leading-5 text-text-3">The series ended. The oracle records the closing index and the keeper settles it within a few minutes, then winnings redeem here.</p> : null}
      <TxStatus tx={redeem} filledLabel={settled ? "Redeemed" : "Sets redeemed"} testId="redeem-tx" />
    </div>
  );
}

function SellOutcomeSheet({ target, onClose }: { target: { holding: OutcomeHolding; side: "up" | "down" } | null; onClose: () => void }) {
  // Keep the last target while the sheet animates out.
  const [last, setLast] = useState(target);
  if (target && target !== last) setLast(target);
  const t = target ?? last;
  return (
    <Sheet
      open={target !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t ? `Sell ${t.side === "up" ? "UP" : "DOWN"}` : "Sell"}
      description={t ? `${t.holding.trendInfo ? trendName(t.holding.trendInfo) : t.holding.trend} · ${windowShort(t.holding.window)} series on Tredio's book` : undefined}
      testId="sell-outcome-sheet"
    >
      {t ? <SellOutcomeBody key={`${t.holding.series}-${t.side}`} h={t.holding} side={t.side} onDone={onClose} /> : null}
    </Sheet>
  );
}

function SellOutcomeBody({ h, side, onDone }: { h: OutcomeHolding; side: "up" | "down"; onDone: () => void }) {
  const account = useAccount();
  const refresh = useRefreshPortfolio();
  const tx = useTx();
  const balance = side === "up" ? h.up : h.down;
  const [text, setText] = useState(() => amountText(balance, DECIMALS));
  const amount = parseAmount(text, DECIMALS);
  const book = useBook(h.series, side);
  const fairUp = useFairUp(h);
  const fair = fairUp.data === null || fairUp.data === undefined ? null : side === "up" ? fairUp.data : 1 - fairUp.data;
  // Session sales fill only within 0.10 USDC of the attention-implied price.
  const quote = book.data && amount ? quoteSell(book.data, amount, TAKER_FEE_BPS, fair === null ? 1 : anchoredLimit(false, fair)) : null;
  const tooMuch = amount !== null && amount > balance;
  const done = tx.stage === "filled" || tx.stage === "final";
  const error = tooMuch ? "More than you hold." : quote && quote.filled === 0n ? "No bids within 0.10 of the attention-implied price right now." : null;
  const minOut = quote ? minimumOut(quote.out, SLIPPAGE_BPS) : 0n;
  const midNow = mid(book.data ?? null);

  const sell = async () => {
    if (!amount || !quote || minOut === 0n) return;
    const name = side === "up" ? "Up" : "Down";
    if (await tx.run(() => account.trade(session.swap(h.series, side, false, quote.filled, minOut)), { action: `Sell ${name}`, done: `Sold ${tokens(quote.filled)} ${name}`, pending: confirmNote(account.kind, false) })) refresh();
  };

  return (
    <div className="flex flex-col gap-5">
      <Field
        label="Amount"
        inputMode="decimal"
        autoComplete="off"
        value={text}
        onChange={(e) => setText(e.target.value.replace(/[^\d.,]/g, ""))}
        suffix={side === "up" ? "UP" : "DOWN"}
        error={error}
        disabled={tx.busy || done}
        data-testid="sell-amount"
        action={
          <button type="button" onClick={() => setText(amountText(balance, DECIMALS))} disabled={tx.busy || done} className="num text-[12px] text-text-3 transition-colors enabled:hover:text-text">
            Holding {tokens(balance)} <span className="ml-1 font-strong text-primary">Max</span>
          </button>
        }
      />
      <div className="flex flex-col gap-2.5 rounded-2xl border border-line p-4">
        <Row label="You receive about" value={quote ? `${usdc(toUsdc(quote.out))} USDC` : book.isLoading ? "..." : "-"} />
        <Row label="Average price" value={quote && quote.filled > 0n ? cents(quote.averagePrice) : "-"} />
        <Row label="Mid now" value={midNow === null ? "-" : cents(midNow)} tone="muted" />
        <Row label="Attention-implied price" value={fair === null ? "-" : cents(fair)} tone="muted" />
        <Row label="Least you accept (1% slippage)" value={quote ? `${usdc(toUsdc(minOut))} USDC` : "-"} tone="muted" />
      </div>
      {quote && !quote.complete && quote.filled > 0n ? (
        <p className="rounded-xl bg-warn-soft px-3.5 py-2.5 text-[12.5px] leading-[18px] text-text">Only {tokens(quote.filled)} sells within 0.10 of the implied price right now, so that is what this sends. Place a limit order on the trend&rsquo;s page for the rest.</p>
      ) : null}
      {done ? (
        <Button block size="lg" tone="secondary" onClick={onDone}>
          Done
        </Button>
      ) : (
        <Button block size="lg" onClick={sell} loading={tx.busy} disabled={!amount || tooMuch || !quote || quote.filled === 0n || minOut === 0n} data-testid="confirm-sell">
          {quote && quote.filled > 0n ? `Sell ${tokens(quote.filled)} ${side === "up" ? "UP" : "DOWN"}` : "Sell"}
        </Button>
      )}
      <TxStatus tx={tx} filledLabel="Sold" testId="sell-tx" />
    </div>
  );
}
