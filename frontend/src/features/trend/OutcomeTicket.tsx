"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { OrderSpec, Side as ChainSide } from "@tredio/contracts";
import { ChevronDown, Clock, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimateHeight, Button, cn, Empty, ErrorNote, Field, Num, Row, Segmented, TxStatus } from "@/components/ui";
import { portfolioKey } from "@/features/portfolio/keys";
import { useAccount } from "@/lib/account/AccountProvider";
import { history, type Trend } from "@/lib/api";
import { DEPLOYMENT } from "@/lib/config";
import { cents, countdown, points, tokenAmount, tokenNumber, usdc } from "@/lib/format";
import { useUsdcBalance } from "@/lib/hooks/queries";
import { pulse, revealInPanel } from "@/lib/scroll";
import { limitBuyFunds, owner, ownerCall, session, storage, TAKER_FEE_BPS } from "@/lib/trade/calls";
import { anchoredLimit, type BookSide, LOT, mid, minimumOut, parseAmount, quoteBuy, quoteSell, type Quote } from "@/lib/trade/math";
import { placedOrders, rememberOrders } from "@/lib/trade/orders";
import { isRegistered, type SeriesView } from "@/lib/trade/reads";
import { type TxLabels, useTx } from "@/lib/trade/useTx";
import { useBook, useBookBalances, useFairUp, useOpenOrders, useOutcomeBalances, useRegistryIndex, useSeries } from "./data";
import { AmountField, confirmNote, Note, Section, SubmitButton, useNow } from "./ticket";

/**
 * Up or down on a trend's attention: each series asks whether the index closes above where it
 * opened. UP and DOWN trade on Tredio's order book; a pair of one UP and one DOWN always mints and
 * redeems for exactly 1 USDC, and each winning token pays 1 USDC at settlement.
 *
 * Market trades go out from the trading session as anchored swaps: the book fills them only
 * within 0.10 USDC of the value the attention index implies, so a stolen session key cannot dump
 * the account's tokens into a book it controls. Limit orders rest on the book at any price, so the
 * passkey signs them.
 */

const DECIMALS = 6;
const SLIPPAGE_BPS = 100;
const WINDOW_LABEL: Record<number, string> = { 900: "15M", 86_400: "24H", 604_800: "7D" };
const label = (w: number) => WINDOW_LABEL[w] ?? `${Math.round(w / 60)}M`;

export type Side = ChainSide;
type Mode = "buy" | "sell";
type Kind = "market" | "limit";

/** The series a ticket offers, the 24 hour one first. */
/** Series with the 24-hour one first: it opens the ticket and leads the trade bar. */
export const orderSeries = (list: readonly SeriesView[]) => [...list].sort((a, b) => (a.window === 86_400 ? -1 : b.window === 86_400 ? 1 : a.window - b.window));

/** Cents, as the ticket shows a price: one decimal and a "c". */
export const CENTS = { format: { minimumFractionDigits: 1, maximumFractionDigits: 1 }, suffix: "c" } as const;

/** The best bid or ask of a book in USDC per token. */
export const best = (book: BookSide | null | undefined, side: "bid" | "ask") => {
  const level = side === "bid" ? book?.bids[0] : book?.asks[0];
  return level ? level.tick / 1000 : null;
};

export default function OutcomeTicket({ trend, initialSide = "up" }: { trend: Trend; initialSide?: Side }) {
  const series = useSeries(trend.id);
  const list = useMemo(() => orderSeries(series.data ?? []), [series.data]);
  const [picked, setPicked] = useState<number | null>(null);
  const current = list.find((s) => s.window === picked) ?? list[0];

  if (series.isLoading) return <div className="skeleton h-[420px]" />;
  if (!series.data && series.isError) return <ErrorNote message="NEAR did not answer, so this market could not load." onRetry={() => void series.refetch()} />;
  if (!current) {
    return <Empty className="py-10" icon={<Clock className="size-6" />} title="No series yet" body="The first Up or down series opens shortly after a trend lists. Check back in a minute." />;
  }
  return (
    <div className="flex flex-col gap-5">
      {list.length > 1 ? <Segmented label="Series window" size="sm" value={String(current.window)} onChange={(v) => setPicked(Number(v))} options={[...list].sort((a, b) => a.window - b.window).map((s) => ({ value: String(s.window), label: label(s.window) }))} /> : null}
      <SeriesBody key={current.series} trend={trend} series={current} initialSide={initialSide} />
    </div>
  );
}

function SeriesBody({ trend, series: s, initialSide }: { trend: Trend; series: SeriesView; initialSide: Side }) {
  const account = useAccount();
  const position = useRef<HTMLElement>(null);
  const [settled, setSettled] = useState(0);
  const now = useNow();
  const live = useRegistryIndex(trend.id);
  const holdings = useOutcomeBalances(account.address, s.series);
  const up = holdings.data?.up ?? 0n;
  const down = holdings.data?.down ?? 0n;
  const expired = now / 1000 >= s.expiry;
  const index = live.data?.index ?? trend.index;
  const above = index > s.openingIndex;

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-2xl bg-surface-2 px-4 py-3.5">
        <p className="font-strong text-[15px] leading-6 text-text">
          Will attention close above <span className="num">{points(s.openingIndex)}</span>?
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-text-2">
          <span className="flex items-center gap-1.5">
            <Clock className="size-3.5 text-text-3" aria-hidden />
            {expired ? "Closed" : <span className="num">Closes in {countdown(s.expiry, now)}</span>}
          </span>
          <span className="num">
            Now {points(index)} <span className={above ? "text-up" : "text-down"}>({above ? "above" : "at or below"})</span>
          </span>
        </div>
      </div>
      {s.outcome !== "open" ? (
        <Settled series={s} up={up} down={down} />
      ) : expired ? (
        <Note>This series has closed. It settles as soon as the oracle records the closing reading and the keeper settles it, usually within a few minutes; then winnings redeem here.</Note>
      ) : (
        <Trade trend={trend} series={s} up={up} down={down} fresh={live.data?.fresh ?? true} initialSide={initialSide} onFilled={() => revealInPanel(position.current)} onFinal={() => setSettled((n) => n + 1)} />
      )}
      {account.authenticated && s.outcome === "open" && !expired ? <Pairs series={s} up={up} down={down} sectionRef={position} settled={settled} /> : null}
      {account.authenticated ? <BookFunds series={s} /> : null}
    </div>
  );
}

/** Calls `fn` once each time the transaction reaches `stage`. */
function useOnStage(stage: string, at: string, fn: () => void) {
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  });
  useEffect(() => {
    if (stage === at) latest.current();
  }, [stage, at]);
}

const toTick = (centsText: string) => {
  const v = Number(centsText.replace(/,/g, "."));
  return Number.isFinite(v) && v > 0 ? Math.round(v * 10) : null;
};

function Trade({ trend, series: s, up, down, fresh, initialSide, onFilled, onFinal }: { trend: Trend; series: SeriesView; up: bigint; down: bigint; fresh: boolean; initialSide: Side; onFilled: () => void; onFinal: () => void }) {
  const account = useAccount();
  const client = useQueryClient();
  const balance = useUsdcBalance(account.address);
  const upBook = useBook(s.listed ? s.series : undefined, "up");
  const downBook = useBook(s.listed ? s.series : undefined, "down");
  const fairUp = useFairUp(s);
  const [kind, setKind] = useState<Kind>("market");
  const [mode, setMode] = useState<Mode>("buy");
  const [side, setSide] = useState<Side>(initialSide);
  const [text, setText] = useState("");
  const [limitText, setLimitText] = useState("");
  const tx = useTx();
  useOnStage(tx.stage, "filled", onFilled);
  useOnStage(tx.stage, "final", onFinal);

  const book = side === "up" ? upBook.data : downBook.data;
  const held = side === "up" ? up : down;
  const sideName = side === "up" ? "Up" : "Down";
  const fair = fairUp.data === null || fairUp.data === undefined ? null : side === "up" ? fairUp.data : 1 - fairUp.data;
  const buy = mode === "buy";
  const anchor = fair === null ? (buy ? 999 : 1) : anchoredLimit(buy, fair);

  // Market: USDC in for a buy, tokens in for a sell. Limit: tokens either way, at the price given.
  const raw = parseAmount(text, DECIMALS);
  const amount = raw === null ? null : kind === "limit" || !buy ? raw - (raw % LOT) : raw;
  const quote: Quote | null = kind === "market" && amount && book ? (buy ? quoteBuy(book, amount, TAKER_FEE_BPS, anchor) : quoteSell(book, amount, TAKER_FEE_BPS, anchor)) : null;
  const unbounded: Quote | null = kind === "market" && amount && book ? (buy ? quoteBuy(book, amount, TAKER_FEE_BPS) : quoteSell(book, amount, TAKER_FEE_BPS)) : null;
  const tick = toTick(limitText);
  const limitFunds = kind === "limit" && amount && tick ? (buy ? limitBuyFunds(amount, tick) : amount) : null;
  const spendable = buy ? (balance.data?.raw ?? null) : held;

  const error = (() => {
    if (text.trim() === "") return null;
    if (amount === null || amount === 0n) return !buy || kind === "limit" ? "At least 0.001" : "Enter an amount";
    if (kind === "limit") {
      if (tick === null || tick < 1 || tick > 999) return null;
      if (account.authenticated && buy && balance.data && limitFunds !== null && limitFunds > balance.data.raw) return `Needs ${usdc(Number(limitFunds) / 1e6)} USDC`;
      if (account.authenticated && !buy && amount > held) return `You hold ${tokenAmount(held, DECIMALS)}`;
      return null;
    }
    if (account.authenticated && spendable !== null && amount > spendable) return buy ? "More than your USDC balance" : `You hold ${tokenAmount(held, DECIMALS)}`;
    if (quote && quote.out === 0n) return unbounded && unbounded.out > 0n ? "Nothing rests within 0.10 of the attention-implied price" : "The book has nothing to fill this right now";
    if (quote && !quote.complete) return `Only ${buy ? `${usdc(Number(quote.filled) / 1e6)} USDC` : tokenAmount(quote.filled, DECIMALS)} fills within 0.10 of the implied price right now`;
    return null;
  })();
  const limitError = kind === "limit" && limitText.trim() !== "" && (tick === null || tick < 1 || tick > 999) ? "Between 0.1c and 99.9c" : null;

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["outcome-balances"] });
    void client.invalidateQueries({ queryKey: ["usdc"] });
    void client.invalidateQueries({ queryKey: ["book"] });
    void client.invalidateQueries({ queryKey: ["book-balances"] });
    void client.invalidateQueries({ queryKey: ["open-orders"] });
    void client.invalidateQueries({ queryKey: portfolioKey(account.address) });
  };

  const submitMarket = async () => {
    if (!amount || !quote || !account.address) return;
    const labels: TxLabels = buy
      ? { action: `Buy ${sideName}`, done: `Bought ${tokenAmount(quote.out, DECIMALS)} ${sideName} for ${usdc(Number(quote.filled) / 1e6)} USDC`, pending: confirmNote(account.kind, false) }
      : { action: `Sell ${sideName}`, done: `Sold ${tokenAmount(quote.filled, DECIMALS)} ${sideName}`, pending: confirmNote(account.kind, false) };
    const r = await tx.run(() => account.trade(session.swap(s.series, side, buy, buy ? amount : quote.filled, minimumOut(quote.out, SLIPPAGE_BPS))), labels);
    if (r) {
      setText("");
      refresh();
    }
  };

  const submitLimit = async () => {
    if (!amount || !tick || !account.address) return;
    const spec: OrderSpec = { series: s.series, side, dir: mode, tick, size: amount.toString(), tif: "gtc" };
    const registered = await isRegistered(DEPLOYMENT.contracts.book, account.address);
    const actions = [...(registered ? [] : [ownerCall(storage.book(account.address))]), ownerCall(owner.limitOrder(spec))];
    const r = await tx.run(() => account.ownerExecute(actions), {
      action: `${buy ? "Buy" : "Sell"} ${sideName} at ${cents(tick / 1000)}`,
      done: `Limit ${buy ? "buy" : "sell"} placed: ${tokenAmount(amount, DECIMALS)} ${sideName} at ${cents(tick / 1000)}`,
      pending: confirmNote(account.kind, true),
    });
    if (r) {
      rememberOrders(account.address, placedOrders(r.outcome, account.address));
      setText("");
      refresh();
    }
  };

  if (!s.listed) return <Note>The book is listing this series. Trading starts within a minute or two; meanwhile you can mint pairs below.</Note>;

  const sidePrice = (x: Side) => best(x === "up" ? upBook.data : downBook.data, buy ? "ask" : "bid");
  const payout = quote && buy ? Number(quote.out) / 1e6 : null;
  const spent = quote && buy ? Number(quote.filled) / 1e6 : null;
  const reset = () => {
    setText("");
    tx.reset();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <Segmented
          label="Buy or sell"
          value={mode}
          onChange={(m) => {
            setMode(m);
            reset();
          }}
          options={[
            { value: "buy", label: "Buy" },
            { value: "sell", label: "Sell" },
          ]}
        />
        <Segmented
          label="Order type"
          value={kind}
          onChange={(k) => {
            setKind(k);
            reset();
            if (k === "limit" && !limitText) {
              const p = sidePrice(side) ?? fair;
              if (p !== null) setLimitText((p * 100).toFixed(1));
            }
          }}
          options={[
            { value: "market", label: "Market" },
            { value: "limit", label: "Limit" },
          ]}
          className="w-[164px]"
        />
      </div>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Side">
        {(["up", "down"] as const).map((x) => {
          const p = sidePrice(x);
          const active = side === x;
          return (
            <button
              key={x}
              type="button"
              role="radio"
              aria-checked={active}
              data-testid={`outcome-side-${x}`}
              onClick={() => {
                setSide(x);
                tx.reset();
              }}
              className={cn("flex flex-col items-start rounded-2xl border px-4 py-3 text-left transition-colors", active ? (x === "up" ? "border-up bg-up-soft" : "border-down bg-down-soft") : "border-line bg-surface-2 hover:border-line-strong")}
            >
              <span className={cn("font-strong text-[13px]", x === "up" ? "text-up" : "text-down")}>{x === "up" ? "Up" : "Down"}</span>
              <span className="num-display mt-0.5 font-display text-[26px] leading-tight text-text">
                <Num value={p === null ? null : p * 100} {...CENTS} />
              </span>
              <span className="text-[11.5px] text-text-3">{buy ? "to buy" : "to sell"}</span>
            </button>
          );
        })}
      </div>
      {kind === "limit" ? (
        <Field label={`Price per ${sideName}`} suffix="c" inputMode="decimal" autoComplete="off" placeholder="50.0" value={limitText} onChange={(e) => setLimitText(e.target.value.replace(/[^\d.,]/g, ""))} error={limitError} hint="Rests on the book until it fills or you cancel it." data-testid="outcome-limit-price" />
      ) : null}
      <AmountField
        label={kind === "limit" ? `${sideName} to ${buy ? "buy" : "sell"}` : buy ? "You pay" : `${sideName} to sell`}
        unit={kind === "market" && buy ? "USDC" : sideName}
        value={text}
        onChange={(v) => {
          setText(v);
          if (tx.stage !== "pending") tx.reset();
        }}
        balance={account.authenticated ? (kind === "limit" && buy ? undefined : spendable) : undefined}
        decimals={DECIMALS}
        error={error}
        testId="outcome-amount"
      />
      <div className="flex flex-col gap-2 rounded-xl border border-line px-3.5 py-3">
        {kind === "limit" ? (
          <>
            <Row label={buy ? "Moves into the book" : "Tokens into the book"} value={limitFunds !== null ? (buy ? `${usdc(Number(limitFunds) / 1e6)} USDC` : `${tokenAmount(limitFunds, DECIMALS)} ${sideName}`) : "-"} />
            <Row label={buy ? `Pays if ${sideName} wins` : "You receive when filled"} value={amount && tick ? (buy ? `${usdc(Number(amount) / 1e6)} USDC` : `${usdc((Number(amount) / 1e6) * (tick / 1000) * (1 - Number(TAKER_FEE_BPS) / 10_000))} USDC or more`) : "-"} />
            <Row label="Attention-implied price" value={fair !== null ? cents(fair) : "-"} tone="muted" />
          </>
        ) : buy ? (
          <>
            <Row label={`${sideName} you get`} value={quote ? tokenAmount(quote.out, DECIMALS) : "-"} />
            <Row label="Average price" value={quote && quote.out > 0n ? cents(quote.averagePrice) : "-"} />
            <Row label={`Pays if ${sideName} wins`} value={payout !== null && spent ? `${usdc(payout)} USDC (${payout >= spent ? "+" : ""}${(((payout - spent) / spent) * 100).toFixed(0)}%)` : "-"} tone={payout !== null ? "up" : undefined} />
            <Row label="Most you can lose" value={spent !== null ? `${usdc(spent)} USDC` : "-"} tone="muted" />
          </>
        ) : (
          <>
            <Row label="You receive" value={quote ? `${usdc(Number(quote.out) / 1e6)} USDC` : "-"} />
            <Row label="Average price" value={quote && quote.filled > 0n ? cents(quote.averagePrice) : "-"} />
          </>
        )}
        {kind === "market" ? <Row label="Fills within" value={fair !== null ? `${cents(Math.max(0, fair - 0.1))} to ${cents(Math.min(1, fair + 0.1))}` : "0.10 of the implied price"} tone="muted" /> : null}
        <Row label={kind === "market" ? "Fee and slippage limit" : "Taker fee if it crosses"} value={kind === "market" ? `${Number(TAKER_FEE_BPS) / 100}% · 1%` : `${Number(TAKER_FEE_BPS) / 100}%`} tone="muted" />
      </div>
      {kind === "market" && !fresh ? <Note tone="warn">The attention index is between reports, so market trades wait for the next one, usually within a minute. Limit orders still rest on the book.</Note> : null}
      {kind === "market" && quote && !quote.complete && quote.out > 0n ? (
        <button type="button" onClick={() => setKind("limit")} className="self-start text-[12.5px] font-strong text-primary underline-offset-4 hover:underline">
          Place a limit order for the rest instead
        </button>
      ) : null}
      {kind === "limit" ? <Note>Limit orders rest on Tredio&rsquo;s book at your price, so {account.kind === "wallet" ? "your wallet" : "your passkey"} signs each one. Filled tokens and unused USDC stay in the book until you withdraw them below.</Note> : null}
      {kind === "market" ? (
        <SubmitButton tone={side === "up" ? "up" : "down"} disabled={!quote || Boolean(error) || quote.out === 0n || !fresh} loading={tx.busy} onClick={() => void submitMarket()} testId="outcome-submit" passkey={account.kind === "wallet"}>
          {buy ? `Buy ${sideName}` : `Sell ${sideName}`}
          {amount && buy ? ` for ${usdc(Number(amount) / 1e6)} USDC` : ""}
        </SubmitButton>
      ) : (
        <SubmitButton tone={side === "up" ? "up" : "down"} disabled={!amount || !tick || tick < 1 || tick > 999 || Boolean(error)} loading={tx.busy} onClick={() => void submitLimit()} testId="outcome-limit-submit" passkey>
          {buy ? "Place limit buy" : "Place limit sell"}
          {tick && tick >= 1 && tick <= 999 ? ` at ${cents(tick / 1000)}` : ""}
        </SubmitButton>
      )}
      <TxStatus tx={tx} filledLabel={kind === "limit" ? "Placed" : buy ? "Bought" : "Sold"} testId="outcome-tx" />
      <Note>
        Each {sideName} token pays 1 USDC if attention closes {side === "up" ? "above" : "at or below"} {points(s.openingIndex)}, and nothing otherwise. Prices come from Tredio&rsquo;s order book on NEAR.
      </Note>
      {trend.status !== "active" ? <Note tone="warn">This trend is {trend.status}: new pairs cannot be minted, but the book stays open until the series closes.</Note> : null}
    </div>
  );
}

/** Complete sets: mint a pair for 1 USDC, or redeem a pair back for 1 USDC. */
function Pairs({ series: s, up, down, sectionRef, settled }: { series: SeriesView; up: bigint; down: bigint; sectionRef: React.RefObject<HTMLElement | null>; settled: number }) {
  const account = useAccount();
  const client = useQueryClient();
  const balance = useUsdcBalance(account.address);
  const upBook = useBook(s.listed ? s.series : undefined, "up");
  const downBook = useBook(s.listed ? s.series : undefined, "down");
  const costs = useQuery({ queryKey: [...portfolioKey(account.address), "history", "outcomes"], enabled: Boolean(account.address), refetchInterval: 30_000, retry: false, queryFn: () => history.outcomes(account.address!) });
  const row = costs.data?.holdings.find((h) => h.series === s.series);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const tx = useTx();
  const mintForm = useRef<HTMLDivElement>(null);
  const pairs = up < down ? up : down;
  const amount = parseAmount(text, DECIMALS);
  const tooMuch = amount !== null && balance.data !== undefined && amount > balance.data.raw;

  const run = async (action: Parameters<typeof account.trade>[0], labels: TxLabels) => {
    const r = await tx.run(() => account.trade(action), { ...labels, pending: confirmNote(account.kind, false) });
    if (r) {
      setText("");
      void client.invalidateQueries({ queryKey: ["outcome-balances"] });
      void client.invalidateQueries({ queryKey: ["usdc"] });
      void client.invalidateQueries({ queryKey: portfolioKey(account.address) });
    }
  };

  return (
    <Section
      ref={sectionRef}
      title="Your position"
      action={
        <button
          type="button"
          onClick={() => {
            if (!open) setTimeout(() => revealInPanel(mintForm.current), 280);
            setOpen((o) => !o);
          }}
          aria-expanded={open}
          className="flex items-center gap-1 text-[12.5px] text-text-3 transition-colors hover:text-text"
        >
          Pairs
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
        </button>
      }
      className="border-t border-line pt-5"
    >
      <div className="grid grid-cols-2 gap-2">
        <Holding label="Up" amount={up} tone="up" position={row ? BigInt(row.upPosition) : null} cost={row ? BigInt(row.upCostBasis) : null} price={mid(upBook.data)} settled={settled} />
        <Holding label="Down" amount={down} tone="down" position={row ? BigInt(row.downPosition) : null} cost={row ? BigInt(row.downCostBasis) : null} price={mid(downBook.data)} settled={settled} />
      </div>
      {pairs > 0n ? (
        <Button tone="secondary" block loading={tx.busy} onClick={() => void run(session.redeemSets(s.series, pairs), { action: "Redeem pairs", done: `Redeemed ${tokenAmount(pairs, DECIMALS)} pairs for ${usdc(Number(pairs) / 1e6)} USDC` })} data-testid="redeem-pairs">
          Redeem {tokenAmount(pairs, DECIMALS)} pairs for {usdc(Number(pairs) / 1e6)} USDC
        </Button>
      ) : null}
      <AnimateHeight className="-mt-3">
        {open ? (
          <div ref={mintForm} className="flex flex-col gap-3 pt-3">
            <AmountField label="Mint pairs" unit="USDC" value={text} onChange={setText} balance={balance.data?.raw ?? null} decimals={DECIMALS} error={tooMuch ? "More than your USDC balance" : null} hint="Each USDC mints one Up and one Down. A pair always redeems for 1 USDC." testId="mint-amount" />
            <Button block tone="secondary" disabled={!amount || tooMuch} loading={tx.busy} onClick={() => amount && void run(session.mintSets(s.series, amount), { action: "Mint pairs", done: `Minted ${tokenAmount(amount, DECIMALS)} pairs` })} data-testid="mint-pairs">
              {amount ? `Mint ${tokenAmount(amount, DECIMALS)} pairs` : "Mint pairs"}
            </Button>
          </div>
        ) : null}
      </AnimateHeight>
      <TxStatus tx={tx} filledLabel="Done" testId="pairs-tx" />
    </Section>
  );
}

/** A side held: the amount, and its average cost and PnL when the indexer's book covers it (or its value). */
function Holding({ label, amount, tone, position, cost, price, settled }: { label: string; amount: bigint; tone: "up" | "down"; position: bigint | null; cost: bigint | null; price: number | null; settled: number }) {
  const tile = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (settled > 0) pulse(tile.current);
  }, [settled]);
  const covered = position !== null && cost !== null && position > 0n && position === amount;
  const average = covered ? Number(cost) / Number(position) : null;
  const pnl = covered && price !== null ? (Number(amount) / 1e6) * price - Number(cost) / 1e6 : null;
  return (
    <div ref={tile} className="rounded-xl bg-surface-2 px-3.5 py-2.5">
      <p className={cn("font-strong text-[12px]", tone === "up" ? "text-up" : "text-down")}>{label}</p>
      <p className="num mt-0.5 font-strong text-[16px] text-text">
        <Num value={tokenNumber(amount, DECIMALS)} testId={`holding-${label.toLowerCase()}`} />
      </p>
      <p className="num mt-0.5 truncate text-[11.5px] leading-4 text-text-3" data-testid={`entry-${label.toLowerCase()}`}>
        {amount === 0n ? (
          "None held"
        ) : average !== null ? (
          <>
            Avg {cents(average)}
            {pnl !== null ? (
              <>
                {" "}
                · <span className={pnl > 0.005 ? "text-up" : pnl < -0.005 ? "text-down" : undefined}>{usdc(pnl, { sign: true })}</span>
              </>
            ) : null}
          </>
        ) : price !== null ? (
          `Worth ${usdc((Number(amount) / 1e6) * price)}`
        ) : (
          "No price yet"
        )}
      </p>
    </div>
  );
}

/** What limit orders left in the book (fills and unused USDC), withdrawable by the session, and the orders still resting. */
function BookFunds({ series: s }: { series: SeriesView }) {
  const account = useAccount();
  const client = useQueryClient();
  const balances = useBookBalances(account.address, s.series);
  const orders = useOpenOrders(account.address);
  const mine = (orders.data ?? []).filter((o) => o.series === s.series);
  const withdraw = useTx();
  const cancel = useTx();
  const [cancelling, setCancelling] = useState<number | null>(null);
  const b = balances.data;
  const funds = b ? ([["usdc", b.usdc], ["up", b.up], ["down", b.down]] as const).filter(([, v]) => v > 0n) : [];
  if (mine.length === 0 && funds.length === 0) return null;
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["book-balances"] });
    void client.invalidateQueries({ queryKey: ["open-orders"] });
    void client.invalidateQueries({ queryKey: ["outcome-balances"] });
    void client.invalidateQueries({ queryKey: ["usdc"] });
  };
  const withdrawAll = async () => {
    for (const [asset, v] of funds) {
      const chainAsset = asset === "usdc" ? ("usdc" as const) : { token: { series: s.series, side: asset } };
      const r = await withdraw.run(() => account.trade(session.bookWithdraw(chainAsset, v)), {
        action: "Withdraw from the book",
        done: asset === "usdc" ? `Withdrew ${usdc(Number(v) / 1e6)} USDC` : `Withdrew ${tokenAmount(v, DECIMALS)} ${asset === "up" ? "Up" : "Down"}`,
        pending: confirmNote(account.kind, false),
      });
      if (!r) break;
    }
    refresh();
  };
  return (
    <Section title="On the book" className="border-t border-line pt-5">
      {mine.length > 0 ? (
        <ul className="flex flex-col gap-2" data-testid="open-orders">
          {mine.map((o) => (
            <li key={o.id} className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-3.5 py-2.5 text-[13px]">
              <span className="num min-w-0 truncate">
                <span className={o.dir === "buy" ? "text-up" : "text-down"}>{o.dir === "buy" ? "Buy" : "Sell"}</span> {tokenAmount(BigInt(o.remaining), DECIMALS)} {o.side === "up" ? "Up" : "Down"} at {cents(o.tick / 1000)}
              </span>
              <Button
                size="sm"
                tone="ghost"
                className="-my-1 shrink-0"
                icon={<Trash2 className="size-3.5" aria-hidden />}
                loading={cancel.busy && cancelling === o.id}
                disabled={cancel.busy}
                onClick={async () => {
                  setCancelling(o.id);
                  if (await cancel.run(() => account.ownerExecute([ownerCall(owner.cancelOrder(o.id))]), { action: "Cancel order", done: "Order cancelled", pending: confirmNote(account.kind, true) })) refresh();
                  setCancelling(null);
                }}
              >
                Cancel
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {funds.length > 0 ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-line px-3.5 py-2.5 text-[13px]">
          <span className="num min-w-0 text-text-2">{funds.map(([a, v]) => (a === "usdc" ? `${usdc(Number(v) / 1e6)} USDC` : `${tokenAmount(v, DECIMALS)} ${a === "up" ? "Up" : "Down"}`)).join(" · ")}</span>
          <Button size="sm" tone="secondary" className="-my-1 shrink-0" loading={withdraw.busy} onClick={() => void withdrawAll()} data-testid="book-withdraw">
            Withdraw
          </Button>
        </div>
      ) : null}
      <TxStatus tx={cancel.stage !== "idle" ? cancel : withdraw} filledLabel="Done" testId="book-tx" />
    </Section>
  );
}

function Settled({ series: s, up, down }: { series: SeriesView; up: bigint; down: bigint }) {
  const account = useAccount();
  const client = useQueryClient();
  const tx = useTx();
  const won = s.outcome;
  const payout = won === "up" ? up : won === "down" ? down : up / 2n + down / 2n;
  const redeem = async () => {
    const r = await tx.run(() => account.trade(session.redeemWinnings(s.series, up, down)), { action: "Redeem", done: `Redeemed ${usdc(Number(payout) / 1e6)} USDC`, pending: confirmNote(account.kind, false) });
    if (r) {
      void client.invalidateQueries({ queryKey: ["outcome-balances"] });
      void client.invalidateQueries({ queryKey: ["usdc"] });
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <div className={cn("rounded-xl px-4 py-3 text-[13.5px] leading-5", won === "up" ? "bg-up-soft" : won === "down" ? "bg-down-soft" : "bg-surface-2")}>
        <p className="font-strong text-text">{won === "up" ? "Up won." : won === "down" ? "Down won." : "Void."}</p>
        <p className="text-text-2">
          {won === "void"
            ? "No closing reading arrived in time, so every token redeems for 0.50 USDC."
            : `Attention closed ${won === "up" ? "above" : "at or below"} ${points(s.openingIndex)}${s.settlementIndex !== null ? ` at ${points(s.settlementIndex)}` : ""}. The next series opens shortly.`}
        </p>
      </div>
      {account.authenticated && (up > 0n || down > 0n) ? (
        <>
          <SubmitButton tone="primary" disabled={payout === 0n} loading={tx.busy} onClick={() => void redeem()} testId="redeem-winnings">
            {payout > 0n ? `Redeem ${usdc(Number(payout) / 1e6)} USDC` : "Nothing to redeem"}
          </SubmitButton>
          <TxStatus tx={tx} filledLabel="Redeemed" testId="redeem-tx" />
        </>
      ) : null}
    </div>
  );
}
