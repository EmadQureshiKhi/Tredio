"use client";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, Check, Copy, Droplets, Globe2, Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { OwnerAction } from "@tredio/contracts";
import { Badge, Button, Card, CardHeader, cn, Empty, ErrorNote, Field, Row, Segmented, TxStatus } from "@/components/ui";
import { confirmNote } from "@/features/trend/ticket";
import { useAccount } from "@/lib/account/AccountProvider";
import { ApiSignIn } from "@/lib/account/ApiSignIn";
import { parseAmount } from "@/lib/amount";
import { ApiError, type DepositAsset, type DepositRow, deposits, hyperliquid, type QuoteRequest } from "@/lib/api";
import { DEPLOYMENT, IS_MAINNET } from "@/lib/config";
import { shortAddress, usdc } from "@/lib/format";
import { useCopy } from "@/lib/hooks/useCopy";
import { useSheets } from "@/lib/sheets";
import { owner, ownerCall, storage } from "@/lib/trade/calls";
import { isRegistered } from "@/lib/trade/reads";
import { useTx } from "@/lib/trade/useTx";

/**
 * Any-chain deposits and withdrawals through NEAR Intents 1Click: pick what you hold and where,
 * see a quote, then (on mainnet) send to a one-time deposit address; 1Click delivers USDC to the
 * account on NEAR, or moves USDC out to any chain, or into the account's Hyperliquid balance.
 * On testnet 1Click does not run, so quotes are dry previews at mainnet prices and nothing moves;
 * testnet USDC comes from the faucet.
 */

type Direction = QuoteRequest["direction"];

const CHAIN_NAMES: Record<string, string> = {
  near: "NEAR",
  eth: "Ethereum",
  base: "Base",
  arb: "Arbitrum",
  op: "Optimism",
  pol: "Polygon",
  bsc: "BNB Chain",
  avax: "Avalanche",
  sol: "Solana",
  btc: "Bitcoin",
  ton: "TON",
  tron: "TRON",
  sui: "Sui",
  doge: "Dogecoin",
  xrp: "XRP Ledger",
  zec: "Zcash",
  gnosis: "Gnosis",
  bera: "Berachain",
  stellar: "Stellar",
  cardano: "Cardano",
  aptos: "Aptos",
  ltc: "Litecoin",
};
const chainName = (c: string) => CHAIN_NAMES[c] ?? c.charAt(0).toUpperCase() + c.slice(1);
const EVM = /^0x[0-9a-fA-F]{40}$/;
const EVM_CHAINS = new Set(["eth", "base", "arb", "op", "pol", "bsc", "avax", "gnosis", "bera"]);
const FINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function DepositPage() {
  const account = useAccount();
  const openSheet = useSheets((s) => s.open);
  const assets = useQuery({ queryKey: ["deposit-assets"], queryFn: () => deposits.assets(), staleTime: 300_000 });
  const live = assets.data?.live ?? IS_MAINNET;
  const [direction, setDirection] = useState<Direction>("deposit");
  const passkey = account.kind === "passkey";

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-6">
      <header>
        <p className="font-strong text-[12px] uppercase tracking-[0.14em] text-primary">NEAR Intents</p>
        <h1 className="mt-2 font-display text-[32px] leading-[1.1] text-text sm:text-[38px]">Move funds across chains</h1>
        <p className="mt-2 text-[14.5px] leading-6 text-text-2">
          Send USDC, USDT, ETH, SOL, BTC and more from any chain NEAR Intents reaches, and it arrives in your Tredio account on NEAR as USDC; take USDC out the same way, or move it into your Hyperliquid balance. A failed swap refunds you.
        </p>
      </header>

      {!live && assets.data ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between" data-testid="deposit-preview-note">
          <p className="text-[13px] leading-5 text-text-2">
            <Badge tone="warn" className="mr-1.5 align-[1px]">
              Testnet
            </Badge>
            NEAR Intents runs on mainnet only. These are previews at mainnet prices: no deposit address opens and nothing moves. Testnet USDC comes from the faucet.
          </p>
          <Button size="sm" tone="secondary" className="shrink-0" icon={<Droplets className="size-4" aria-hidden />} onClick={() => openSheet("deposit")}>
            Get test USDC
          </Button>
        </div>
      ) : null}

      <Segmented
        label="Direction"
        value={direction}
        onChange={setDirection}
        options={[
          { value: "deposit", label: "Deposit" },
          { value: "withdraw", label: "Withdraw" },
          ...(passkey ? [{ value: "hyperliquid" as const, label: "To Hyperliquid" }] : []),
        ]}
      />

      {assets.error ? <ErrorNote message="NEAR Intents' asset list could not load." onRetry={() => void assets.refetch()} /> : null}
      <QuoteCard key={direction} direction={direction} assets={assets.data?.assets ?? []} live={live} confidential={assets.data?.confidential ?? false} />
      {account.backendReady ? <History /> : null}
    </div>
  );
}

function Select({ label, value, onChange, children, disabled, testId }: { label: string; value: string; onChange: (v: string) => void; children: React.ReactNode; disabled?: boolean; testId?: string }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="font-strong text-[12.5px] text-text-2">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        data-testid={testId}
        className="h-11 w-full appearance-none rounded-xl border border-line bg-surface-2 bg-[length:16px] bg-[right_12px_center] bg-no-repeat px-3 pr-9 text-[15px] text-text outline-none transition-colors focus:border-primary disabled:opacity-50"
        style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")" }}
      >
        {children}
      </select>
    </label>
  );
}

function QuoteCard({ direction, assets, live, confidential }: { direction: Direction; assets: DepositAsset[]; live: boolean; confidential: boolean }) {
  const account = useAccount();
  const { copied, copy } = useCopy();
  // The other side of a deposit or withdrawal: assets off NEAR, plus NEAR's own.
  const chains = useMemo(() => [...new Set(assets.map((a) => a.chain))].sort((a, b) => chainName(a).localeCompare(chainName(b))), [assets]);
  const [chain, setChain] = useState("base");
  const chosenChain = chains.includes(chain) ? chain : (chains[0] ?? "");
  const onChain = assets.filter((a) => a.chain === chosenChain);
  const [assetId, setAssetId] = useState<string | null>(null);
  const asset = onChain.find((a) => a.assetId === assetId) ?? onChain.find((a) => a.symbol === "USDC") ?? onChain[0];
  const [amountText, setAmountText] = useState("25");
  const [other, setOther] = useState("");
  const hl = useQuery({ queryKey: ["hl-address", account.address], enabled: direction === "hyperliquid" && Boolean(account.address), staleTime: Infinity, queryFn: async () => (await hyperliquid.account(account.address!)).address.toLowerCase() });

  const decimals = direction === "deposit" ? (asset?.decimals ?? 6) : 6;
  const raw = parseAmount(amountText, decimals);
  const evm = EVM_CHAINS.has(chosenChain);
  const addressError = other.trim() === "" ? null : evm && !EVM.test(other.trim()) ? `Enter your ${chainName(chosenChain)} address (0x...)` : null;
  const request: QuoteRequest | null = !raw
    ? null
    : direction === "hyperliquid"
      ? hl.data
        ? { direction, amount: raw.toString(), hyperliquidAddress: hl.data }
        : null
      : asset && other.trim() && !addressError
        ? direction === "deposit"
          ? { direction, asset: asset.assetId, amount: raw.toString(), refundTo: other.trim() }
          : { direction, asset: asset.assetId, amount: raw.toString(), recipient: other.trim() }
        : null;
  const debounced = useDebounced(request, 500);
  const quote = useQuery({ queryKey: ["deposit-quote", debounced], enabled: debounced !== null && account.backendReady, queryFn: () => deposits.quote(debounced!), staleTime: 20_000, retry: false });
  const q = quote.data?.quote;
  const usd = direction === "deposit" && asset && raw ? (Number(raw) / 10 ** asset.decimals) * asset.priceUsd : raw ? Number(raw) / 1e6 : null;
  const unit = direction === "deposit" ? asset?.symbol : "USDC";
  const outUnit = direction === "deposit" ? "USDC on NEAR" : direction === "withdraw" ? `${asset?.symbol ?? ""} on ${chainName(chosenChain)}` : "USDC on Hyperliquid";
  const address = quote.data?.deposit?.depositAddress ?? q?.depositAddress;
  const send = useTx();
  // Out of NEAR: the account sends the USDC to the quote's deposit address (registering it with USDC first when new).
  const sendOut = async (to: string, amount: bigint) => {
    const actions: OwnerAction[] = [];
    if (!(await isRegistered(DEPLOYMENT.contracts.usdc, to))) actions.push(ownerCall(storage.usdc(to)));
    actions.push(ownerCall(owner.sendUsdc(to, amount)));
    await send.run(() => account.ownerExecute(actions), { action: "Send USDC", done: `Sent ${usdc(Number(amount) / 1e6)} USDC to NEAR Intents`, pending: confirmNote(account.kind, true) });
  };

  return (
    <Card className="flex flex-col gap-5 p-5">
      {direction !== "hyperliquid" ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select
            label={direction === "deposit" ? "From chain" : "To chain"}
            value={chosenChain}
            onChange={(v) => {
              setChain(v);
              setAssetId(null);
            }}
            disabled={!chains.length}
            testId="deposit-chain"
          >
            {chains.map((c) => (
              <option key={c} value={c}>
                {chainName(c)}
              </option>
            ))}
          </Select>
          <Select label="Asset" value={asset?.assetId ?? ""} onChange={setAssetId} disabled={!onChain.length} testId="deposit-asset">
            {onChain.map((t) => (
              <option key={t.assetId} value={t.assetId}>
                {t.symbol}
              </option>
            ))}
          </Select>
        </div>
      ) : (
        <div className="flex flex-col gap-1 rounded-xl border border-line px-3.5 py-3 text-[13px]">
          <span className="text-text-2">Your Hyperliquid address (your account&rsquo;s own Chain Signatures key)</span>
          <span className="num font-mono text-text">{hl.data ? hl.data : hl.isLoading ? "..." : "-"}</span>
        </div>
      )}
      <Field label={direction === "deposit" ? "Amount" : "USDC to send"} inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value.replace(/[^\d.]/g, ""))} suffix={unit} hint={usd !== null ? `About $${usdc(usd)}` : undefined} data-testid="deposit-amount" />
      {direction !== "hyperliquid" ? (
        <Field
          label={direction === "deposit" ? `Your address on ${chainName(chosenChain)}` : `Receiving address on ${chainName(chosenChain)}`}
          value={other}
          onChange={(e) => setOther(e.target.value.trim())}
          placeholder={evm ? "0x..." : "Wallet address"}
          autoComplete="off"
          spellCheck={false}
          error={addressError}
          hint={direction === "deposit" ? "The wallet you send from. If the swap cannot complete, NEAR Intents refunds there, so not an exchange address." : "Where the funds arrive. Double-check it: transfers cannot be reversed."}
          data-testid="deposit-address"
        />
      ) : null}

      <div className="flex flex-col gap-2 rounded-xl border border-line px-3.5 py-3" aria-live="polite" data-testid="deposit-quote">
        {!account.backendReady ? (
          account.authenticated ? (
            <ApiSignIn purpose="to get quotes" className="border-0 p-0" />
          ) : (
            <p className="text-[13px] text-text-3">Sign in to see a quote.</p>
          )
        ) : quote.isFetching && !quote.data ? (
          <p className="flex items-center gap-2 text-[13px] text-text-3">
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> Asking NEAR Intents for a quote
          </p>
        ) : quote.error ? (
          <p className="text-[13px] text-down">{quote.error instanceof ApiError ? quote.error.message : "No quote right now."}</p>
        ) : q ? (
          <>
            <Row label="You send" value={`${q.amountInFormatted} ${unit ?? ""}`} />
            <div className="flex justify-center text-text-3">
              <ArrowDown className="size-3.5" aria-hidden />
            </div>
            <Row label="Arrives" value={`${q.amountOutFormatted} ${outUnit}`} tone="up" />
            <Row label="Worth" value={`$${usdc(Number(q.amountOutUsd))}`} tone="muted" />
            <Row label="Time" value={`About ${Math.max(1, Math.round(q.timeEstimate / 60))} min after it lands`} tone="muted" />
            {quote.data?.dry ? <p className="pt-1 text-[12px] text-text-3">A preview: no deposit address was opened.</p> : null}
          </>
        ) : (
          <p className="text-[13px] text-text-3">{direction === "hyperliquid" ? "Enter an amount to see a quote." : "Enter an amount and the address to see a quote."}</p>
        )}
      </div>

      {confidential ? (
        <p className="flex items-start gap-2 text-[12.5px] leading-[18px] text-text-2">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-up" aria-hidden />
          Quotes ask for Confidential Intents: the route cannot be linked to the account it lands in.
        </p>
      ) : null}

      {!account.authenticated ? (
        <Button block size="lg" onClick={account.login}>
          Sign in
        </Button>
      ) : address && live && direction !== "deposit" && raw ? (
        <>
          <Button block size="lg" loading={send.busy} disabled={send.stage === "filled" || send.stage === "final"} onClick={() => void sendOut(address, raw)} data-testid="deposit-send">
            Send {usdc(Number(raw) / 1e6)} USDC
          </Button>
          <TxStatus tx={send} filledLabel="Sent" />
        </>
      ) : address && live ? (
        <div className="flex flex-col gap-2" data-testid="deposit-address-out">
          <p className="font-strong text-[13px] text-text">Send exactly {q?.amountInFormatted} {unit} to</p>
          <button type="button" onClick={() => void copy(address, "Deposit address copied")} className="flex items-start justify-between gap-3 rounded-xl border border-line bg-surface-2 px-3.5 py-3 text-left transition-colors hover:border-line-strong">
            <span className="min-w-0 break-all font-mono text-[13px] leading-5 text-text">{address}</span>
            {copied ? <Check className="mt-0.5 size-4 shrink-0 text-up" aria-hidden /> : <Copy className="mt-0.5 size-4 shrink-0 text-text-3" aria-hidden />}
          </button>
        </div>
      ) : (
        <Button block size="lg" disabled data-testid="deposit-create">
          {live ? "Enter the details above" : "Deposit addresses open on mainnet"}
        </Button>
      )}
    </Card>
  );
}

function History() {
  const list = useQuery({ queryKey: ["deposits"], queryFn: () => deposits.list(), refetchInterval: 20_000 });
  const rows: DepositRow[] = useMemo(() => list.data?.deposits ?? [], [list.data]);
  if (!rows.length) return list.isLoading ? null : <Empty icon={<Globe2 className="size-6" />} title="No transfers yet" body="Deposits and withdrawals through NEAR Intents show here with their status." />;
  return (
    <Card>
      <CardHeader title="Your transfers" />
      <ul className="divide-y divide-line px-5 pb-2 pt-2">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 py-3 text-[13px]">
            <span className="min-w-0 truncate text-text">
              {r.direction === "deposit" ? "In" : r.direction === "withdraw" ? "Out" : "To Hyperliquid"}: {r.amountIn} <span className="text-text-3">to {shortAddress(r.depositAddress)}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <Badge tone={r.phase === "SUCCESS" ? "up" : r.phase === "REFUNDED" || r.phase === "FAILED" ? "down" : "neutral"}>{r.phase.replace(/_/g, " ").toLowerCase()}</Badge>
              <a href={r.explorer} target="_blank" rel="noreferrer" className={cn("text-[12px] text-text-3 hover:text-text", FINAL.has(r.phase) ? "" : "font-strong")}>
                Track
              </a>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
