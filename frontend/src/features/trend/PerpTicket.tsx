"use client";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Fingerprint } from "lucide-react";
import { useState } from "react";
import { Badge, Button, cn, Num, Row, Segmented, TxStatus } from "@/components/ui";
import { portfolioKey } from "@/features/portfolio/keys";
import { useAccount } from "@/lib/account/AccountProvider";
import type { Trend } from "@/lib/api";
import { points, tokenAmount, usdc } from "@/lib/format";
import { useUsdcBalance } from "@/lib/hooks/queries";
import { owner, ownerCall, session } from "@/lib/trade/calls";
import { acceptableIndex, INDEX_MAX, parseAmount, PERP, perpNumbers, perpPreview } from "@/lib/trade/math";
import type { PerpPositionView } from "@/lib/trade/reads";
import { useTx } from "@/lib/trade/useTx";
import { type PerpClose, perpClosesOf } from "@/features/share/data";
import { usePerpMarket, usePerpPositions, useRegistryIndex } from "./data";
import { AmountField, confirmNote, Note, Section, SubmitButton } from "./ticket";

/**
 * Attention perps: a position on the index itself, long or short, up to 3x, with isolated margin.
 * Everything the contract will do is shown before confirming: size, fee, liquidation index,
 * funding and the most you can lose. Opening and closing go out from the trading session; adding
 * margin is a passkey call.
 */

const DECIMALS = 6;
const SLIPPAGE_BPS = 100;
const LEVERAGES = ["1", "2", "3"] as const;

const money = (raw: bigint) => usdc(Number(raw) / 1e6);
const TWO = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
const SIGNED = { ...TWO, signDisplay: "exceptZero" } as const;
const Usdc = ({ raw }: { raw: bigint }) => (
  <>
    <Num value={Number(raw) / 1e6} /> USDC
  </>
);
const fundingText = (pctPerHour: number) =>
  Math.abs(pctPerHour) < 0.00005 ? "None while balanced" : pctPerHour > 0 ? `You pay ${pctPerHour.toFixed(3)}% an hour` : `You earn ${(-pctPerHour).toFixed(3)}% an hour`;

export default function PerpTicket({ trend }: { trend: Trend }) {
  const account = useAccount();
  const client = useQueryClient();
  const live = useRegistryIndex(trend.id);
  const index = live.data?.index;
  const market = usePerpMarket(trend.id, index);
  const balance = useUsdcBalance(account.address);
  const [side, setSide] = useState<"long" | "short">("long");
  const [lev, setLev] = useState<(typeof LEVERAGES)[number]>("2");
  const [text, setText] = useState("");
  const tx = useTx();
  const isLong = side === "long";
  const margin = parseAmount(text, DECIMALS);
  const preview = margin && index && market.data ? perpPreview({ margin, leverage: Number(lev), index, isLong, longQty: market.data.longQty, shortQty: market.data.shortQty }) : null;

  const closed = live.data ? live.data.status !== "active" : trend.status !== "active";
  const stale = live.data ? !live.data.fresh : false;
  const error = (() => {
    if (text.trim() === "") return null;
    if (!margin) return "Enter an amount";
    if (account.authenticated && balance.data && margin > balance.data.raw) return "More than your USDC balance";
    if (preview && preview.net < PERP.minMargin) return `The smallest margin is ${money(PERP.minMargin + (PERP.minMargin * BigInt(lev) * PERP.feeBps) / 10_000n + 1n)} USDC`;
    if (preview && market.data && preview.sideNotionalAfter > market.data.cap) {
      const room = market.data.cap - (preview.sideNotionalAfter - preview.notional);
      return room > 0n ? `This side has room for ${money(room)} USDC more notional` : "This side is at its open interest cap";
    }
    return null;
  })();

  const submit = async () => {
    if (!margin || !index) return;
    const r = await tx.run(() => account.trade(session.perpOpen(trend.id, isLong, margin, Number(lev) * 10_000, acceptableIndex(index, isLong, SLIPPAGE_BPS))), {
      action: `Open ${side} ${lev}x`,
      done: `Opened ${side} ${lev}x with ${money(margin)} USDC`,
      pending: confirmNote(account.kind, false),
    });
    if (r) {
      setText("");
      void client.invalidateQueries({ queryKey: ["perp-positions"] });
      void client.invalidateQueries({ queryKey: ["perp-market"] });
      void client.invalidateQueries({ queryKey: ["usdc"] });
      void client.invalidateQueries({ queryKey: portfolioKey(account.address) });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Segmented
        label="Side"
        value={side}
        onChange={(v) => {
          setSide(v);
          tx.reset();
        }}
        options={[
          { value: "long", label: "Long", tone: "up" },
          { value: "short", label: "Short", tone: "down" },
        ]}
      />
      <AmountField label="Margin" unit="USDC" value={text} onChange={setText} balance={account.authenticated ? (balance.data?.raw ?? null) : undefined} decimals={DECIMALS} error={error} testId="perp-margin" />
      <div className="flex items-center justify-between gap-3">
        <span className="font-strong text-[12.5px] text-text-2">Leverage</span>
        <Segmented label="Leverage" size="sm" value={lev} onChange={setLev} className="w-[168px]" options={LEVERAGES.map((l) => ({ value: l, label: `${l}x` }))} />
      </div>
      <div className="flex flex-col gap-2 rounded-xl border border-line px-3.5 py-3" data-testid="perp-preview">
        <Row label="Entry index" value={<Num value={index} format={TWO} />} />
        <Row label="Position size" value={preview ? <Usdc raw={preview.notional} /> : "-"} />
        <Row
          label="Each index point"
          value={
            preview ? (
              <>
                <Num value={preview.perPoint} prefix={isLong ? "+" : "-"} /> USDC if it rises
              </>
            ) : (
              "-"
            )
          }
        />
        <Row label="Opening fee" value={preview ? <Usdc raw={preview.fee} /> : "-"} tone="muted" />
        <Row label="Liquidation index" value={preview ? (preview.liquidationIndex === null ? (isLong ? "None above 0" : `None below ${INDEX_MAX}`) : <Num value={preview.liquidationIndex} format={TWO} />) : "-"} tone={preview?.liquidationIndex != null ? "warn" : undefined} />
        <Row label="Funding" value={preview ? fundingText(preview.fundingPerHourPct) : market.data ? fundingText(0) : "-"} tone="muted" />
        <Row label="Most you can lose" value={margin ? <Usdc raw={margin} /> : "-"} tone="down" />
      </div>
      {closed ? (
        <Note tone="warn">This trend is no longer active, so new positions are closed. Open positions can still be closed, and settle at the final index if it retires.</Note>
      ) : stale && trend.rotatingOut ? (
        <Note tone="warn">This trend is rotating out, so its index no longer updates and new positions are closed. Open positions settle at its last index when it retires.</Note>
      ) : stale ? (
        <Note tone="warn">The index is between reports. Opening resumes with the next one, usually within a minute.</Note>
      ) : null}
      <SubmitButton tone={isLong ? "up" : "down"} disabled={!preview || Boolean(error) || closed || stale} loading={tx.busy} onClick={() => void submit()} testId="perp-submit" passkey={account.kind === "wallet"}>
        Open {side} {lev}x
      </SubmitButton>
      <TxStatus tx={tx} filledLabel="Opened" testId="perp-tx" />
      <Note>Isolated margin: a position can lose its margin and never more. Funding moves from the crowded side to the other every second, and closing costs 0.1% of size. Positions are liquidated when equity falls below 10% of size.</Note>
      {account.authenticated ? <Positions trend={trend} index={index} /> : null}
    </div>
  );
}

function Positions({ trend, index }: { trend: Trend; index: number | undefined }) {
  const account = useAccount();
  const positions = usePerpPositions(account.address);
  const mine = (positions.data ?? []).filter((p) => p.trend === trend.id);
  // data-state tells a test (and nothing visible) whether the list has loaded or is simply empty.
  if (mine.length === 0) return <div hidden data-testid="perp-positions" data-state={positions.isFetched ? "loaded" : "loading"} />;
  return (
    <Section title="Your positions" className="border-t border-line pt-5">
      <ul className="flex flex-col gap-3" data-testid="perp-positions" data-state="loaded">
        {mine.map((p) => (
          <PositionRow key={p.id} p={p} index={index} retired={trend.status === "retired"} />
        ))}
      </ul>
    </Section>
  );
}

export function PositionRow({ p, index, retired, onClosed }: { p: PerpPositionView; index: number | undefined; retired: boolean; onClosed?: (close: PerpClose, hash: string) => void }) {
  const account = useAccount();
  const client = useQueryClient();
  const tx = useTx();
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const add = parseAmount(text, DECIMALS);
  const n = perpNumbers({ qty: p.qty, margin: p.margin, equity: p.equity, notional: p.notional, liquidationIndex: p.liquidationIndex });
  const pnlRaw = p.equity - p.margin;

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["perp-positions"] });
    void client.invalidateQueries({ queryKey: ["usdc"] });
    void client.invalidateQueries({ queryKey: portfolioKey(account.address) });
  };
  const close = async () => {
    const at = index ?? p.index;
    const r = await tx.run(() => account.trade(session.perpClose(p.id, acceptableIndex(at, !p.isLong, SLIPPAGE_BPS))), { action: `Close ${p.isLong ? "long" : "short"}`, done: `${p.isLong ? "Long" : "Short"} closed`, pending: confirmNote(account.kind, false) });
    if (r) {
      const closed = r.outcome ? perpClosesOf(r.outcome).find((c) => c.id === p.id) : undefined;
      if (closed) onClosed?.(closed, r.hash);
      refresh();
    }
  };
  const topUp = async () => {
    if (!add) return;
    if (await tx.run(() => account.ownerExecute([ownerCall(owner.addMargin(p.id, add))]), { action: "Add margin", done: "Margin added", pending: confirmNote(account.kind, true) })) {
      setText("");
      setAdding(false);
      refresh();
    }
  };

  // Under half a cent shows as 0.00: neither a gain nor a loss.
  const pnlTone = Math.abs(n.pnl) < 0.005 ? "text-text-2" : pnlRaw > 0n ? "text-up" : "text-down";
  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-line px-3.5 py-3" data-testid="perp-position">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5">
            <Badge tone={p.isLong ? "up" : "down"}>{p.isLong ? "Long" : "Short"}</Badge>
            {p.liquidatable ? (
              <Badge tone="warn" icon={<AlertTriangle className="size-3" aria-hidden />}>
                At risk
              </Badge>
            ) : null}
          </div>
          <p className="num mt-1.5 text-[12.5px] text-text-2">
            {points(p.entryIndex)} to {points(index ?? p.index)}, margin {money(p.margin)}
          </p>
        </div>
        <div className="text-right">
          <p className={cn("num font-strong text-[15px]", pnlTone)}>
            <Num value={n.pnl} format={SIGNED} flash={false} /> USDC
          </p>
          <p className={cn("num text-[12px]", pnlTone)}>
            <Num value={n.pnlPct} format={{ minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: "exceptZero" }} suffix="%" flash={false} />
          </p>
        </div>
      </div>
      {n.liquidationIndex !== null ? <p className="num text-[12px] text-text-3">Liquidation near {points(n.liquidationIndex)}</p> : null}
      {retired ? (
        <Note>The trend retired, so this position settles at its final index, with no fee.</Note>
      ) : adding ? (
        <div className="flex flex-col gap-2">
          <AmountField label="Add margin" unit="USDC" value={text} onChange={setText} decimals={DECIMALS} testId="perp-add-margin" />
          <div className="grid grid-cols-2 gap-2">
            <Button tone="ghost" onClick={() => setAdding(false)} disabled={tx.busy}>
              Cancel
            </Button>
            <Button tone="secondary" disabled={!add} loading={tx.busy} onClick={() => void topUp()} icon={account.kind === "passkey" ? <Fingerprint className="size-4" aria-hidden /> : undefined}>
              Add {add ? tokenAmount(add, DECIMALS) : ""}
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Button tone="secondary" size="sm" onClick={() => setAdding(true)} disabled={tx.busy}>
            Add margin
          </Button>
          <Button tone="danger" size="sm" loading={tx.busy} onClick={() => void close()} data-testid="perp-close">
            Close
          </Button>
        </div>
      )}
      <TxStatus tx={tx} filledLabel="Done" testId="perp-position-tx" />
    </li>
  );
}
