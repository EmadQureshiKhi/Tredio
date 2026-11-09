"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, CirclePause, Fingerprint, Radio, SlidersHorizontal, Users } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Avatar } from "@/components/shell/AppShell";
import { Badge, Button, Card, cn, Empty, ErrorNote, Skeleton } from "@/components/ui";
import { IS_MAINNET } from "@/lib/config";
import { describeError, useAccount } from "@/lib/account/AccountProvider";
import { autopilot, type Follow } from "@/lib/api";
import { compact, usdc } from "@/lib/format";
import { notify } from "@/lib/toast";
import { GrantCard } from "@/features/autopilot/grant/GrantCard";
import { GrantSheet } from "@/features/autopilot/grant/GrantSheet";
import { BOT_ACCOUNT, grantUsable, useFollows, useGrant, usePerformance } from "@/features/autopilot/shared/data";
import { PageHeader, SectionTitle, StaleNote, useConfirm } from "@/features/autopilot/shared/kit";
import { LeaderCard, LeaderCardSkeleton } from "@/features/autopilot/shared/LeaderCard";
import { type SignalChannel } from "@/lib/api";
import { SignalChannels } from "@/features/signals/SignalsSection";
import { signalIdentity } from "@/features/signals/data";
import { FollowSheet } from "./FollowSheet";
import { useLeaderDirectory } from "./leaders";

// #mainnet: this file branches on the network (testnet or mainnet); MAINNET.md lists what changes.

/** /copy: the leaders you follow with their caps and switches, and leaders worth following. */
export default function CopyPage() {
  const account = useAccount();
  const follows = useFollows();
  const dir = useLeaderDirectory();
  const [sheet, setSheet] = useState<{ leader: string; name?: string } | null>(null);
  const [open, setOpen] = useState(false);
  const show = (leader: string, name?: string) => {
    setSheet({ leader, name });
    setOpen(true);
  };
  const following = new Set((follows.data?.follows ?? []).map((f) => f.leader.toLowerCase()));
  const featured = dir.featured();
  const passkey = account.kind !== "wallet";

  return (
    <div className="flex flex-col gap-8 [font-feature-settings:'calt'_0]">
      <PageHeader
        title="Copy trading"
        description="Follow a trader's Hyperliquid positions from your own account: every open, add, trim and close, scaled to your size and held inside caps you choose."
      />
      <div className={cn("grid items-start gap-6", account.authenticated ? "lg:grid-cols-[minmax(0,1fr)_360px]" : "")}>
        <div className="flex min-w-0 flex-col gap-8">
          {account.authenticated ? <GrantCard compact className="lg:hidden" /> : null}
          {!account.ready ? (
            <Skeleton className="h-36 rounded-[var(--radius-card)]" />
          ) : account.authenticated ? (
            <section aria-labelledby="following-title" className="flex flex-col gap-4">
              <SectionTitle id="following-title" title="You follow" subtitle={follows.data?.follows.length ? `${follows.data.follows.filter((f) => f.status === "active").length} copying now` : undefined} />
              {follows.error ? follows.data ? <StaleNote onRetry={() => void follows.refetch()} what="your follows" /> : <ErrorNote message="Your follows could not load." onRetry={() => void follows.refetch()} /> : null}
              {follows.isLoading || (!follows.data && !follows.error) ? (
                <Skeleton className="h-36 rounded-[var(--radius-card)]" />
              ) : follows.data?.follows.length ? (
                <ul className="flex flex-col gap-3" data-testid="follow-list">
                  {follows.data.follows.map((f) => (
                    <li key={f.id}>
                      <FollowRow
                        follow={f}
                        name={dir.name(f.leader)}
                        href={dir.href(f.leader)}
                        bot={dir.isBot(f.leader)}
                        signals={dir.isSignals(f.leader) ? (dir.channel(f.leader) ?? "unknown") : null}
                        monthPnl={dir.leader(f.leader)?.pnl ?? null}
                        onEdit={() => show(f.leader, dir.name(f.leader))}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <Card>
                  <Empty icon={<Users className="size-6" />} title="Not following anyone yet" body={dir.botAddress ? "Start with the Tredio bot below: its rules and its record are public." : "Pick a trader below. Their record on Hyperliquid is public."} />
                </Card>
              )}
            </section>
          ) : (
            <Card className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-strong text-[15px] text-text">Sign in to copy a trader</p>
                <p className="mt-1 max-w-lg text-[13.5px] leading-5 text-text-2">Copies run through Autopilot&rsquo;s Hyperliquid-only access, which your account contract guards. You can pause or stop any copy at any time.</p>
              </div>
              <Button size="lg" icon={<Fingerprint className="size-[18px]" aria-hidden />} onClick={account.login} className="shrink-0">
                Sign in
              </Button>
            </Card>
          )}
          <section aria-labelledby="featured-title" className="flex flex-col gap-4">
            <SectionTitle id="featured-title" title="Leaders to follow" subtitle={`${dir.botAddress ? "The Tredio bot, and the" : "The"} best traders this month on Hyperliquid mainnet's public leaderboard${IS_MAINNET ? "" : " (testnet has none: a copy here mirrors their mainnet positions into your testnet account)"}`} />
            <div className={cn("grid gap-4 sm:grid-cols-2", account.authenticated ? "" : "xl:grid-cols-3")}>
              {featured.map(({ address, leader }) => (
                <LeaderCard
                  key={address}
                  address={address}
                  leader={leader}
                  bot={dir.isBot(address)}
                  name={dir.name(address)}
                  href={dir.href(address)}
                  following={following.has(address)}
                  onFollow={passkey ? () => (account.authenticated ? show(address, dir.name(address)) : account.login()) : undefined}
                />
              ))}
              {dir.loading ? <LeaderCardSkeleton /> : null}
              {!dir.loading && featured.length === 0 ? <ErrorNote className="sm:col-span-2" message="Hyperliquid's leaderboard is unavailable right now." /> : null}
            </div>
          </section>
          <SignalChannels />
        </div>
        {account.authenticated ? (
          <aside className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-24 lg:-m-1 lg:max-h-[calc(100dvh-7.5rem)] lg:overflow-y-auto lg:overscroll-contain lg:p-1">
            <GrantCard className="hidden lg:block" />
            <Card className="p-5">
              <h2 className="font-strong text-[15px] text-text">How copying works</h2>
              <ol className="mt-3 flex flex-col gap-3 text-[13px] leading-5 text-text-2">
                <li className="flex gap-3">
                  <Step n={1} />
                  Autopilot keeps checking the leader&rsquo;s Hyperliquid positions. Positions opened before you followed are not copied.
                </li>
                <li className="flex gap-3">
                  <Step n={2} />
                  Each change becomes an order from your account&rsquo;s Hyperliquid address, sized by your settings, cut to your caps, within 2% of the oracle&rsquo;s mark.
                </li>
                <li className="flex gap-3">
                  <Step n={3} />
                  Every copy and every skip lands in your Autopilot activity, with the reason.
                </li>
              </ol>
            </Card>
          </aside>
        ) : null}
      </div>
      <FollowSheet leader={sheet?.leader ?? null} name={sheet?.name} open={open} onOpenChange={setOpen} />
    </div>
  );
}

function Step({ n }: { n: number }) {
  return <span className="num flex size-5 shrink-0 items-center justify-center rounded-full bg-primary-soft font-strong text-[11px] text-primary">{n}</span>;
}

function FollowRow({
  follow: f,
  name,
  href,
  bot,
  signals,
  monthPnl,
  onEdit,
}: {
  follow: Follow;
  name: string;
  href: string;
  bot: boolean;
  /** A paid signals channel ("unknown" while its channel has not loaded). */
  signals: SignalChannel | "unknown" | null;
  monthPnl: number | null;
  onEdit: () => void;
}) {
  const account = useAccount();
  const perf = usePerformance(bot ? BOT_ACCOUNT : null);
  const grant = useGrant();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [grantOpen, setGrantOpen] = useState(false);
  const set = useMutation({
    // Resuming asks the passkey; pausing and unfollowing never prompt.
    mutationFn: (status: "active" | "paused" | "stopped") => (status === "active" ? autopilot.resumeFollow(f.id, account.approve) : autopilot.setFollowStatus(f.id, status)),
    onSuccess: (_r, status) => notify.success(status === "active" ? `Copying ${name} again` : status === "paused" ? `Paused copying ${name}` : `Stopped following ${name}`),
    onError: (e, status) => notify.error(status === "active" ? `Could not resume copying ${name}` : status === "paused" ? `Could not pause copying ${name}` : `Could not unfollow ${name}`, describeError(e)),
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: ["follows"] }), qc.invalidateQueries({ queryKey: ["ap-performance", f.leader] })]),
  });
  const s = f.settings;
  const active = f.status === "active";
  const pnl = bot ? perf.data?.stats.pnlUsdc : monthPnl;
  const chips = [
    s.mode === "ratio" ? `${s.ratio}x their size` : `${usdc(s.fixedMarginUsdc)} USDC per trade`,
    `max ${usdc(s.maxMarginUsdc)} USDC margin`,
    `up to ${s.maxLeverage}x`,
    `max ${s.maxSlippagePct}% slippage`,
    `daily loss cap ${usdc(s.maxDailyLossUsdc)} USDC`,
    `loss cap ${usdc(s.maxOpenLossUsdc)} USDC`,
  ];
  return (
    <article className="rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-card sm:p-5" data-testid="follow-row" data-leader={f.leader} data-status={f.status}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          {bot ? (
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary">
              <Bot className="size-5" aria-hidden />
            </span>
          ) : (
            <Avatar address={signals ? signalIdentity(f.leader) : f.leader} size={40} />
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {signals ? (
                <Link href={href} className="truncate font-strong text-[15px] leading-6 text-text hover:underline hover:underline-offset-4">
                  {name}
                </Link>
              ) : (
                <a href={href} target="_blank" rel="noreferrer" className="truncate font-strong text-[15px] leading-6 text-text hover:underline hover:underline-offset-4">
                  {name}
                </a>
              )}
              <Badge tone={active ? "up" : "warn"} icon={active ? <span className="live-dot size-1.5 rounded-full bg-up" aria-hidden /> : undefined}>
                {active ? "Copying" : "Paused"}
              </Badge>
            </div>
            <p className="mt-0.5 text-[12.5px] text-text-3">Following since {new Date(f.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</p>
          </div>
        </div>
        {signals ? (
          <div className="shrink-0 text-right">
            <p className="text-[11.5px] uppercase tracking-[0.08em] text-text-3">Signals</p>
            <p className="num mt-0.5 flex items-center justify-end gap-1.5 font-strong text-[16px] text-text">
              <Radio className="size-4 text-primary" aria-hidden />
              {signals === "unknown" ? "-" : (signals.signals ?? 0)}
            </p>
          </div>
        ) : (
          <div className="shrink-0 text-right">
            <p className="text-[11.5px] uppercase tracking-[0.08em] text-text-3">{bot ? "Their PnL" : "Their month"}</p>
            <p className={cn("num mt-0.5 font-strong text-[16px]", !pnl ? "text-text" : pnl > 0 ? "text-up" : "text-down")}>{pnl === null || pnl === undefined ? "-" : bot ? usdc(pnl, { sign: true }) : `${pnl >= 0 ? "+" : "-"}$${compact(Math.abs(pnl))}`}</p>
          </div>
        )}
      </div>
      <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Your caps">
        {chips.map((c) => (
          <li key={c} className="num rounded-full border border-line bg-surface-2 px-2.5 py-1 text-[12px] text-text-2">
            {c}
          </li>
        ))}
      </ul>
      {f.statusReason ? <p className="mt-2 text-[12.5px] text-warn">{f.statusReason}</p> : null}
      {!active ? (
        <p className="mt-2 text-[12.5px] leading-[18px] text-text-3">
          {f.statusReason ? "Nothing copies while paused, closes included. Resume or set new caps to copy again." : "Paused: nothing copies, closes included. Positions already copied stay open until you close them or resume."}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-3">
        {active ? (
          <Button size="sm" tone="secondary" icon={<CirclePause className="size-4" aria-hidden />} loading={set.isPending && set.variables === "paused"} disabled={set.isPending} onClick={() => set.mutate("paused")} data-testid="follow-pause">
            Pause
          </Button>
        ) : (
          <Button
            size="sm"
            tone="secondary"
            icon={<Fingerprint className="size-4" aria-hidden />}
            loading={set.isPending && set.variables === "active"}
            disabled={set.isPending}
            onClick={() => (grantUsable(grant.data) ? set.mutate("active") : setGrantOpen(true))}
            data-testid="follow-resume"
          >
            Resume
          </Button>
        )}
        <Button size="sm" tone="ghost" icon={<SlidersHorizontal className="size-4" aria-hidden />} onClick={onEdit}>
          Edit caps
        </Button>
        <Button
          size="sm"
          tone={confirm.armed === "stop" ? "danger" : "ghost"}
          className="ml-auto"
          loading={set.isPending && set.variables === "stopped"}
          disabled={set.isPending}
          onBlur={confirm.disarm}
          onClick={() => confirm.confirm("stop") && set.mutate("stopped")}
          data-testid="follow-stop"
        >
          {confirm.armed === "stop" ? "Confirm unfollow" : "Unfollow"}
        </Button>
      </div>
      {confirm.armed === "stop" ? <p className="mt-2 text-[12px] leading-4 text-text-3">Unfollowing copies nothing new. Positions you already copied stay open until you close them.</p> : null}
      <GrantSheet
        open={grantOpen}
        onOpenChange={setGrantOpen}
        reason="Copies trade through Autopilot's Hyperliquid-only access. Approve it with your passkey, then approve resuming."
        onGranted={() => {
          setGrantOpen(false);
          set.mutate("active");
        }}
      />
    </article>
  );
}
