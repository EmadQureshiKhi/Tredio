"use client";
import { Eye, KeyRound, Lock, Plus, Radio, Settings2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Avatar } from "@/components/shell/AppShell";
import { Badge, Button, ButtonLink, Card, cn, Empty, ErrorNote, ExplorerLink, Skeleton } from "@/components/ui";
import { useAccount } from "@/lib/account/AccountProvider";
import type { SignalBody, SignalChannel, SignalItem } from "@/lib/api";
import { explorerTx, USDC_DECIMALS } from "@/lib/config";
import { ago, countdown, tokenAmount, usdc } from "@/lib/format";

/** When a sealed signal opens, to the minute: the feed refreshes every 30 seconds, so no ticking seconds. */
const revealIn = (sec: number) => (sec < 60 ? "within a minute" : sec < 3600 ? `in ${Math.ceil(sec / 60)} min` : `in ${countdown(Math.floor(Date.now() / 1000) + sec)}`);
import { SectionTitle } from "@/features/autopilot/shared/kit";
import { FollowSheet } from "@/features/copy/FollowSheet";
import { channelName, days, SIGNALS_PREFIX, useOpenedSignals, useSignalAccess, useSignalChannels, useSignalFeed } from "./data";
import { AccessSheet, ChannelSheet, PRIVACY_NOTE, PublishSheet } from "./sheets";

/**
 * A caller's paid signals on its profile: the channel's terms, early access (or the leader's own
 * tools), and the feed, sealed until each signal's reveal unless this account holds the week's key.
 */
export function SignalsSection({ identity, linkedAccount, mine }: { identity: string; linkedAccount: string | null; mine: boolean }) {
  const account = useAccount();
  const channels = useSignalChannels();
  const feed = useSignalFeed(identity);
  const channel = channels.data?.channels.find((c) => c.leader === identity) ?? null;
  const access = useSignalAccess(channel && !mine ? identity : null);
  const leaderAccount = mine && account.address !== null && account.address === linkedAccount;
  const canRead = leaderAccount || Boolean(access.data?.active);
  const opened = useOpenedSignals(identity, feed.data?.signals, canRead);
  const [sheet, setSheet] = useState<"channel" | "publish" | "access" | "copy" | null>(null);
  const close = (o: boolean) => !o && setSheet(null);

  if (channels.off || feed.off) return null;
  if (channels.isLoading) return <Skeleton className="h-40 rounded-[var(--radius-card)]" />;
  if (!channel) {
    if (!mine) return null;
    return (
      <Card className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between" data-testid="signals-open-channel">
        <div className="flex gap-3">
          <Radio className="mt-0.5 size-[18px] shrink-0 text-primary" aria-hidden />
          <p className="text-[13.5px] leading-5 text-text-2">
            Sell your trade signals: followers pay you in USDC to read them early and copy them with Autopilot, and everyone sees them after your delay.
            {linkedAccount ? "" : " Link your trading account first: you are paid to it and commit each signal from it."}
          </p>
        </div>
        {linkedAccount ? (
          <Button tone="secondary" size="sm" className="shrink-0" onClick={() => setSheet("channel")} data-testid="signals-open">
            Open a channel
          </Button>
        ) : (
          <ButtonLink tone="secondary" size="sm" href="/settings#identity" className="shrink-0">
            Link in settings
          </ButtonLink>
        )}
        <ChannelSheet open={sheet === "channel"} onOpenChange={close} current={null} />
      </Card>
    );
  }

  const items = feed.data?.signals ?? [];
  const now = feed.data?.now ?? 0;
  const until = access.data?.active && access.data.expiresAt ? new Date(access.data.expiresAt * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null;
  return (
    <section aria-labelledby="signals-title" className="flex flex-col gap-3" data-testid="signals-section">
      <SectionTitle
        id="signals-title"
        title="Signals"
        subtitle={`${tokenAmount(BigInt(channel.price_usdc), USDC_DECIMALS)} USDC for ${channel.period_days} days of early access · public after ${days(channel.reveal_delay_sec)}`}
        action={
          mine ? (
            <div className="flex gap-2">
              <Button size="sm" tone="ghost" icon={<Settings2 className="size-4" aria-hidden />} onClick={() => setSheet("channel")} data-testid="signals-settings">
                Channel
              </Button>
              <Button size="sm" icon={<Plus className="size-4" aria-hidden />} disabled={!leaderAccount} onClick={() => setSheet("publish")} data-testid="signals-publish">
                Publish
              </Button>
            </div>
          ) : until ? (
            <Badge tone="up" icon={<KeyRound className="size-3" aria-hidden />}>
              Early access until {until}
            </Badge>
          ) : (
            <Button size="sm" icon={<KeyRound className="size-4" aria-hidden />} onClick={() => (account.authenticated ? setSheet("access") : account.login())} data-testid="signals-buy">
              Get early access
            </Button>
          )
        }
      />
      <Card className="flex flex-col p-0" data-testid="signal-feed">
        <p className="flex items-start gap-2 border-b border-line px-5 py-3 text-[12.5px] leading-[18px] text-text-3">
          <Eye className="mt-px size-3.5 shrink-0" aria-hidden />
          {PRIVACY_NOTE}
          {mine && !leaderAccount && linkedAccount ? ` Sign in as ${linkedAccount} to publish: each signal is committed from it.` : ""}
        </p>
        {feed.isLoading ? (
          <Skeleton className="m-5 h-24 rounded-2xl" />
        ) : feed.error ? (
          <ErrorNote className="m-5" message="The signals could not load." onRetry={() => void feed.refetch()} />
        ) : items.length ? (
          <ul className="flex flex-col divide-y divide-line">
            {items.map((s) => (
              <li key={s.id}>
                <SignalRow item={s} body={s.signal ?? opened.data?.get(s.id) ?? null} now={now} />
              </li>
            ))}
          </ul>
        ) : (
          <Empty icon={<Radio className="size-6" />} title="No signals yet" body={mine ? "Publish your first: paying followers read it at once." : "Signals show here as they are published, sealed until their reveal."} />
        )}
        {access.data && !access.data.active && access.data.expiresAt ? <p className="border-t border-line px-5 py-3 text-[12.5px] text-warn">Your early access ended. Renew it to read new signals early and keep copying them.</p> : null}
      </Card>
      {mine ? (
        <>
          <ChannelSheet key={`${channel.price_usdc}-${channel.period_days}-${channel.reveal_delay_sec}`} open={sheet === "channel"} onOpenChange={close} current={channel} />
          <PublishSheet open={sheet === "publish"} onOpenChange={close} channel={channel} />
        </>
      ) : (
        <>
          <AccessSheet open={sheet === "access"} onOpenChange={close} channel={channel} onCopy={() => setSheet("copy")} />
          <FollowSheet leader={SIGNALS_PREFIX + identity} name={`${channelName(channel)} signals`} open={sheet === "copy"} onOpenChange={close} />
        </>
      )}
    </section>
  );
}

const SIDE_TONE = { long: "text-up", short: "text-down" } as const;

/** One signal: what it says once this account can read it, else sealed with its reveal countdown; always with its on-chain commitment. */
export function SignalRow({ item, body, now, showLeader }: { item: SignalItem; body: SignalBody | null; now: number; showLeader?: boolean }) {
  const revealed = Boolean(item.signal);
  return (
    <div className="flex flex-col gap-1.5 px-5 py-3.5 [font-feature-settings:'calt'_0]" data-testid="signal-row" data-state={body ? (revealed ? "revealed" : "early") : "sealed"}>
      <div className="flex flex-wrap items-center gap-2">
        {showLeader ? (
          <Link href={`/c/${item.handle ?? item.leader}`} className="font-strong text-[13.5px] text-text hover:underline hover:underline-offset-4">
            {channelName({ handle: item.handle, leader: item.leader })}
          </Link>
        ) : null}
        {body ? (
          <p className="text-[14px] text-text">
            <span className="font-strong">{body.kind === "open" ? "Open" : "Close"}</span> <span className={cn("font-strong", SIDE_TONE[body.side])}>{body.side}</span> <span className="font-strong">{body.market}</span>
            {body.kind === "open" && body.marginUsdc !== null && body.leverage !== null ? (
              <span className="num text-text-2">
                {" "}
                · {usdc(body.marginUsdc)} USDC at {body.leverage}x
              </span>
            ) : null}
            <span className="num text-text-2"> · mark {body.price.toLocaleString(undefined, { maximumFractionDigits: body.price < 10 ? 4 : 2 })}</span>
          </p>
        ) : (
          <p className="flex items-center gap-1.5 text-[14px] text-text-2">
            <Lock className="size-3.5 text-text-3" aria-hidden />
            Sealed signal
          </p>
        )}
        {body && !revealed ? <Badge tone="primary">Early</Badge> : null}
      </div>
      {body?.note ? <p className="break-words text-[13px] leading-5 text-text-2">{body.note}</p> : null}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-text-3">
        <span>{ago(item.issuedAt)}</span>
        <span aria-hidden>·</span>
        <span>{revealed ? "Public" : `Public ${revealIn(item.revealAt - now)}`}</span>
        <span aria-hidden>·</span>
        <ExplorerLink href={explorerTx(item.commitTx)} className="gap-1 [&>svg]:size-3">
          Committed on chain
        </ExplorerLink>
      </p>
    </div>
  );
}

/** The channels on the Copy page: who sells signals, at what price, and how recently they published. */
export function SignalChannels() {
  const channels = useSignalChannels();
  const feed = useSignalFeed();
  if (channels.off) return null;
  const list = channels.data?.channels ?? [];
  const latest = (feed.data?.signals ?? []).slice(0, 5);
  return (
    <section aria-labelledby="signals-channels-title" className="flex flex-col gap-4" data-testid="signal-channels">
      <SectionTitle id="signals-channels-title" title="Paid signals" subtitle={`Leaders who publish their trades as signals: buy early access in USDC to read them first and copy them. ${PRIVACY_NOTE}`} />
      {channels.isLoading ? (
        <Skeleton className="h-28 rounded-[var(--radius-card)]" />
      ) : channels.error ? (
        <ErrorNote message="Signal channels could not load." onRetry={() => void channels.refetch()} />
      ) : list.length ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {list.map((c) => (
              <ChannelCard key={c.leader} channel={c} />
            ))}
          </div>
          {latest.length ? (
            <Card className="flex flex-col p-0">
              <p className="border-b border-line px-5 py-3 font-strong text-[13px] text-text-2">Latest signals</p>
              <ul className="flex flex-col divide-y divide-line">
                {latest.map((s) => (
                  <li key={s.id}>
                    <SignalRow item={s} body={s.signal} now={feed.data!.now} showLeader />
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </>
      ) : (
        <Card>
          <Empty icon={<Radio className="size-6" />} title="No signal channels yet" body="Link your caller identity to your account in Settings, then open a channel from your profile to sell your signals." />
        </Card>
      )}
    </section>
  );
}

function ChannelCard({ channel: c }: { channel: SignalChannel }) {
  return (
    <Link href={`/c/${c.handle ?? c.leader}`} className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-card transition-colors hover:border-line-strong" data-testid="signal-channel">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar address={c.leader} size={32} />
          <span className="truncate font-strong text-[15px] text-text">{channelName(c)}</span>
        </span>
        <Badge tone="neutral" className="num">
          {tokenAmount(BigInt(c.price_usdc), USDC_DECIMALS)} USDC / {c.period_days}d
        </Badge>
      </div>
      <p className="num text-[12.5px] text-text-2">
        {c.signals ?? 0} signal{c.signals === 1 ? "" : "s"} · public after {days(c.reveal_delay_sec)}
        {c.last ? ` · last ${ago(c.last)}` : ""}
      </p>
    </Link>
  );
}
