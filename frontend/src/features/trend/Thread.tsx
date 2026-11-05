"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, m } from "framer-motion";
import { Fingerprint, KeyRound, MessageSquare, Share2, Target } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Avatar } from "@/components/shell/AppShell";
import { Badge, Button, Card, CardHeader, cn, Empty, ErrorNote, listItem, Segmented } from "@/components/ui";
import { describeError, useAccount } from "@/lib/account/AccountProvider";
import { type Call, type Post, social, type Trend, trends } from "@/lib/api";
import { ago, countdown, points, shortAddress } from "@/lib/format";
import { callMessage, type Horizon, postMessage, signAsCaller } from "@/lib/social";
import { callShareUrl, shareToX } from "@/features/share/share";
import { trendName } from "@/lib/trends";
import { useNow } from "./ticket";

/**
 * A trend's public thread: calls (an up or down prediction on the index over 24 hours or 7 days,
 * scored when it resolves) and talk. Both are signed by the caller identity, a key from the
 * passkey's private-data namespace that is unlinkable to the trading account.
 */

type Tab = "calls" | "talk";
const NOTE_MAX = 280;
const POST_MAX = 500;

export default function Thread({ trend }: { trend: Trend }) {
  const thread = useQuery({ queryKey: ["thread", trend.identifier], queryFn: () => trends.thread(trend.identifier), refetchInterval: 10_000 });
  const [tab, setTab] = useState<Tab>("calls");
  const calls = thread.data?.calls ?? [];
  const posts = thread.data?.posts ?? [];
  return (
    <Card>
      <CardHeader
        title="Calls and talk"
        subtitle="Public predictions, scored when they resolve"
        action={
          <Segmented
            label="Thread view"
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { value: "calls", label: `Calls${calls.length ? ` ${calls.length}` : ""}` },
              { value: "talk", label: `Talk${posts.length ? ` ${posts.length}` : ""}` },
            ]}
          />
        }
      />
      <div className="px-5 pb-5 pt-4">
        <Composer trend={trend} tab={tab} />
        {thread.error ? <ErrorNote className="mt-4" message="The thread could not load." onRetry={() => void thread.refetch()} /> : null}
        {thread.isLoading ? (
          <div className="mt-4 flex flex-col gap-3">
            <div className="skeleton h-16" />
            <div className="skeleton h-16" />
          </div>
        ) : tab === "calls" ? (
          calls.length === 0 ? (
            <Empty className="py-10" icon={<Target className="size-6" />} title="No calls yet" body="Be first: call where attention goes in the next day or week. Hits build your public record." />
          ) : (
            <ul className="relative mt-2 divide-y divide-line" data-testid="calls">
              <AnimatePresence initial={false} mode="popLayout">
                {calls.map((c) => (
                  <m.li key={c.id} {...listItem}>
                    <CallRow call={c} identifier={trend.identifier} name={trendName(trend)} />
                  </m.li>
                ))}
              </AnimatePresence>
            </ul>
          )
        ) : posts.length === 0 ? (
          <Empty className="py-10" icon={<MessageSquare className="size-6" />} title="Nothing said yet" body="Share what is driving the attention: a link, a take, a question." />
        ) : (
          <ul className="relative mt-2 divide-y divide-line" data-testid="posts">
            <AnimatePresence initial={false} mode="popLayout">
              {posts.map((p) => (
                <m.li key={p.id} {...listItem}>
                  <PostRow post={p} />
                </m.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </Card>
  );
}

function Who({ address, handle }: { address: string; handle: string | null | undefined }) {
  return (
    <Link href={`/c/${handle ?? address}`} className="flex min-w-0 items-center gap-2 rounded-lg transition-opacity hover:opacity-80">
      <Avatar address={address} size={22} />
      <span className={cn("truncate text-[13px]", handle ? "font-strong text-text" : "num font-mono text-text-2")}>{handle ? `@${handle}` : shortAddress(address)}</span>
    </Link>
  );
}

function CallRow({ call: c, identifier, name }: { call: Call; identifier: string; name: string }) {
  const now = useNow(30_000);
  const resolvesAt = Number(c.resolves_at);
  const horizon = Number(c.horizon_sec) >= 604_800 ? "7 days" : "24 hours";
  const share = () =>
    shareToX({
      text: `I called ${name} attention ${c.direction === "up" ? "UP" : "DOWN"} from ${points(Number(c.opening_index))} over ${horizon} on Tredio.`,
      url: callShareUrl(identifier, c.id),
    });
  return (
    <div className="flex flex-col gap-2 py-3.5" data-testid="call-row">
      <div className="flex items-center justify-between gap-3">
        <Who address={c.caller} handle={c.handle} />
        <span className="shrink-0 text-[12px] text-text-3">{ago(Number(c.called_at), now)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={c.direction === "up" ? "up" : "down"}>{c.direction === "up" ? "Up" : "Down"}</Badge>
        <span className="num text-[13px] text-text-2">
          from {points(Number(c.opening_index))} over {horizon}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {c.outcome === "hit" ? <Badge tone="up">Hit at {points(Number(c.closing_index))}</Badge> : c.outcome === "miss" ? <Badge tone="down">Missed at {points(Number(c.closing_index))}</Badge> : c.outcome === "void" ? <Badge>Void</Badge> : <span className="num text-[12px] text-text-3">resolves in {countdown(resolvesAt, now)}</span>}
          <button type="button" onClick={share} className="rounded-lg p-1 text-text-3 transition-colors hover:bg-surface-2 hover:text-text" aria-label="Share this call on X">
            <Share2 className="size-3.5" aria-hidden />
          </button>
        </span>
      </div>
      {c.note ? <p className="whitespace-pre-wrap break-words text-[13.5px] leading-5 text-text">{c.note}</p> : null}
    </div>
  );
}

function PostRow({ post: p }: { post: Post }) {
  return (
    <div className="flex flex-col gap-1.5 py-3.5" data-testid="post-row">
      <div className="flex items-center justify-between gap-3">
        <Who address={p.caller} handle={p.handle} />
        <span className="shrink-0 text-[12px] text-text-3">{ago(Math.floor(new Date(p.created_at).getTime() / 1000))}</span>
      </div>
      <p className="whitespace-pre-wrap break-words text-[14px] leading-[22px] text-text">{p.body}</p>
    </div>
  );
}

function Composer({ trend, tab }: { trend: Trend; tab: Tab }) {
  const account = useAccount();
  const client = useQueryClient();
  const [direction, setDirection] = useState<"up" | "down">("up");
  const [horizon, setHorizon] = useState<Horizon>(86_400);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const identity = account.privateIdentity?.identity ?? null;
  const live = trend.status === "active" || trend.status === "cooling";

  if (!account.authenticated) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-2xl bg-surface-2 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[13px] leading-5 text-text-2">Sign in to make calls and join the thread.</p>
        <Button size="sm" icon={<Fingerprint className="size-4" aria-hidden />} onClick={account.login}>
          Sign in
        </Button>
      </div>
    );
  }
  if (!identity) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-2xl bg-surface-2 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[13px] leading-5 text-text-2">Calls and posts use your caller identity, which is kept apart from your trading account. Unlock it once on this device.</p>
        <Button
          size="sm"
          tone="secondary"
          icon={<KeyRound className="size-4" aria-hidden />}
          loading={unlocking}
          onClick={async () => {
            setUnlocking(true);
            setError(null);
            try {
              await account.unlockPrivate();
            } catch (e) {
              setError(describeError(e));
            } finally {
              setUnlocking(false);
            }
          }}
          data-testid="unlock-identity"
        >
          Unlock
        </Button>
        {error ? <p className="text-[12px] text-down">{error}</p> : null}
      </div>
    );
  }

  const body = text.trim();
  const max = tab === "calls" ? NOTE_MAX : POST_MAX;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (tab === "calls") {
        const signed = await signAsCaller(identity, (issuedAt) => callMessage({ identifier: trend.identifier, direction, horizonSec: horizon, note: body, issuedAt }));
        await social.call({ ...signed, identifier: trend.identifier, direction, horizonSec: horizon, note: body });
      } else {
        const signed = await signAsCaller(identity, (issuedAt) => postMessage({ identifier: trend.identifier, body, replyTo: null, callId: null, issuedAt }));
        await social.post({ ...signed, identifier: trend.identifier, body, replyTo: null, callId: null });
      }
      setText("");
      void client.invalidateQueries({ queryKey: ["thread", trend.identifier] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not go through.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface-2 p-3.5">
      {tab === "calls" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label="Direction"
            size="sm"
            value={direction}
            onChange={setDirection}
            className="w-[150px]"
            options={[
              { value: "up", label: "Up", tone: "up" },
              { value: "down", label: "Down", tone: "down" },
            ]}
          />
          <Segmented
            label="Horizon"
            size="sm"
            value={String(horizon)}
            onChange={(v) => setHorizon(Number(v) as Horizon)}
            className="w-[150px]"
            options={[
              { value: "86400", label: "24 hours" },
              { value: "604800", label: "7 days" },
            ]}
          />
        </div>
      ) : null}
      <label className="sr-only" htmlFor="thread-text">
        {tab === "calls" ? "Why (optional)" : "Post"}
      </label>
      <textarea
        id="thread-text"
        value={text}
        onChange={(e) => setText(e.target.value.slice(0, max))}
        rows={tab === "calls" ? 2 : 3}
        placeholder={tab === "calls" ? "Why? (optional)" : "What is driving this?"}
        className="w-full resize-none rounded-xl border border-line bg-surface px-3 py-2.5 text-[14px] leading-5 text-text outline-none transition-colors placeholder:text-text-3 focus:border-primary"
        data-testid="thread-text"
      />
      <div className="flex items-center justify-between gap-3">
        <span className="num text-[12px] text-text-3">
          {body.length}/{max}
        </span>
        <Button
          size="sm"
          tone={tab === "calls" ? (direction === "up" ? "up" : "down") : "primary"}
          disabled={!live || (tab === "talk" && body.length === 0)}
          loading={busy}
          onClick={() => void submit()}
          data-testid="thread-submit"
        >
          {tab === "calls" ? `Call ${direction === "up" ? "up" : "down"} from ${points(trend.index)}` : "Post"}
        </Button>
      </div>
      {!live ? <p className="text-[12px] text-text-3">Calls are made on live trends.</p> : null}
      {error ? <ErrorNote message={error} /> : null}
    </div>
  );
}
