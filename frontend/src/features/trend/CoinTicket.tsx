"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Rocket, TrendingUp } from "lucide-react";
import { useState } from "react";
import { Badge, ErrorNote, ExplorerLink, Row, Segmented, TxStatus } from "@/components/ui";
import { portfolioKey } from "@/features/portfolio/keys";
import { useAccount } from "@/lib/account/AccountProvider";
import type { Trend } from "@/lib/api";
import { view } from "@/lib/chain/client";
import { COIN_DECIMALS, DEPLOYMENT, explorerAddress, USDC_DECIMALS } from "@/lib/config";
import { price, tokenAmount, usdc } from "@/lib/format";
import { useUsdcBalance } from "@/lib/hooks/queries";
import { owner, ownerCall } from "@/lib/trade/calls";
import { minimumOut, parseAmount } from "@/lib/trade/math";
import { useTx } from "@/lib/trade/useTx";
import { useCurve, useCurveQuote, useRegistryIndex, useTokenBalance } from "./data";
import { AmountField, confirmNote, Note, SubmitButton } from "./ticket";

/**
 * Trend coins, the launch layer: one coin per trend on a bonding curve in USDC whose floor rises
 * with the trend's peak attention. When the curve fills it graduates into its own Rhea pool.
 *
 * Every coin trade is a passkey action: a coin has no oracle price to hold a trade to, so a stolen
 * session key could otherwise trade the account's coins against its holder's own orders.
 */

const SLIPPAGE_BPS = 100;
/** The share of a trade the curve keeps as its fee. */
const FEE_PCT = 1;

/** A coin's price in USDC: four significant digits below a cent (curve coins start tiny). */
export const coinPrice = (v: number | null) => (v === null || !Number.isFinite(v) ? "-" : v >= 0.01 ? price(v) : new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 }).format(v));

/** A coin's symbol from its own metadata; fixed once it exists. */
export function useCoinSymbol(coin: string | undefined) {
  return useQuery({ queryKey: ["coin-symbol", coin], enabled: Boolean(coin), staleTime: Infinity, queryFn: async () => (await view<{ symbol: string }>(coin!, "ft_metadata")).symbol });
}

export default function CoinTicket({ trend }: { trend: Trend }) {
  const curve = useCurve(trend.id);
  if (curve.isLoading) return <div className="skeleton h-[360px]" />;
  if (curve.isError && curve.data === undefined) return <ErrorNote message="NEAR did not answer, so the coin could not load." onRetry={() => void curve.refetch()} />;
  if (!curve.data) return <Launch trend={trend} />;
  if (curve.data.stage === "creating") return <Note>The coin is being created on NEAR. It opens for trading within a block or two.</Note>;
  if (curve.data.stage === "pooled" || curve.data.stage === "graduated") return <Graduated trend={trend} />;
  return <OnCurve trend={trend} />;
}

function Launch({ trend }: { trend: Trend }) {
  const account = useAccount();
  const client = useQueryClient();
  const live = useRegistryIndex(trend.id);
  const tx = useTx();
  const active = live.data ? live.data.status === "active" : trend.status === "active";
  const launch = async () => {
    if (await tx.run(() => account.ownerExecute([ownerCall(owner.createCurve(trend.id))]), { action: "Launch the coin", done: "Coin launched", pending: confirmNote(account.kind, true) })) void client.invalidateQueries({ queryKey: ["curve", trend.id] });
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-center gap-2 rounded-2xl bg-surface-2 px-5 py-7 text-center">
        <span className="flex size-11 items-center justify-center rounded-full bg-primary-soft text-primary">
          <Rocket className="size-5" aria-hidden />
        </span>
        <p className="mt-1 font-strong text-[15px] text-text">No coin for this trend yet</p>
        <p className="max-w-[300px] text-[13px] leading-5 text-text-2">Launch it on a bonding curve in USDC. Its floor rises with the trend&rsquo;s peak attention, and it graduates into its own Rhea pool when the curve fills.</p>
      </div>
      {!active ? <Note tone="warn">Coins launch only while a trend is active.</Note> : null}
      <SubmitButton disabled={!active} loading={tx.busy} onClick={() => void launch()} testId="coin-launch" passkey>
        Launch the coin
      </SubmitButton>
      <TxStatus tx={tx} filledLabel="Launched" testId="coin-launch-tx" />
      <Note>Launching costs you nothing but {account.kind === "wallet" ? "a wallet confirmation" : "one passkey confirmation"}; the coins contract pays for the coin&rsquo;s account. Whoever surfaced the trend earns 10% of the curve&rsquo;s fees, not the launcher.</Note>
    </div>
  );
}

function OnCurve({ trend }: { trend: Trend }) {
  const account = useAccount();
  const client = useQueryClient();
  const curve = useCurve(trend.id);
  const c = curve.data!;
  const symbol = useCoinSymbol(c.coin);
  const balance = useUsdcBalance(account.address);
  const coins = useTokenBalance(c.coin, account.address);
  const held = coins.data ?? 0n;
  const ready = c.stage === "ready";
  const [picked, setMode] = useState<"buy" | "sell">("buy");
  const mode = ready ? "sell" : picked;
  const [text, setText] = useState("");
  const tx = useTx();
  const amount = parseAmount(text, mode === "buy" ? USDC_DECIMALS : COIN_DECIMALS);
  const live = useRegistryIndex(trend.id);
  const quote = useCurveQuote(trend.id, mode, amount, live.data?.peakRaw ?? null);
  const progress = c.graduationReserve > 0n ? Math.min(1, Number(c.reserve) / Number(c.graduationReserve)) : 0;
  const out = quote.data?.out;
  const impact = quote.data && c.spot > 0 ? Math.abs(quote.data.spotAfter / c.spot - 1) : 0;
  const floorBoost = c.peak_at_creation > 0 ? Number(c.virtual_quote) / Number(DEPLOYMENT.params.curveBaseVirtualQuote) : null;

  const error = (() => {
    if (text.trim() === "") return null;
    if (amount === null) return "Enter an amount";
    if (account.authenticated && mode === "buy" && balance.data && amount > balance.data.raw) return "More than your USDC balance";
    if (account.authenticated && mode === "sell" && amount > held) return "More coins than you hold";
    if (quote.data === null) return mode === "buy" ? "The curve cannot take that much in one trade" : "The curve cannot buy that many back in one trade";
    return null;
  })();

  const coinName = symbol.data ? `$${symbol.data}` : "coins";
  const submit = async () => {
    if (!amount || out === undefined) return;
    const call = mode === "buy" ? owner.coinBuy(trend.id, amount, minimumOut(out, SLIPPAGE_BPS)) : owner.coinSell(c.coin, amount, minimumOut(out, SLIPPAGE_BPS));
    const labels =
      mode === "buy"
        ? { action: `Buy ${coinName}`, done: `Bought ${tokenAmount(out, COIN_DECIMALS)} ${coinName} for ${usdc(Number(amount) / 1e6)} USDC`, pending: confirmNote(account.kind, true) }
        : { action: `Sell ${coinName}`, done: `Sold ${tokenAmount(amount, COIN_DECIMALS)} ${coinName}`, pending: confirmNote(account.kind, true) };
    if (await tx.run(() => account.ownerExecute([ownerCall(call)]), labels)) {
      setText("");
      void client.invalidateQueries({ queryKey: ["curve", trend.id] });
      void client.invalidateQueries({ queryKey: ["token-balance"] });
      void client.invalidateQueries({ queryKey: ["usdc"] });
      void client.invalidateQueries({ queryKey: portfolioKey(account.address) });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <CoinHeader symbol={symbol.data} coin={c.coin} priceUsdc={c.spot} floorBoost={floorBoost} />
      <div>
        <div className="flex items-baseline justify-between text-[12.5px]">
          <span className="text-text-2">Graduation</span>
          <span className="num text-text-2">
            {usdc(Number(c.reserve) / 1e6)} of {usdc(Number(c.graduationReserve) / 1e6)} USDC
          </span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="Graduation progress">
          <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${Math.max(progress * 100, progress > 0 ? 2 : 0)}%` }} />
        </div>
      </div>
      {ready ? (
        <Note>The curve is full. It graduates into its own Rhea pool step by step, and trading continues there. Holders can still sell back to the curve meanwhile.</Note>
      ) : null}
      <Segmented
        label="Buy or sell"
        value={mode}
        onChange={(m) => {
          setMode(m);
          setText("");
          tx.reset();
        }}
        options={ready ? [{ value: "sell", label: "Sell back to the curve" }] : [
          { value: "buy", label: "Buy" },
          { value: "sell", label: "Sell" },
        ]}
      />
      <AmountField
        label={mode === "buy" ? "You pay" : "Coins to sell"}
        unit={mode === "buy" ? "USDC" : "coins"}
        value={text}
        onChange={setText}
        balance={account.authenticated ? (mode === "buy" ? (balance.data?.raw ?? null) : held) : undefined}
        decimals={mode === "buy" ? USDC_DECIMALS : COIN_DECIMALS}
        error={error}
        testId="coin-amount"
      />
      <div className="flex flex-col gap-2 rounded-xl border border-line px-3.5 py-3">
        <Row label={mode === "buy" ? "Coins you get" : "You receive"} value={out === undefined ? "-" : mode === "buy" ? tokenAmount(out, COIN_DECIMALS) : `${usdc(Number(out) / 1e6)} USDC`} />
        <Row label="Fee" value={quote.data ? `${usdc(Number(quote.data.fee) / 1e6)} USDC (${FEE_PCT}%)` : `${FEE_PCT}%`} tone="muted" />
        <Row label="Price impact" value={amount && quote.data ? `${(impact * 100).toFixed(2)}%` : "-"} tone={impact > 0.05 ? "warn" : "muted"} />
        <Row label="Slippage limit" value="1%" tone="muted" />
      </div>
      <SubmitButton tone={mode === "buy" ? "primary" : "secondary"} disabled={!amount || out === undefined || out === 0n || Boolean(error)} loading={tx.busy} onClick={() => void submit()} testId="coin-submit" passkey>
        {mode === "buy" ? `Buy ${coinName}` : `Sell ${coinName}`}
      </SubmitButton>
      <TxStatus tx={tx} filledLabel={mode === "buy" ? "Bought" : "Sold"} testId="coin-tx" />
      {account.authenticated && held > 0n ? (
        <p className="num text-[12.5px] text-text-2">
          You hold {tokenAmount(held, COIN_DECIMALS)} coins, about {usdc((Number(held) / 1e18) * c.spot)} USDC at the curve price.
        </p>
      ) : null}
      <Note>Trend coins are the riskiest thing on Tredio: their price is set only by buyers and sellers on the curve, so {account.kind === "wallet" ? "your wallet" : "your passkey"} confirms every coin trade. The attention floor limits how low the curve can price them, not what you get back.</Note>
    </div>
  );
}

function CoinHeader({ symbol, coin, priceUsdc, floorBoost }: { symbol: string | undefined; coin: string; priceUsdc: number | null; floorBoost: number | null }) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div className="min-w-0">
        <ExplorerLink href={explorerAddress(coin)} className="max-w-full font-mono text-[12px]">
          <span className="truncate">{symbol ? `$${symbol}` : "Trend coin"}</span>
        </ExplorerLink>
        <p className="num-display mt-0.5 font-display text-[30px] leading-none text-text">
          {coinPrice(priceUsdc)} <span className="font-sans text-[13px] text-text-3">USDC</span>
        </p>
      </div>
      {floorBoost !== null && floorBoost > 1.0001 ? (
        <Badge tone="up" icon={<TrendingUp className="size-3" aria-hidden />}>
          Floor {floorBoost.toFixed(2)}x
        </Badge>
      ) : null}
    </div>
  );
}

/** After graduation the coin trades in its Rhea pool, which holds the curve's reserve for good. */
function Graduated({ trend }: { trend: Trend }) {
  const account = useAccount();
  const curve = useCurve(trend.id);
  const c = curve.data!;
  const symbol = useCoinSymbol(c.coin);
  const coins = useTokenBalance(c.coin, account.address);
  const held = coins.data ?? 0n;
  return (
    <div className="flex flex-col gap-4">
      <CoinHeader symbol={symbol.data} coin={c.coin} priceUsdc={c.spot} floorBoost={null} />
      <Note>
        Graduated: the curve closed and its reserve{c.pool_id !== null ? ` seeded Rhea pool #${c.pool_id}` : " is moving into a Rhea pool"}, where the coin trades now. The liquidity stays locked in the pool; the coins contract cannot remove it.
      </Note>
      <div className="flex flex-col gap-2 rounded-xl border border-line px-3.5 py-3">
        <Row label="Pool" value={c.pool_id !== null ? `#${c.pool_id} on Rhea` : "Opening"} />
        <Row label="Moved in" value={`${tokenAmount(BigInt(c.grad_coins), COIN_DECIMALS)} coins, ${usdc(Number(c.grad_quote) / 1e6)} USDC`} />
        {account.authenticated ? <Row label="You hold" value={`${tokenAmount(held, COIN_DECIMALS)} coins`} /> : null}
      </div>
      <ExplorerLink href={explorerAddress(DEPLOYMENT.external.exchange)} className="self-start text-[12.5px]">
        Rhea exchange contract
      </ExplorerLink>
    </div>
  );
}
