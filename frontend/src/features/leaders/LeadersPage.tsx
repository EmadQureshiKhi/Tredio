"use client";
import { Bot, Megaphone, Trophy } from "lucide-react";
import { AnimatePresence, m } from "framer-motion";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Avatar } from "@/components/shell/AppShell";
import { Badge, Button, ButtonLink, Card, cn, Empty, ErrorNote, listItem, Reveal, Segmented, Skeleton } from "@/components/ui";
import { useAccount } from "@/lib/account/AccountProvider";
import { ApiError, type CallerRow, hyperliquid } from "@/lib/api";
import { usdc, compact, shortAddress } from "@/lib/format";
import { BOT_ACCOUNT, isBot, useLeaderboard, usePerformance, useTraders } from "@/features/autopilot/shared/data";
import { FollowSheet } from "@/features/copy/FollowSheet";
import { notify } from "@/lib/toast";
import { PageHeader, StaleNote } from "@/features/autopilot/shared/kit";
import { CallSheet } from "@/features/callers/CallSheet";
import { useCallerIdentity } from "@/features/callers/identity";

export type LeadersTab = "callers" | "traders" | "autopilot";

/** /leaders: callers ranked by how often their calls hit, and Autopilot traders by their record. */
export default function LeadersPage({ initialTab }: { initialTab: LeadersTab }) {
  const router = useRouter();
  const [tab, setTab] = useState<LeadersTab>(initialTab);
  const [callOpen, setCallOpen] = useState(false);
  return (
    <div className="flex flex-col gap-6 [font-feature-settings:'calt'_0]">
      <PageHeader
        title="Leaders"
        description="Callers ranked by how often their calls on attention come true, traders by what they realized across every market, and Autopilot by what its rules made. Every record comes from settled trades."
        action={
          <Button size="lg" icon={<Megaphone className="size-[18px]" aria-hidden />} onClick={() => setCallOpen(true)} data-testid="make-call">
            Make a call
          </Button>
        }
      />
      <Segmented
        label="Leaderboard"
        value={tab}
        onChange={(t) => {
          setTab(t);
          router.replace(t === "callers" ? "/leaders" : `/leaders?tab=${t}`, { scroll: false });
        }}
        options={[
          { value: "callers", label: "Callers" },
          { value: "traders", label: "Traders" },
          { value: "autopilot", label: "Autopilot" },
        ]}
        className="w-full sm:w-[420px]"
      />
      {tab === "callers" ? <Callers onCall={() => setCallOpen(true)} /> : tab === "traders" ? <AllTraders /> : <AutopilotTraders />}
      <CallSheet open={callOpen} onOpenChange={setCallOpen} />
    </div>
  );
}

function Callers({ onCall }: { onCall: () => void }) {
  const board = useLeaderboard();
  if (!board.data && board.error) return <ErrorNote message="The leaderboard could not load." onRetry={() => void board.refetch()} />;
  return (
    <Reveal ready={board.data !== undefined} fallback={<TableSkeleton />}>
      {board.data ? <CallerBoard rows={board.data.callers} stale={board.isRefetchError} onRetry={() => void board.refetch()} onCall={onCall} /> : null}
    </Reveal>
  );
}

function CallerBoard({ rows, stale, onRetry, onCall }: { rows: CallerRow[]; stale: boolean; onRetry: () => void; onCall: () => void }) {
  const me = useCallerIdentity();
  if (!rows.length)
    return (
      <Card>
        <Empty icon={<Trophy className="size-6" />} title="No calls yet" body="Be the first on the board: pick a live trend and call where its attention goes." action={<Button onClick={onCall}>Make a call</Button>} />
      </Card>
    );
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-card">
        <div className="hidden grid-cols-[48px_minmax(0,1fr)_90px_90px_110px_70px] items-center gap-3 border-b border-line px-5 py-3 text-[11.5px] uppercase tracking-[0.08em] text-text-3 md:grid">
          <span>Rank</span>
          <span>Caller</span>
          <span className="text-right">Hit rate</span>
          <span className="text-right">Score</span>
          <span className="text-right">Resolved</span>
          <span className="text-right">Open</span>
        </div>
        {/* A new resolution that changes the ranks glides each caller to their new place. */}
        <ol className="relative" data-testid="caller-board">
          <AnimatePresence initial={false} mode="popLayout">
            {rows.map((c, i) => (
              <m.li key={c.address} {...listItem} className="border-b border-line last:border-b-0" data-testid="caller-line" data-caller={c.address}>
                <CallerLine c={c} rank={i + 1} mine={me.known === c.address} />
              </m.li>
            ))}
          </AnimatePresence>
        </ol>
      </div>
      {stale ? <StaleNote onRetry={onRetry} what="the leaderboard" /> : null}
      <p className="text-[12.5px] leading-5 text-text-3">
        Ranked by Wilson score: the hit rate you can be 95% sure of given how many calls resolved, so 9 hits of 10 ranks above 1 of 1. Up calls hit when attention closes above where it opened; down calls when it closes at or below.
      </p>
    </div>
  );
}

function CallerLine({ c, rank, mine }: { c: CallerRow; rank: number; mine: boolean }) {
  const href = `/c/${c.handle ?? c.address}`;
  const resolved = c.resolved;
  return (
    <Link href={href} className={cn("grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3.5 transition-colors hover:bg-surface-2 md:min-h-[68px] md:grid-cols-[48px_minmax(0,1fr)_90px_90px_110px_70px] md:px-5", mine ? "bg-primary-soft" : "")}>
      <span className={cn("num font-strong text-[14px]", rank <= 3 ? "text-primary" : "text-text-3")}>{rank}</span>
      <span className="flex min-w-0 items-center gap-3">
        <Avatar address={c.address} size={32} />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="truncate font-strong text-[14px] text-text">{c.handle ? `@${c.handle}` : shortAddress(c.address)}</span>
            {mine ? <Badge tone="primary">You</Badge> : null}
          </span>
          <span className="block truncate text-[12px] text-text-3 md:hidden">
            {resolved ? `${Math.round(c.hitRate * 100)}% of ${resolved} · score ${(c.score * 100).toFixed(1)}` : "No calls resolved yet"} · {c.open} open
          </span>
          {c.linked_account ? <span className="hidden text-[12px] text-text-3 md:block">Trades on Autopilot</span> : null}
        </span>
      </span>
      <span className="num text-right font-strong text-[14px] text-text md:hidden">{resolved ? `${Math.round(c.hitRate * 100)}%` : "-"}</span>
      <span className="num hidden text-right font-strong text-[14px] text-text md:block">{resolved ? `${Math.round(c.hitRate * 100)}%` : "-"}</span>
      <span className="num hidden text-right text-[14px] text-text-2 md:block">{resolved ? (c.score * 100).toFixed(1) : "-"}</span>
      <span className="num hidden text-right text-[14px] text-text-2 md:block">
        {resolved ? (
          <>
            <span className="text-up">{c.hits}</span>
            <span className="text-text-3"> / </span>
            <span className="text-down">{c.misses}</span>
          </>
        ) : (
          "0"
        )}
      </span>
      <span className="num hidden text-right text-[14px] text-text-2 md:block">{c.open}</span>
    </Link>
  );
}

function AutopilotTraders() {
  const board = useLeaderboard();
  const accounts = [...(BOT_ACCOUNT ? [{ account: BOT_ACCOUNT, caller: null as CallerRow | null }] : []), ...(board.data?.callers ?? []).filter((c) => c.linked_account && !isBot(c.linked_account)).map((c) => ({ account: c.linked_account!.toLowerCase(), caller: c }))];
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-card">
        <div className="hidden grid-cols-[minmax(0,1fr)_120px_90px_80px_120px_90px] items-center gap-3 border-b border-line px-5 py-3 text-[11.5px] uppercase tracking-[0.08em] text-text-3 md:grid">
          <span>Trader</span>
          <span className="text-right">PnL</span>
          <span className="text-right">Win rate</span>
          <span className="text-right">Trades</span>
          <span className="text-right">Drawdown</span>
          <span className="text-right">Following</span>
        </div>
        <ul data-testid="trader-board">
          {accounts.map((a) => (
            <TraderLine key={a.account} account={a.account} caller={a.caller} />
          ))}
        </ul>
      </div>
      {accounts.length === 0 ? <Empty icon={<Bot className="size-6" />} title="No Autopilot records yet" body="Callers who link their trading account show their Autopilot record here." /> : null}
      <p className="text-[12.5px] leading-5 text-text-3">{BOT_ACCOUNT ? "The Tredio bot and every caller" : "Every caller"} who linked a trading account. PnL is realized on closed Autopilot and copied Hyperliquid positions, after trading fees.</p>
    </div>
  );
}

function TraderLine({ account, caller }: { account: string; caller: CallerRow | null }) {
  const perf = usePerformance(account);
  const s = perf.data?.stats;
  const bot = isBot(account);
  const name = bot ? "Tredio bot" : caller?.handle ? `@${caller.handle}` : shortAddress(account);
  const href = bot ? `/c/${account}` : `/c/${caller?.handle ?? caller?.address ?? account}`;
  const pnl = s?.pnlUsdc ?? 0;
  return (
    <li className="border-b border-line last:border-b-0" data-testid="trader-line" data-account={account}>
      <Link href={href} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3.5 transition-colors hover:bg-surface-2 md:grid-cols-[minmax(0,1fr)_120px_90px_80px_120px_90px] md:px-5">
        <span className="flex min-w-0 items-center gap-3">
          {bot ? (
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary">
              <Bot className="size-4" aria-hidden />
            </span>
          ) : (
            <Avatar address={account} size={32} />
          )}
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="truncate font-strong text-[14px] text-text">{name}</span>
              {bot ? <Badge tone="primary">Official</Badge> : null}
            </span>
            <span className="block truncate text-[12px] text-text-3 md:hidden">{s ? `${s.trades} trades · ${s.trades ? `${Math.round(s.winRate * 100)}% wins` : "no closes yet"} · ${perf.data!.followers} following` : "Loading"}</span>
          </span>
        </span>
        {s ? (
          <span className={cn("num text-right font-strong text-[14px]", Math.abs(pnl) < 0.005 ? "text-text" : pnl > 0 ? "text-up" : "text-down")}>{usdc(pnl, { sign: true })}</span>
        ) : (
          <Skeleton className="ml-auto h-4 w-14" />
        )}
        <span className="num hidden text-right text-[14px] text-text-2 md:block">{s?.trades ? `${Math.round(s.winRate * 100)}%` : "-"}</span>
        <span className="num hidden text-right text-[14px] text-text-2 md:block">{s ? s.trades : "-"}</span>
        <span className="num hidden text-right text-[14px] text-text-2 md:block">{s?.trades ? usdc(-s.maxDrawdownUsdc) : "-"}</span>
        <span className="num hidden text-right text-[14px] text-text-2 md:block">{perf.data ? perf.data.followers : "-"}</span>
      </Link>
    </li>
  );
}

/** Everyone who traded, by realized PnL across outcome markets, attention perps, coins and Hyperliquid perps. */
function AllTraders() {
  const traders = useTraders();
  const board = useLeaderboard();
  const account = useAccount();
  const [follow, setFollow] = useState<{ leader: string; name: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const handles = new Map((board.data?.callers ?? []).filter((c) => c.linked_account && c.handle).map((c) => [c.linked_account!.toLowerCase(), `@${c.handle}`]));
  const nameOf = (a: string) => (isBot(a) ? "Tredio bot" : (handles.get(a) ?? shortAddress(a)));
  // Copies follow the trader's Hyperliquid address: their account's own Chain Signatures key.
  const copy = async (a: string, name: string) => {
    if (!account.authenticated) return account.login();
    setResolving(a);
    try {
      const { address } = await hyperliquid.account(a);
      setFollow({ leader: address.toLowerCase(), name });
      setOpen(true);
    } catch (e) {
      notify.error(`Could not find ${name}'s Hyperliquid address`, e instanceof ApiError ? e.message : "Try again.");
    } finally {
      setResolving(null);
    }
  };
  const unavailable = !traders.data && traders.error instanceof ApiError && traders.error.status === 503;
  if (!traders.data && !traders.error) return <TableSkeleton />;
  if (unavailable)
    return (
      <Card>
        <Empty icon={<Trophy className="size-6" />} title="Rankings are catching up" body="Trader records come from the indexer, which is syncing right now. Check back in a few minutes." action={<Button tone="secondary" onClick={() => void traders.refetch()}>Check again</Button>} />
      </Card>
    );
  if (!traders.data) return <ErrorNote message="The trader rankings could not load." onRetry={() => void traders.refetch()} />;
  const rows = traders.data.traders;
  if (!rows.length)
    return (
      <Card>
        <Empty icon={<Trophy className="size-6" />} title="No closed trades yet" body="Traders rank here once a position closes, whatever the market." action={<ButtonLink href="/">Browse markets</ButtonLink>} />
      </Card>
    );
  const me = account.address?.toLowerCase();
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-card">
        <div className="hidden grid-cols-[48px_minmax(0,1fr)_120px_120px_90px_80px_96px] items-center gap-3 border-b border-line px-5 py-3 text-[11.5px] uppercase tracking-[0.08em] text-text-3 md:grid">
          <span>Rank</span>
          <span>Trader</span>
          <span className="text-right">Realized PnL</span>
          <span className="text-right">Volume</span>
          <span className="text-right">Win rate</span>
          <span className="text-right">Closed</span>
          <span />
        </div>
        <ol className="relative" data-testid="all-traders">
          <AnimatePresence initial={false} mode="popLayout">
            {rows.map((t, i) => {
              const a = t.account.toLowerCase();
              const self = a === me;
              const name = nameOf(a);
              const pnl = t.realizedPnlUsdc;
              return (
                <m.li key={a} {...listItem} className={cn("grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-4 py-3 last:border-b-0 md:grid-cols-[48px_minmax(0,1fr)_120px_120px_90px_80px_96px] md:px-5", self ? "bg-primary-soft" : "")} data-testid="trader-row" data-account={a}>
                  <span className={cn("num font-strong text-[14px]", i < 3 ? "text-primary" : "text-text-3")}>{i + 1}</span>
                  <Link href={`/c/${a}`} className="flex min-w-0 items-center gap-3 rounded-lg hover:underline hover:underline-offset-4">
                    {isBot(a) ? (
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary">
                        <Bot className="size-4" aria-hidden />
                      </span>
                    ) : (
                      <Avatar address={a} size={32} />
                    )}
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate font-strong text-[14px] text-text">{name}</span>
                        {self ? <Badge tone="primary">You</Badge> : null}
                      </span>
                      <span className="num block truncate text-[12px] text-text-3 md:hidden">
                        {compact(t.volumeUsdc)} USDC volume · {t.closedTrades} closed{t.closedTrades ? ` · ${Math.round(t.winRate * 100)}% wins` : ""}
                      </span>
                    </span>
                  </Link>
                  <span className={cn("num text-right font-strong text-[14px]", Math.abs(pnl) < 0.005 ? "text-text" : pnl > 0 ? "text-up" : "text-down")}>{usdc(pnl, { sign: true })}</span>
                  <span className="num hidden text-right text-[14px] text-text-2 md:block">{compact(t.volumeUsdc)}</span>
                  <span className="num hidden text-right text-[14px] text-text-2 md:block">{t.closedTrades ? `${Math.round(t.winRate * 100)}%` : "-"}</span>
                  <span className="num hidden text-right text-[14px] text-text-2 md:block">{t.closedTrades}</span>
                  <span className="hidden justify-end md:flex">
                    {self || account.kind === "wallet" ? null : (
                      <Button size="sm" tone="ghost" className="-my-1" loading={resolving === a} disabled={resolving !== null} onClick={() => void copy(a, name)} data-testid="trader-copy">
                        Copy
                      </Button>
                    )}
                  </span>
                </m.li>
              );
            })}
          </AnimatePresence>
        </ol>
      </div>
      {traders.isRefetchError ? <StaleNote onRetry={() => void traders.refetch()} what="the rankings" /> : null}
      <p className="text-[12.5px] leading-5 text-text-3">Realized PnL on closed positions across outcome markets, attention perps, trend coins and Hyperliquid perps, after fees. Copying mirrors a trader&rsquo;s Hyperliquid positions only, inside your caps.</p>
      <FollowSheet leader={follow?.leader ?? null} name={follow?.name} open={open} onOpenChange={setOpen} />
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="flex flex-col divide-y divide-line overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface" aria-busy>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-3 px-5 py-3.5">
          <Skeleton className="h-4 w-6" />
          <Skeleton className="size-8 rounded-full" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="ml-auto h-4 w-12" />
        </div>
      ))}
    </div>
  );
}
