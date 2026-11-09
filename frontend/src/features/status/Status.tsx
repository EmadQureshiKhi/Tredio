"use client";
import { Activity, Boxes, FileCode2, Fuel, Radio } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, Card, cn, ErrorNote, ExplorerLink, RefreshIcon, Skeleton } from "@/components/ui";
import { explorerAddress } from "@/lib/config";
import type { SystemStatus } from "@/lib/api";
import { integer, shortAddress } from "@/lib/format";
import { useTrends } from "@/lib/hooks/queries";
import { useNow } from "@/features/portfolio/parts";
import { CONTRACT_LABELS, serviceInfo, useStatusPage } from "./data";

// #mainnet: this file branches on the network (testnet or mainnet); MAINNET.md lists what changes.

/** Seconds as "8s", "4m 12s" or "3h 5m". */
function age(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Public system status: every service and the oracle, refreshed every ten seconds. */
export default function Status() {
  const status = useStatusPage();
  const now = useNow();
  const s = status.data;
  // Ages are as of the check; keep them ticking until the next one.
  const since = s ? Math.max(0, now / 1000 - s.at) : 0;
  return (
    <div className="flex flex-col gap-6 lg:gap-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="font-display text-[30px] leading-[1.1] text-text sm:text-[36px]">System status</h1>
          <p className="mt-2 max-w-2xl text-[14px] leading-[22px] text-text-2">The live health of everything behind Tredio, checked every ten seconds.</p>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <button
            type="button"
            onClick={() => void status.refetch()}
            disabled={status.isFetching}
            className="flex h-8 items-center gap-2 rounded-full border border-line bg-surface px-3 text-[12.5px] text-text-2 transition-colors hover:border-line-strong hover:text-text disabled:cursor-default"
            data-testid="status-refresh"
          >
            <RefreshIcon spinning={status.isFetching} className="size-3.5" />
            {s ? <span className="num">Checked {age(since)} ago</span> : "Checking"}
          </button>
        </div>
      </header>

      {status.isLoading ? <StatusSkeleton /> : null}
      {status.error && !s ? <ErrorNote message={`${status.error.message} The status of the services cannot be checked right now.`} onRetry={() => void status.refetch()} /> : null}
      {s ? (
        <>
          <Overall s={s} since={since} stale={status.isError} />
          <div className="grid gap-6 lg:grid-cols-2">
            <OracleCard s={s} since={since} />
            <ChainCard s={s} since={since} />
          </div>
          <ServicesCard s={s} since={since} />
          <ContractsCard s={s} />
          <FleetCard s={s} />
        </>
      ) : null}
    </div>
  );
}

function Dot({ ok, pulse }: { ok: boolean; pulse?: boolean }) {
  return <span className={cn("inline-block size-2.5 shrink-0 rounded-full", ok ? "bg-up" : "bg-down", pulse && ok && "live-dot")} aria-hidden />;
}

function StateBadge({ ok, testId }: { ok: boolean; testId?: string }) {
  return (
    <Badge tone={ok ? "up" : "down"} className="min-w-[52px] justify-center">
      <span data-testid={testId} data-ok={ok}>
        {ok ? "Up" : "Down"}
      </span>
    </Badge>
  );
}

function Overall({ s, since, stale }: { s: SystemStatus; since: number; stale: boolean }) {
  // A service that answered but reported a problem (a low balance) is not "not answering": say which is which.
  const silent = [...s.services.filter((x) => !x.ok && x.latencyMs === null).map((x) => serviceInfo(x.name).label), ...(s.oracle.ok ? [] : ["the attention oracle"]), ...(s.chain.ok ? [] : ["the NEAR head"])];
  const troubled = [
    ...s.services.filter((x) => !x.ok && x.latencyMs !== null).map((x) => `${serviceInfo(x.name).label} (${x.issue ?? "reports a problem"})`),
    ...(s.contracts ?? []).filter((c) => !c.ok).map((c) => `the ${c.role} contract (${c.freeNear === null ? "balance unreadable" : "too little NEAR for its storage"})`),
  ];
  const count = silent.length + troubled.length;
  const problems = [silent.length ? `not answering: ${silent.join(", ")}` : null, troubled.length ? `reporting a problem: ${troubled.join(", ")}` : null].filter(Boolean).join("; ");
  const lastRun = s.oracle.lastRunAgeSec === null ? null : s.oracle.lastRunAgeSec + since;
  return (
    <section aria-label="Overall status" className="relative overflow-hidden rounded-[24px] border border-line bg-surface px-5 py-6 sm:px-8 sm:py-7" data-testid="status-overall" data-ok={s.ok}>
      <div aria-hidden className={cn("pointer-events-none absolute -right-24 -top-28 size-72 rounded-full blur-3xl", s.ok ? "bg-up-soft" : "bg-warn-soft")} />
      <div className="relative flex items-center gap-3">
        <span className={cn("flex size-10 items-center justify-center rounded-full", s.ok ? "bg-up-soft text-up" : "bg-warn-soft text-warn")}>
          <Activity className="size-5" aria-hidden />
        </span>
        <p className="font-display text-[28px] leading-tight text-text sm:text-[34px]">{s.ok ? "All systems live" : "Some systems need attention"}</p>
      </div>
      <p className="relative mt-3 max-w-2xl text-[14px] leading-[22px] text-text-2">
        {s.ok
          ? `Every service answered and the oracle measured attention ${lastRun === null ? "recently" : `${age(lastRun)} ago`}.`
          : `${count === 1 ? "One part is" : `${count} parts are`} ${problems}. Positions and funds stay safe; actions that need ${count === 1 ? "it" : "them"} wait until ${count === 1 ? "it is" : "they are"} back.`}
      </p>
      {stale ? <p className="relative mt-2 text-[12.5px] text-warn">The last check failed; showing the previous result.</p> : null}
    </section>
  );
}

function Fact({ label, value, tone, testId }: { label: string; value: ReactNode; tone?: "up" | "down" | "warn"; testId?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[13.5px]">
      <span className="text-text-2">{label}</span>
      <span className={cn("num text-right font-strong", tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "warn" ? "text-warn" : "text-text")} data-testid={testId}>
        {value}
      </span>
    </div>
  );
}

function OracleCard({ s, since }: { s: SystemStatus; since: number }) {
  const trends = useTrends();
  const lastRun = s.oracle.lastRunAgeSec === null ? null : s.oracle.lastRunAgeSec + since;
  const live = trends.data?.trends.length;
  return (
    <Card className="flex flex-col gap-4 p-5 sm:p-6" data-testid="status-oracle">
      <div className="flex items-start justify-between gap-3">
        <span className="flex items-center gap-2.5">
          <Radio className="size-[18px] text-primary" aria-hidden />
          <h2 className="whitespace-nowrap font-strong text-[15px] text-text">Attention oracle</h2>
        </span>
        <StateBadge ok={s.oracle.ok} testId="oracle-state" />
      </div>
      <div>
        <p className="text-[11.5px] uppercase tracking-[0.08em] text-text-3">Last measurement</p>
        <p className="num-display mt-1 font-display text-[40px] leading-none text-text" data-testid="oracle-age">
          {lastRun === null ? "Never" : `${age(lastRun)} ago`}
        </p>
      </div>
      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <Fact label="Live trends" value={live === undefined ? "..." : integer(live)} testId="live-trends" />
        <Fact label="Trends behind on measurements" value={integer(s.oracle.staleTrends)} tone={s.oracle.staleTrends > 0 ? "warn" : undefined} testId="stale-trends" />
      </div>
      <p className="text-[13px] leading-5 text-text-2">The Tredio oracle measures attention on X, Telegram, Bluesky, news, Wikipedia, Hacker News and smart-money flows every minute and records each trend&rsquo;s index. Perps trade at it, and every Up/Down series settles on it.</p>
    </Card>
  );
}

/** The NEAR network the contracts run on, as the API sees its newest block. */
function ChainCard({ s, since }: { s: SystemStatus; since: number }) {
  const age2 = s.chain.ageSec === null ? null : s.chain.ageSec + since;
  return (
    <Card className="flex flex-col gap-4 p-5 sm:p-6" data-testid="status-chain">
      <div className="flex items-start justify-between gap-3">
        <span className="flex items-center gap-2.5">
          <Boxes className="size-[18px] text-primary" aria-hidden />
          <h2 className="whitespace-nowrap font-strong text-[15px] text-text">NEAR {s.network === "mainnet" ? "mainnet" : "testnet"}</h2>
        </span>
        <StateBadge ok={s.chain.ok} testId="chain-state" />
      </div>
      <div>
        <p className="text-[11.5px] uppercase tracking-[0.08em] text-text-3">Newest block</p>
        <p className="num-display mt-1 font-display text-[40px] leading-none text-text" data-testid="chain-height">
          {s.chain.height === null ? "-" : integer(s.chain.height)}
        </p>
      </div>
      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <Fact label="Block age" value={age2 === null ? "-" : age(age2)} tone={s.chain.ok ? undefined : "warn"} />
      </div>
      <p className="text-[13px] leading-5 text-text-2">Every market, account and session lives in Tredio&rsquo;s contracts on NEAR. Blocks land about every second; trades from a session go straight to it.</p>
    </Card>
  );
}

/** A process that started this long ago or less was restarted recently: worth saying. */
const RECENT_START_SEC = 15 * 60;

function ServicesCard({ s, since }: { s: SystemStatus; since: number }) {
  return (
    <Card className="overflow-hidden" data-testid="status-services">
      <div className="px-5 pb-4 pt-5 sm:px-6">
        <h2 className="font-strong text-[15px] text-text">Services</h2>
        <p className="mt-0.5 text-[13px] text-text-2">Each one&rsquo;s health endpoint, as Tredio&rsquo;s API reaches it.</p>
      </div>
      {s.services.length === 0 ? (
        <p className="border-t border-line px-5 py-4 text-[13px] text-text-3 sm:px-6">This API does not check any services.</p>
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {s.services.map((x) => {
            const info = serviceInfo(x.name);
            return (
              <li key={x.name} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-start sm:gap-6 sm:px-6" data-testid="status-service" data-name={x.name} data-ok={x.ok}>
                <div className="flex items-center justify-between gap-3 sm:w-[180px] sm:shrink-0 sm:justify-start">
                  <span className="flex items-center gap-2.5 font-strong text-[14px] text-text">
                    <Dot ok={x.ok} />
                    {info.label}
                  </span>
                  <span className="num text-[12.5px] text-text-3 sm:hidden">{x.latencyMs !== null ? `${x.latencyMs} ms` : x.ok ? "" : "no answer"}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] leading-5 text-text-2">{info.body}</p>
                  {!x.ok && x.latencyMs !== null ? <p className="mt-1 text-[12.5px] leading-[18px] text-warn">Answered, and reports: {x.issue ?? "a problem"}.</p> : null}
                  {x.startedAt && s.at - x.startedAt + since < RECENT_START_SEC ? (
                    <p className="mt-1 text-[12.5px] leading-[18px] text-text-3" data-testid="service-restarted">
                      Restarted {age(s.at - x.startedAt + since)} ago.
                    </p>
                  ) : null}
                </div>
                <div className="hidden shrink-0 items-center gap-3 sm:flex">
                  <span className="num w-[64px] text-right text-[12.5px] text-text-3">{x.latencyMs !== null ? `${x.latencyMs} ms` : x.ok ? "" : "no answer"}</span>
                  <StateBadge ok={x.ok} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/**
 * Each Tredio contract's NEAR above what its storage locks. Every write adds state the account pays
 * for; one that runs out refuses every write until it is topped up, which the top-up service does.
 */
function ContractsCard({ s }: { s: SystemStatus }) {
  const contracts = s.contracts ?? [];
  if (contracts.length === 0) return null;
  return (
    <Card className="overflow-hidden" data-testid="status-contracts">
      <div className="flex items-start gap-2.5 px-5 pb-4 pt-5 sm:px-6">
        <FileCode2 className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
        <div>
          <h2 className="font-strong text-[15px] text-text">Contracts</h2>
          <p className="mt-0.5 text-[13px] text-text-2">The NEAR each contract holds beyond what its storage locks. A contract that runs out cannot record anything new, so Tredio tops each one up before it gets there.</p>
        </div>
      </div>
      <ul className="grid divide-y divide-line border-t border-line sm:grid-cols-2 sm:divide-y-0">
        {contracts.map((c, i) => (
          <li
            key={c.account}
            className={cn("flex items-center justify-between gap-3 px-5 py-3.5 sm:px-6", i >= 2 && "sm:border-t sm:border-line", i % 2 === 1 && "sm:border-l sm:border-line")}
            data-testid="status-contract"
            data-role={c.role}
            data-ok={c.ok}
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <Dot ok={c.ok} />
              <span className="flex min-w-0 flex-col">
                <span className="font-strong text-[14px] text-text">{CONTRACT_LABELS[c.role] ?? c.role}</span>
                <ExplorerLink href={explorerAddress(c.account)} className="num truncate font-mono text-[12px] text-text-3">
                  {shortAddress(c.account)}
                </ExplorerLink>
              </span>
            </span>
            <span className="flex shrink-0 flex-col items-end">
              <span className="num font-strong text-[13.5px] text-text">{c.freeNear === null ? "-" : `${c.freeNear} NEAR`}</span>
              <span className={cn("text-[12px]", c.ok ? (c.low ? "text-warn" : "text-text-3") : "text-down")}>{c.ok ? (c.low ? "Low, refill due" : "Free") : "Needs NEAR"}</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * The fleet: each account a service sends from, its NEAR and its gas keys. A gas key carries its
 * own prepaid NEAR and parallel nonce lanes, so a service sends several transactions at once.
 */
function FleetCard({ s }: { s: SystemStatus }) {
  if (s.fleet.length === 0) return null;
  return (
    <Card className="overflow-hidden" data-testid="status-fleet">
      <div className="flex items-start gap-2.5 px-5 pb-4 pt-5 sm:px-6">
        <Fuel className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
        <div>
          <h2 className="font-strong text-[15px] text-text">Service fleet</h2>
          <p className="mt-0.5 text-[13px] text-text-2">The accounts Tredio&rsquo;s services send from, with their gas keys: each key holds its own prepaid NEAR for gas and parallel nonce lanes, so a service sends many transactions at once.</p>
        </div>
      </div>
      <ul className="divide-y divide-line border-t border-line">
        {s.fleet.map((w) => (
          <li key={`${w.service}-${w.account}`} className="flex flex-col gap-3 px-5 py-4 sm:px-6" data-testid="fleet-wallet" data-account={w.account}>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <span className="flex min-w-0 items-center gap-2">
                <span className="font-strong text-[14px] text-text">{serviceInfo(w.service).label}</span>
                {w.label && w.label.toLowerCase() !== w.service.toLowerCase() ? <span className="truncate text-[12.5px] text-text-3">{w.label}</span> : null}
              </span>
              <span className="flex items-center gap-3">
                <ExplorerLink href={explorerAddress(w.account)} className="num font-mono text-[12.5px] text-text-2">
                  {shortAddress(w.account)}
                </ExplorerLink>
                <span className="num font-strong text-[13.5px] text-text">{w.balance === null ? "-" : `${Number(w.balance).toLocaleString("en-US", { maximumFractionDigits: 3 })} NEAR`}</span>
              </span>
            </div>
            {w.gasKeys.length > 0 ? (
              <ul className="grid gap-2 sm:grid-cols-2">
                {w.gasKeys.map((k) => (
                  <li key={k.publicKey} className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2 text-[12.5px]">
                    <span className="num truncate font-mono text-text-2">Gas key {shortAddress(k.publicKey.replace(/^ed25519:/, ""))}</span>
                    <span className="num shrink-0 text-text">
                      {Number(k.balance).toLocaleString("en-US", { maximumFractionDigits: 3 })} NEAR · {k.nonces} {k.nonces === 1 ? "lane" : "lanes"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12.5px] text-text-3">Sends with a regular key, one transaction at a time.</p>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function StatusSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden>
      <Skeleton className="h-[148px] rounded-[24px]" />
      <Skeleton className="h-[300px] rounded-[18px]" />
      <Skeleton className="h-[320px] rounded-[18px]" />
    </div>
  );
}
