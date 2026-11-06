"use client";
import { useQueryClient } from "@tanstack/react-query";
import { bindsMarkToAssetIndex, type EvmSignature, hlMarkMaxAge } from "@tredio/contracts";
import { APP_URL as HL_APP_URL, formatPrice, formatSize, type HlOrder, orderOutcome } from "@tredio/hyperliquid";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Badge, Button, cn, ErrorNote, Row, Segmented, TxStatus } from "@/components/ui";
import { useAccount } from "@/lib/account/AccountProvider";
import { useAccountVersion } from "@/lib/account/version";
import type { HlMarket, Trend } from "@/lib/api";
import { TxFailed } from "@/lib/chain/outcome";
import { HL_NETWORK, IS_MAINNET } from "@/lib/config";
import { pct, price, shortAddress, usdc } from "@/lib/format";
import { useCopy } from "@/lib/hooks/useCopy";
import { useSheets } from "@/lib/sheets";
import { closePosition, HL_SLIPPAGE, signLeverage, signOrder } from "@/lib/trade/hyperliquid";
import { parseAmount } from "@/lib/trade/math";
import { useTx } from "@/lib/trade/useTx";
import { useAssetPerpMarket, useHlAccount, useMark } from "./data";
import { AmountField, Note, Section, SubmitButton, useNow } from "./ticket";

// #mainnet: this file branches on the network (testnet or mainnet); MAINNET.md lists what changes.

/**
 * Hyperliquid perps on the asset behind a trend, traded from the account's own Hyperliquid address:
 * the EVM address of its NEAR Chain Signatures key. The session asks the account to sign each order;
 * the account contract checks it first (priced within 2% of the oracle's mark, which must be under
 * two minutes old on v1 account code and five on v2, where the mark must also name the very market
 * the order trades; leverage at most 10x), then the MPC network signs and the app posts the very
 * same action to Hyperliquid.
 */

const LEVERAGES = [1, 2, 3, 5, 10] as const;
/** The account contract's guard. */
const GUARD_BAND = 0.02;
const SESSION_MAX_LEVERAGE = 10;
const AGE_WORDS: Record<number, string> = { 120: "two minutes", 300: "five minutes" };
const TAKER_FEE = 0.00045;

type Result = { kind: "filled"; size: number; price: number } | { kind: "resting"; oid: number | null } | { kind: "missed"; reason: string } | null;

export default function AssetPerpTicket({ trend }: { trend: Trend }) {
  const { market } = useAssetPerpMarket(trend.asset ?? trend.ticker);
  const account = useAccount();
  if (!market) return null;
  if (account.kind === "wallet") {
    return (
      <div className="flex flex-col gap-4">
        <MarketHeader market={market} />
        <Note>Hyperliquid orders come from a passkey account&rsquo;s own Chain Signatures key, checked by its account contract before the MPC network signs. A NEAR wallet has neither, so trade {market.symbol} perps from a passkey account.</Note>
      </div>
    );
  }
  return <Ticket market={market} />;
}

function MarketHeader({ market }: { market: HlMarket }) {
  const change = market.prevDayPx > 0 ? ((market.markPx - market.prevDayPx) / market.prevDayPx) * 100 : null;
  return (
    <div className="flex items-end justify-between gap-3">
      <div>
        <p className="font-mono text-[12px] text-text-3">{market.symbol} perpetual on Hyperliquid{IS_MAINNET ? "" : " testnet"}</p>
        <p className="num-display mt-0.5 font-display text-[30px] leading-none text-text" data-testid="asset-perp-mark">
          {price(market.markPx)}
        </p>
      </div>
      <p className="num text-right text-[12px] text-text-3">
        {change !== null ? <span className={change >= 0 ? "text-up" : "text-down"}>{pct(change)} 24h</span> : null}
        <br />
        Funding {(market.funding * 100).toFixed(4)}%/h
      </p>
    </div>
  );
}

function Ticket({ market }: { market: HlMarket }) {
  const account = useAccount();
  const client = useQueryClient();
  const hl = useHlAccount(account.address);
  const mark = useMark(market.symbol);
  // Until the account's code version is known, the v1 guard applies: it is the stricter one on age.
  const version = useAccountVersion(account.address).data ?? 1;
  const now = useNow(5_000);
  const [side, setSide] = useState<"long" | "short">("long");
  const [lev, setLev] = useState("3");
  const [text, setText] = useState("");
  const [result, setResult] = useState<Result>(null);
  const tx = useTx();

  const top = Math.max(1, Math.min(SESSION_MAX_LEVERAGE, Math.floor(market.maxLeverage)));
  const levels = [...new Set([...LEVERAGES.filter((l) => l < top), top])].map(String);
  const leverage = Number(levels.includes(lev) ? lev : levels[levels.length - 1]);
  const buy = side === "long";
  const markMaxAge = hlMarkMaxAge(version);
  const markAge = mark.data ? Math.max(0, Math.floor(now / 1000) - mark.data.at) : null;
  const markFresh = markAge !== null && markAge <= markMaxAge;
  // v2 signs only against a mark that names this very market (the order's asset index).
  const markNamesMarket = !bindsMarkToAssetIndex(version) || mark.data?.assetIndex === market.index;
  const oracle = mark.data?.price ?? null;
  const ref = market.midPx ?? market.markPx;
  // The worst price Hyperliquid may fill at, kept inside the account's 2% band around the oracle's mark.
  const limit = oracle ? Math.min(Math.max(ref * (buy ? 1 + HL_SLIPPAGE : 1 - HL_SLIPPAGE), oracle * (1 - GUARD_BAND * 0.95)), oracle * (1 + GUARD_BAND * 0.95)) : null;
  const priceText = limit ? formatPrice(limit, market.szDecimals, buy ? "down" : "up") : null;
  const margin = parseAmount(text, 6);
  const marginUsdc = margin === null ? null : Number(margin) / 1e6;
  const step = 10 ** -market.szDecimals;
  const size = marginUsdc !== null && market.markPx > 0 ? Math.floor(((marginUsdc * leverage) / market.markPx) * 10 ** market.szDecimals + 1e-9) / 10 ** market.szDecimals : null;
  const notional = size !== null ? size * market.markPx : null;
  const withdrawable = hl.data?.state?.withdrawable ?? 0;
  const position = hl.data?.state?.positions.find((p) => p.coin === market.symbol) ?? null;

  const error = (() => {
    if (text.trim() === "") return null;
    if (margin === null) return "Enter an amount";
    if (size !== null && size < step) return `Too small: the smallest order is ${step} ${market.symbol}`;
    if (hl.data?.state && marginUsdc !== null && marginUsdc > withdrawable) return `Your Hyperliquid balance has ${usdc(withdrawable)} USDC free`;
    if (notional !== null && notional < 10) return "Hyperliquid's smallest order is 10 USDC of notional";
    return null;
  })();

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["hl-account"] });
  };

  const submit = async () => {
    if (!size || !priceText) return;
    setResult(null);
    const order: HlOrder = { asset: market.symbol, asset_index: market.index, is_buy: buy, price: priceText, size: formatSize(size, market.szDecimals), reduce_only: false, tif: "Ioc" };
    const named = `${buy ? "Long" : "Short"} ${market.symbol} ${leverage}x`;
    let outcome: Result = null;
    const r = await tx.run(
      async () => {
        // Isolated margin at the chosen leverage first (unless the position already runs at it), then the order.
        if (!position || position.leverage !== leverage) {
          const lv = await signLeverage(account.trade<EvmSignature>, market.index, false, leverage);
          if (lv.answer.status === "err") throw new TxFailed(`Hyperliquid refused the leverage change: ${lv.answer.response}`, lv.sent.hash);
        }
        const o = await signOrder(account.trade<EvmSignature>, order);
        const out = orderOutcome(o.answer);
        outcome = !out.ok ? { kind: "missed", reason: out.error } : out.filled ? { kind: "filled", size: out.filled.totalSz, price: out.filled.avgPx } : { kind: "resting", oid: out.oid };
        return o.sent;
      },
      { action: named, done: `${named} signed and sent`, pending: "Signing with NEAR Chain Signatures" },
    );
    if (r) {
      setResult(outcome);
      setText("");
      refresh();
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <MarketHeader market={market} />
      <Segmented
        label="Side"
        value={side}
        onChange={(v) => {
          setSide(v);
          tx.reset();
          setResult(null);
        }}
        options={[
          { value: "long", label: "Long", tone: "up" },
          { value: "short", label: "Short", tone: "down" },
        ]}
      />
      <AmountField label="Margin" unit="USDC" value={text} onChange={setText} balance={hl.data?.state ? BigInt(Math.floor(withdrawable * 1e6)) : undefined} decimals={6} error={error} testId="asset-perp-margin" />
      <div className="flex items-center justify-between gap-3">
        <span className="font-strong text-[12.5px] text-text-2">Leverage</span>
        <Segmented label="Leverage" size="sm" value={String(leverage)} onChange={setLev} options={levels.map((l) => ({ value: l, label: `${l}x` }))} />
      </div>
      <div className="flex flex-col gap-2 rounded-xl border border-line px-3.5 py-3">
        <Row label="Size" value={size !== null && size > 0 ? `${size.toFixed(market.szDecimals)} ${market.symbol}` : "-"} />
        <Row label="Notional" value={notional !== null && notional > 0 ? `${usdc(notional)} USDC` : "-"} />
        <Row label="Worst fill price" value={priceText ?? "-"} tone="muted" />
        <Row label="Oracle mark" value={oracle ? `${price(oracle)}${markAge !== null ? `, ${markAge}s old` : ""}` : "None yet"} tone={markFresh ? "muted" : "warn"} />
        <Row label="Liquidation near" value={margin ? price(buy ? market.markPx * (1 - 1 / leverage) : market.markPx * (1 + 1 / leverage)) : "-"} tone={margin ? "warn" : undefined} />
        <Row label="Taker fee" value={notional ? `${usdc(notional * TAKER_FEE)} USDC` : "0.045%"} tone="muted" />
        <Row label="Most you can lose" value={margin ? `${usdc(marginUsdc!)} USDC` : "-"} tone="down" />
      </div>
      {!mark.isLoading && !markFresh ? (
        <Note tone="warn">
          {oracle ? `Tredio's oracle mark for ${market.symbol} is ${markAge !== null ? `${Math.round(markAge / 60)} min` : "too"} old.` : `Tredio's oracle has no mark for ${market.symbol} yet.`} The account signs session orders only within 2% of a mark under {AGE_WORDS[markMaxAge] ?? `${markMaxAge} seconds`} old, so orders wait for the next oracle report.
        </Note>
      ) : null}
      {!mark.isLoading && markFresh && !markNamesMarket ? (
        <Note tone="warn">
          Tredio&rsquo;s oracle mark for {market.symbol} {mark.data?.assetIndex == null ? "does not name its Hyperliquid market yet" : "names another Hyperliquid market"}, and your account signs session orders only against a mark for the very market they trade, so orders wait for the oracle to report it.
        </Note>
      ) : null}
      <SubmitButton tone={buy ? "up" : "down"} disabled={!size || size < step || Boolean(error) || !priceText || !markFresh || !markNamesMarket} loading={tx.busy} onClick={() => void submit()} testId="asset-perp-submit">
        {`${buy ? "Long" : "Short"} ${market.symbol} ${leverage}x`}
      </SubmitButton>
      <TxStatus tx={tx} filledLabel="Signed" testId="asset-perp-tx" />
      {result?.kind === "filled" ? (
        <p className="num rounded-xl bg-up-soft px-3.5 py-2.5 text-[13px] text-text" role="status">
          Filled {result.size} {market.symbol} at {price(result.price)}.
        </p>
      ) : result?.kind === "resting" ? (
        <p className="rounded-xl bg-surface-2 px-3.5 py-2.5 text-[13px] text-text" role="status">
          Order resting on Hyperliquid.
        </p>
      ) : result?.kind === "missed" ? (
        <ErrorNote message={`Hyperliquid did not fill it: ${result.reason}`} />
      ) : null}
      <Note>
        {market.symbol} perps track the asset&rsquo;s market price, not its attention. Session orders are immediate, up to {SESSION_MAX_LEVERAGE}x, within 2% of Tredio&rsquo;s oracle mark; the account contract enforces both before NEAR&rsquo;s MPC network signs.
      </Note>
      {account.authenticated ? <HyperliquidAccount market={market} position={position} /> : null}
    </div>
  );
}

function HyperliquidAccount({ market, position }: { market: HlMarket; position: { coin: string; szi: number; entryPx: number | null; unrealizedPnl: number; marginUsed: number; leverage: number; liquidationPx: number | null } | null }) {
  const account = useAccount();
  const client = useQueryClient();
  const hl = useHlAccount(account.address);
  const open = useSheets((s) => s.open);
  const { copied, copy } = useCopy();
  const tx = useTx();
  const [missed, setMissed] = useState<string | null>(null);
  const state = hl.data?.state;
  const address = hl.data?.address;

  const close = async () => {
    if (!position) return;
    setMissed(null);
    let reason: string | null = null;
    const r = await tx.run(
      async () => {
        const c = await closePosition(account.trade<EvmSignature>, { asset: market.symbol, assetIndex: market.index, szDecimals: market.szDecimals, size: Math.abs(position.szi), long: position.szi > 0, reference: market.midPx ?? market.markPx });
        reason = c.refused;
        return c.sent;
      },
      { action: `Close ${market.symbol}`, done: `${market.symbol} close signed and sent`, pending: "Signing with NEAR Chain Signatures" },
    );
    if (r) {
      setMissed(reason);
      void client.invalidateQueries({ queryKey: ["hl-account"] });
    }
  };

  return (
    <Section title="Your Hyperliquid account" className="border-t border-line pt-5">
      {address ? (
        <div className="flex items-center justify-between gap-3 text-[12.5px]">
          <span className="text-text-2">Address</span>
          <span className="flex items-center gap-2">
            <button type="button" onClick={() => void copy(address, "Address copied")} className="num flex items-center gap-1.5 font-mono text-text hover:text-primary">
              {shortAddress(address)}
              {copied ? <Check className="size-3.5 text-up" aria-hidden /> : <Copy className="size-3.5 text-text-3" aria-hidden />}
            </button>
            <a href={`${HL_APP_URL[HL_NETWORK]}/explorer/address/${address}`} target="_blank" rel="noreferrer" className="text-text-3 underline-offset-4 hover:text-text hover:underline">
              Explorer
            </a>
          </span>
        </div>
      ) : null}
      {position ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-line px-3.5 py-3" data-testid="asset-perp-position">
          <div className="flex items-start justify-between gap-3">
            <div>
              <Badge tone={position.szi > 0 ? "up" : "down"}>
                {position.szi > 0 ? "Long" : "Short"} {Math.abs(position.szi)} {market.symbol}
              </Badge>
              <p className="num mt-1.5 text-[12.5px] text-text-2">
                Entry {price(position.entryPx)}, margin {usdc(position.marginUsed)}, {position.leverage}x
              </p>
            </div>
            <div className="text-right">
              <p className={cn("num font-strong text-[15px]", position.unrealizedPnl >= 0 ? "text-up" : "text-down")}>{usdc(position.unrealizedPnl, { sign: true })} USDC</p>
              {position.liquidationPx ? <p className="num text-[12px] text-text-3">Liq. {price(position.liquidationPx)}</p> : null}
            </div>
          </div>
          <Button tone="danger" size="sm" loading={tx.busy} onClick={() => void close()} data-testid="asset-perp-close">
            Close
          </Button>
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-3 text-[13px]">
        <span className="text-text-2">
          Balance <span className="num font-strong text-text">{state ? `${usdc(state.accountValue)} USDC` : hl.isLoading ? "..." : "-"}</span>
        </span>
        {state && (state.accountValue < 1 || state.withdrawable >= 0.01) ? (
          <span className="flex shrink-0 items-center gap-2">
            {state.accountValue < 1 ? (
              <Button tone="secondary" size="sm" onClick={() => open("deposit")}>
                Fund it
              </Button>
            ) : null}
            {state.withdrawable >= 0.01 ? (
              <Button tone="secondary" size="sm" onClick={() => open("hl-withdraw")} data-testid="asset-perp-withdraw">
                Withdraw
              </Button>
            ) : null}
          </span>
        ) : null}
      </div>
      {state && state.accountValue < 1 ? (
        <p className="text-[12.5px] leading-[18px] text-text-3">
          {IS_MAINNET
            ? "Move USDC into this Hyperliquid address from Add funds: NEAR Intents delivers it straight to its perps balance."
            : "This Hyperliquid testnet address holds no USDC yet. Send testnet USDC to it on Hyperliquid testnet (its faucet pays addresses with mainnet history), and orders fill from it."}
        </p>
      ) : null}
      {missed ? <ErrorNote message={`Hyperliquid did not close it: ${missed}`} /> : null}
      <TxStatus tx={tx} filledLabel="Signed" testId="asset-perp-close-tx" />
    </Section>
  );
}
