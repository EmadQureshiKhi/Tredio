"use client";
import { Boxes, Database, Fuel, Landmark } from "lucide-react";
import { Notice } from "@/src/components/ui/Notice";
import { NEAR_NETWORK } from "@/src/lib/config";
import { formatNumber } from "@/src/lib/format";
import { Card, Row, Rows } from "@/src/modules/operations/parts";
import type { SystemReport, WalletRow } from "@/src/types/admin";
import { Age, StateChip } from "./parts";

// #mainnet: this file branches on the network (testnet or mainnet); MAINNET.md lists what changes.

const near = (v: string | null) => (v === null ? "?" : `${Number(v).toLocaleString("en-US", { maximumFractionDigits: Number(v) >= 100 ? 0 : 3 })} NEAR`);
const secs = (s: number) => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);
const NEARBLOCKS: Record<string, string> = { testnet: "https://testnet.nearblocks.io", mainnet: "https://nearblocks.io" };

function AccountLink({ account, network }: { account: string; network: string }) {
  return (
    <a href={`${NEARBLOCKS[network] ?? NEARBLOCKS.testnet}/address/${account}`} target="_blank" rel="noreferrer" className="break-all font-mono text-xs text-fg underline-offset-2 hover:underline" title={account}>
      {account.length > 28 ? `${account.slice(0, 12)}…${account.slice(-8)}` : account}
    </a>
  );
}

/** The chain head the backend reads and the indexer's progress behind it. */
export function ChainSection({ r, now }: { r: SystemReport; now: number }) {
  const c = r.chain;
  const ix = r.indexer;
  return (
    <>
      <Card icon={<Boxes size={16} aria-hidden />} title={`NEAR ${c.network}`} status={<StateChip state={c.ok ? (c.headAgeSec !== null && c.headAgeSec > 30 ? "degraded" : "up") : "down"} />} data-testid="chain-card">
        <Rows>
          <Row label="Head">{c.head !== null ? `#${formatNumber(c.head)}` : "?"}</Row>
          <Row label="Head time">
            <Age at={c.headAt} now={now} />
          </Row>
        </Rows>
        {c.error ? <p className="mt-2 [overflow-wrap:anywhere] font-mono text-xs text-bad">{c.error}</p> : null}
      </Card>
      <Card
        icon={<Database size={16} aria-hidden />}
        title="Indexer"
        status={<StateChip state={!ix.configured ? "off" : ix.error ? "down" : (ix.lagSec ?? 0) > 600 ? "down" : (ix.lagSec ?? 0) > 60 ? "degraded" : "up"} />}
        data-testid="indexer-card"
      >
        {ix.configured ? (
          <Rows>
            <Row label="Block">{ix.progressBlock !== null ? `#${formatNumber(ix.progressBlock)}` : "?"}</Row>
            <Row label="Behind">{ix.lagBlocks !== null ? `${formatNumber(ix.lagBlocks)} blocks${ix.lagSec !== null ? `, ${secs(ix.lagSec)}` : ""}` : "?"}</Row>
            <Row label="Events">{ix.eventsProcessed !== null ? formatNumber(ix.eventsProcessed) : "?"}{ix.eventsPerMin !== null ? <span className="block text-xs text-subtle">{ix.eventsPerMin} a minute</span> : null}</Row>
          </Rows>
        ) : (
          <p className="text-sm text-muted">Not configured: the backend has no INDEXER_DATABASE_URL.</p>
        )}
        {ix.error ? <p className="mt-2 [overflow-wrap:anywhere] font-mono text-xs text-bad">{ix.error}</p> : null}
      </Card>
    </>
  );
}

function below(w: WalletRow) {
  return w.balance !== null && w.min !== null && Number(w.balance) < Number(w.min);
}

/** The treasury and every service account with its gas keys. */
export function WalletsSection({ wallets }: { wallets: SystemReport["wallets"] }) {
  const t = wallets.treasury;
  const network = NEAR_NETWORK;
  return (
    <div className="space-y-3">
      {t ? (
        <Card icon={<Landmark size={16} aria-hidden />} title="Treasury" status={<StateChip state={t.low ? "degraded" : "up"} />} data-testid="treasury-card">
          {t.low ? (
            <Notice tone="bad" title="The treasury is low">
              It holds {near(t.balance)}. Send NEAR to <span className="font-mono">{t.account}</span> so the top-up service can keep the services funded.
            </Notice>
          ) : null}
          <Rows>
            <Row label="Account">
              <AccountLink account={t.account} network={network} />
            </Row>
            <Row label="Balance">{near(t.balance)}</Row>
            <Row label="Spendable">
              {near(t.spendable)} <span className="text-subtle">above the {near(t.floor)} floor</span>
            </Row>
            <Row label="Burn">{t.burnPerDay !== null ? `${near(t.burnPerDay)} a day` : "measuring"}{t.runwayDays !== null ? <span className="block text-xs text-subtle">{t.runwayDays.toFixed(1)} days of runway</span> : null}</Row>
          </Rows>
        </Card>
      ) : (
        <p className="text-sm text-muted">The top-up service is not reporting, so the treasury is unknown.</p>
      )}
      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full min-w-[640px] text-sm" data-testid="wallets-table">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-subtle">
              <th className="px-3 py-2 font-medium">Account</th>
              <th className="px-3 py-2 text-right font-medium">Balance</th>
              <th className="px-3 py-2 text-right font-medium">Min / target</th>
              <th className="px-3 py-2 text-right font-medium">
                <Fuel size={12} className="mr-1 inline" aria-hidden />
                Gas keys
              </th>
              <th className="px-3 py-2 text-right font-medium">Burn a day</th>
            </tr>
          </thead>
          <tbody>
            {wallets.rows.map((w) => (
              <tr key={`${w.name}:${w.account}`} className="border-b border-line last:border-0">
                <td className="px-3 py-2">
                  <span className="block text-fg">{w.name}</span>
                  <AccountLink account={w.account} network={network} />
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${below(w) ? "text-bad" : "text-fg"}`}>{near(w.balance)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted">
                  {w.min !== null ? near(w.min) : "-"}
                  {w.target !== null ? <span className="block text-xs text-subtle">to {near(w.target)}</span> : null}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted">{w.gasKeys > 0 ? `${w.gasKeys}, ${near(w.gasKeyBalance)}` : "-"}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted">{w.burnPerDay !== null ? near(w.burnPerDay) : "-"}</td>
              </tr>
            ))}
            {wallets.rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-sm text-muted">
                  No service reports an account yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
