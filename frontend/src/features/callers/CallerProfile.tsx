"use client";
import { Bot, Check, Copy, Link2, Megaphone, PenLine, UserRound } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Avatar } from "@/components/shell/AppShell";
import { Badge, Button, ButtonLink, Card, cn, Empty, ErrorNote, ExplorerLink, Segmented, Skeleton } from "@/components/ui";
import { useAccount } from "@/lib/account/AccountProvider";
import { ApiError } from "@/lib/api";
import { explorerAddress } from "@/lib/config";
import { compact, shortAddress, usdc } from "@/lib/format";
import { useTrends } from "@/lib/hooks/queries";
import { useCopy } from "@/lib/hooks/useCopy";
import { isBot, useAccountHistory, useCaller, useFollows, useHlAddress, useLeaderboard, usePerformance } from "@/features/autopilot/shared/data";
import { SectionTitle, StaleNote, StatTile } from "@/features/autopilot/shared/kit";
import { EquityChart, StatsGrid } from "@/features/autopilot/shared/Performance";
import { FollowSheet } from "@/features/copy/FollowSheet";
import { CallList } from "./CallList";
import { CallSheet } from "./CallSheet";
import { useCallerIdentity } from "./identity";

/** A NEAR account id (named, or a derived `0u...` account) rather than a caller's handle or 64-hex identity. */
const isAccountId = (id: string) => /^[a-z0-9._-]{2,64}$/.test(id) && (id.includes(".") || /^0u[a-z0-9]{40,}$/.test(id));

/**
 * /c/[id]: a caller by identity (64 hex characters) or handle (track record, calls, linked trading
 * account and its records), or, for a NEAR trading account, its record alone.
 */
export default function CallerProfile({ id }: { id: string }) {
  const account = isAccountId(id.toLowerCase());
  const caller = useCaller(account ? null : id);
  const notCaller = !caller.data && caller.error instanceof ApiError && caller.error.status === 404;
  if (account) return <TraderProfile account={id.toLowerCase()} />;
  if (caller.isLoading) return <ProfileSkeleton />;
  if (notCaller) {
    return (
      <Card>
        <Empty icon={<UserRound className="size-6" />} title={`No caller named @${id}`} body="Handles are 3 to 20 letters, digits or underscores. Check the link, or find callers on the leaderboard." action={<ButtonLink href="/leaders">Leaderboard</ButtonLink>} />
      </Card>
    );
  }
  if (!caller.data) return caller.error ? <ErrorNote message="This profile could not load." onRetry={() => void caller.refetch()} /> : <ProfileSkeleton />;
  return (
    <>
      {caller.isRefetchError ? (
        <div className="mb-4">
          <StaleNote onRetry={() => void caller.refetch()} what="this profile" />
        </div>
      ) : null}
      <Caller data={caller.data} />
    </>
  );
}

type CallerData = NonNullable<ReturnType<typeof useCaller>["data"]>;

function Caller({ data }: { data: CallerData }) {
  const { caller, stats, calls } = data;
  const trends = useTrends();
  const me = useCallerIdentity();
  const account = useAccount();
  const follows = useFollows();
  const linkedHl = useHlAddress(data.caller.linked_account);
  const [filter, setFilter] = useState<"all" | "open" | "resolved">("all");
  const [callOpen, setCallOpen] = useState(false);
  const [followOpen, setFollowOpen] = useState(false);
  const mine = me.known === caller.address;
  const name = caller.handle ? `@${caller.handle}` : shortAddress(caller.address);
  const shown = useMemo(() => calls.filter((c) => (filter === "all" ? true : filter === "open" ? c.outcome === "open" : c.outcome !== "open")), [calls, filter]);
  const linked = caller.linked_account;
  const following = linkedHl.data ? (follows.data?.follows ?? []).some((f) => f.leader.toLowerCase() === linkedHl.data) : false;
  const resolved = stats.hits + stats.misses;

  return (
    <div className="flex flex-col gap-8 [font-feature-settings:'calt'_0]" data-testid="caller-profile" data-caller={caller.address}>
      <section className="flex flex-col gap-5 rounded-[24px] border border-line bg-surface p-6 sm:flex-row sm:items-start sm:justify-between sm:p-8">
        <div className="flex min-w-0 gap-4">
          <Avatar address={caller.address} size={64} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate font-display text-[30px] leading-[1.1] text-text sm:text-[36px]" data-testid="caller-name">
                {name}
              </h1>
              {mine ? <Badge tone="primary">You</Badge> : null}
            </div>
            {caller.bio ? <p className="mt-2 max-w-xl break-words text-[14.5px] leading-[22px] text-text-2">{caller.bio}</p> : null}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <AddressChip label="Caller" address={caller.address} />
              {linked ? <AddressChip label="Trades as" address={linked} href={`/c/${linked}`} internal /> : null}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {mine ? (
            <>
              <Button icon={<Megaphone className="size-4" aria-hidden />} onClick={() => setCallOpen(true)} data-testid="profile-make-call">
                Make a call
              </Button>
              <ButtonLink tone="secondary" href="/settings#identity">
                <PenLine className="size-4" aria-hidden />
                Edit profile
              </ButtonLink>
            </>
          ) : linked && linkedHl.data && account.kind !== "wallet" && account.address?.toLowerCase() !== linked.toLowerCase() ? (
            <Button tone={following ? "secondary" : "primary"} icon={following ? <Check className="size-4" aria-hidden /> : undefined} onClick={() => (account.authenticated ? setFollowOpen(true) : account.login())} data-testid="profile-follow">
              {following ? "Following" : "Follow trades"}
            </Button>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="record-title" className="flex flex-col gap-3">
        <SectionTitle id="record-title" title="Track record" subtitle="Resolved by the attention oracle's own checkpoints" />
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5" data-testid="caller-stats">
          <StatTile size="lg" className="col-span-2 sm:col-span-1" label="Hit rate" value={resolved ? `${Math.round(stats.hitRate * 100)}%` : "-"} tone={resolved ? undefined : "muted"} hint={resolved ? `${stats.hits} of ${resolved} resolved` : "Nothing resolved yet"} />
          <StatTile label="Wilson score" value={resolved ? (stats.score * 100).toFixed(1) : "-"} hint="at 95% confidence" tone={resolved ? undefined : "muted"} />
          <StatTile label="Hits" value={stats.hits} tone={stats.hits ? "up" : undefined} />
          <StatTile label="Misses" value={stats.misses} tone={stats.misses ? "down" : undefined} />
          <StatTile label="Open" value={stats.open} />
        </div>
      </section>

      {linked ? (
        <>
          <AllMarketsRecord account={linked} />
          <TradingRecord account={linked} />
        </>
      ) : mine ? (
        <LinkHint />
      ) : null}

      <section aria-labelledby="calls-title" className="flex flex-col gap-3">
        <SectionTitle
          id="calls-title"
          title="Calls"
          subtitle={calls.length ? `${calls.length} made` : undefined}
          action={
            calls.length ? (
              <Segmented
                label="Show calls"
                size="sm"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all", label: "All" },
                  { value: "open", label: "Open" },
                  { value: "resolved", label: "Resolved" },
                ]}
              />
            ) : null
          }
        />
        {shown.length ? (
          <CallList calls={shown} trends={trends.data?.trends} />
        ) : (
          <Card>
            <Empty
              icon={<Megaphone className="size-6" />}
              title={calls.length ? "None here" : "No calls yet"}
              body={mine ? "Pick a live trend and say where its attention goes in 24 hours or 7 days." : "Calls show here as they are made."}
              action={mine && !calls.length ? <Button onClick={() => setCallOpen(true)}>Make your first call</Button> : undefined}
            />
          </Card>
        )}
      </section>
      {mine ? <CallSheet open={callOpen} onOpenChange={setCallOpen} /> : null}
      {linkedHl.data ? <FollowSheet leader={linkedHl.data} name={name} open={followOpen} onOpenChange={setFollowOpen} /> : null}
    </div>
  );
}

function LinkHint() {
  return (
    <Card className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex gap-3">
        <Link2 className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
        <p className="text-[13.5px] leading-5 text-text-2">Your calls are not tied to your trading account. Link them to show your trading record here and let people copy your Hyperliquid trades.</p>
      </div>
      <ButtonLink tone="secondary" size="sm" href="/settings#identity" className="shrink-0">
        Link in settings
      </ButtonLink>
    </Card>
  );
}

/** The linked account's Autopilot record. */
function TradingRecord({ account }: { account: string }) {
  const perf = usePerformance(account);
  return (
    <section aria-labelledby="trading-title" className="flex flex-col gap-3">
      <SectionTitle id="trading-title" title="Autopilot record" subtitle={`Autopilot and copied trades on Hyperliquid${perf.data ? ` · ${perf.data.followers} following` : ""}`} />
      <Card className="flex flex-col gap-4 p-5" data-testid="trading-record">
        {perf.data ? (
          <>
            <StatsGrid stats={perf.data.stats} wide />
            <EquityChart equity={perf.data.equity} height={200} />
          </>
        ) : perf.error ? (
          <ErrorNote message="The trading record could not load." onRetry={() => void perf.refetch()} />
        ) : (
          <Skeleton className="h-48 rounded-2xl" />
        )}
      </Card>
    </section>
  );
}

const PRODUCTS = [
  { key: "outcome", label: "Outcome markets" },
  { key: "perp", label: "Attention perps" },
  { key: "coin", label: "Trend coins" },
] as const;

/** The account's record across every product, from the indexer; hidden while it is unavailable. */
function AllMarketsRecord({ account }: { account: string }) {
  const h = useAccountHistory(account);
  const st = h.data?.account.stats;
  if (h.isLoading) return <Skeleton className="h-40 rounded-[var(--radius-card)]" />;
  if (!st) return null;
  return (
    <section aria-labelledby="all-title" className="flex flex-col gap-3">
      <SectionTitle id="all-title" title="Across Tredio" subtitle="Every market this account traded on NEAR, after fees" />
      <Card className="flex flex-col gap-4 p-5" data-testid="all-markets-record">
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <StatTile size="lg" className="col-span-2 sm:col-span-1" label="Realized PnL" value={usdc(st.realizedPnlUsdc, { sign: true })} tone={Math.abs(st.realizedPnlUsdc) < 0.005 ? undefined : st.realizedPnlUsdc > 0 ? "up" : "down"} hint={`fees ${usdc(st.feesPaidUsdc)} USDC`} />
          <StatTile label="Volume" value={compact(st.volumeUsdc)} hint="USDC" />
          <StatTile label="Win rate" value={st.closedTrades ? `${Math.round(st.winRate * 100)}%` : "-"} hint={`${st.wins} of ${st.closedTrades} closed`} tone={st.closedTrades ? undefined : "muted"} />
          <StatTile label="Trades" value={st.tradeCount} hint={st.liquidations ? `${st.liquidations} liquidated` : undefined} />
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 border-t border-line pt-4 sm:grid-cols-3">
          {PRODUCTS.map((p) => {
            const v = st.perProduct[p.key];
            return (
              <div key={p.key} className="flex items-baseline justify-between gap-2 text-[13px] sm:flex-col sm:items-start sm:gap-0.5">
                <dt className="text-text-3">{p.label}</dt>
                <dd className={cn("num font-strong", Math.abs(v) < 0.005 ? "text-text-2" : v > 0 ? "text-up" : "text-down")}>{usdc(v, { sign: true })}</dd>
              </div>
            );
          })}
        </dl>
      </Card>
    </section>
  );
}

/** A NEAR trading account: the Tredio bot, or anyone's record across markets and on Autopilot. */
function TraderProfile({ account }: { account: string }) {
  const board = useLeaderboard();
  const me = useAccount();
  const follows = useFollows();
  const hl = useHlAddress(account);
  const [followOpen, setFollowOpen] = useState(false);
  const bot = isBot(account);
  const linkedCaller = (board.data?.callers ?? []).find((c) => c.linked_account?.toLowerCase() === account) ?? null;
  const following = hl.data ? (follows.data?.follows ?? []).some((f) => f.leader.toLowerCase() === hl.data) : false;
  const self = me.address?.toLowerCase() === account;
  return (
    <div className="flex flex-col gap-8 [font-feature-settings:'calt'_0]" data-testid="trader-profile">
      <section className="relative flex flex-col gap-5 overflow-hidden rounded-[24px] border border-line bg-surface p-6 sm:flex-row sm:items-start sm:justify-between sm:p-8">
        {bot ? <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-primary-soft blur-3xl" /> : null}
        <div className="relative flex min-w-0 gap-4">
          {bot ? (
            <span className="flex size-16 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary">
              <Bot className="size-8" aria-hidden />
            </span>
          ) : (
            <Avatar address={account} size={64} />
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate font-display text-[30px] leading-[1.1] text-text sm:text-[36px]">{bot ? "Tredio bot" : linkedCaller?.handle ? `@${linkedCaller.handle}` : shortAddress(account)}</h1>
              {bot ? <Badge tone="primary">Official</Badge> : null}
              {self ? <Badge tone="primary">You</Badge> : null}
            </div>
            <p className="mt-2 max-w-xl text-[14.5px] leading-[22px] text-text-2">
              {bot
                ? "Tredio's own account. It trades public Autopilot rules on Hyperliquid with the same engine and limits as yours, so every trade it makes is one your rules could make."
                : "A trading account's record on Tredio: every market it traded on NEAR, and its Autopilot trades on Hyperliquid."}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <AddressChip label="Account" address={account} href={explorerAddress(account)} />
              {linkedCaller ? (
                <Link href={`/c/${linkedCaller.handle ?? linkedCaller.address}`} className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line px-2.5 text-[12px] text-text-2 hover:text-text">
                  Caller {linkedCaller.handle ? `@${linkedCaller.handle}` : shortAddress(linkedCaller.address)}
                </Link>
              ) : null}
            </div>
          </div>
        </div>
        {!self && hl.data && me.kind !== "wallet" ? (
          <Button
            className="relative shrink-0"
            size="lg"
            tone={following ? "secondary" : "primary"}
            icon={following ? <Check className="size-4" aria-hidden /> : undefined}
            onClick={() => (me.authenticated ? setFollowOpen(true) : me.login())}
            data-testid="profile-follow"
          >
            {following ? "Following" : bot ? "Follow the Tredio bot" : "Follow trades"}
          </Button>
        ) : null}
      </section>
      <AllMarketsRecord account={account} />
      <TradingRecord account={account} />
      {hl.data ? <FollowSheet leader={hl.data} name={bot ? undefined : shortAddress(account)} open={followOpen} onOpenChange={setFollowOpen} /> : null}
    </div>
  );
}

function AddressChip({ label, address, href, internal }: { label: string; address: string; href?: string; internal?: boolean }) {
  const { copied, copy } = useCopy();
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface-2 pl-2.5 pr-1 text-[12px]">
      <span className="text-text-3">{label}</span>
      {href && internal ? (
        <Link href={href} className="num font-mono text-text-2 underline-offset-4 hover:text-text hover:underline">
          {shortAddress(address)}
        </Link>
      ) : href ? (
        <ExplorerLink href={href} className="num gap-1 font-mono text-text-2 [&>svg]:size-3">
          {shortAddress(address)}
        </ExplorerLink>
      ) : (
        <span className="num font-mono text-text-2">{shortAddress(address)}</span>
      )}
      <button
        type="button"
        aria-label={`Copy ${label.toLowerCase()} id`}
        onClick={() => void copy(address, "Copied")}
        className={cn("flex size-5 items-center justify-center rounded-full text-text-3 transition-colors hover:bg-surface-3 hover:text-text")}
      >
        {copied ? <Check className="size-3 text-up" aria-hidden /> : <Copy className="size-3" aria-hidden />}
      </button>
    </span>
  );
}

function ProfileSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-busy>
      <div className="flex gap-4 rounded-[24px] border border-line bg-surface p-6 sm:p-8">
        <Skeleton className="size-16 rounded-full" />
        <div className="flex flex-1 flex-col gap-3">
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-4 w-full max-w-md" />
          <Skeleton className="h-7 w-40 rounded-full" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className={cn("h-[84px] rounded-2xl", i === 0 ? "col-span-2 sm:col-span-1" : "")} />
        ))}
      </div>
      <Skeleton className="h-64 rounded-[var(--radius-card)]" />
    </div>
  );
}
