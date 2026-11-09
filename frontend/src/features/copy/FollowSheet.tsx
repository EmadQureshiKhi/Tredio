"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AUTOPILOT_MARKETS_TEXT } from "@tredio/autopilot";
import { Bot, Fingerprint, Info } from "lucide-react";
import { useState } from "react";
import { Avatar } from "@/components/shell/AppShell";
import { Button, ErrorNote, Field, Segmented, Sheet } from "@/components/ui";
import { describeError, useAccount } from "@/lib/account/AccountProvider";
import { autopilot, type Follow } from "@/lib/api";
import { IS_MAINNET } from "@/lib/config";
import { usdc } from "@/lib/format";
import { notify } from "@/lib/toast";
import { GrantSheet } from "@/features/autopilot/grant/GrantSheet";
import { BOT_ACCOUNT, grantUsable, useFollows, useGrant, useHlAddress, usePerformance } from "@/features/autopilot/shared/data";
import { compact } from "@/lib/format";
import { days, signalIdentity } from "@/features/signals/data";
import { type DirectoryLeader, useLeaderDirectory } from "./leaders";
import { COPY_MAX_LEVERAGE, FOLLOW_DEFAULTS, type FollowForm as Form, formOf, validateFollow } from "./follow-form";

// #mainnet: this file branches on the network (testnet or mainnet); MAINNET.md lists what changes.

/**
 * Following a leader: how big each copy is (a ratio of the leader's size or a fixed margin), the
 * caps that bound it, the worst price a copy may pay and the loss that closes every copy, explained
 * in plain words before anything is copied.
 */

export function FollowSheet({ leader, name, open, onOpenChange }: { leader: string | null; name?: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const follows = useFollows();
  const dir = useLeaderDirectory();
  const existing = leader ? (follows.data?.follows.find((f) => f.leader.toLowerCase() === leader.toLowerCase()) ?? null) : null;
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      testId="follow-sheet"
      title={existing ? "Your copy settings" : `Follow ${name ?? (dir.isBot(leader) ? "the Tredio bot" : "this trader")}`}
      description={
        leader && dir.isSignals(leader)
          ? `Each signal they publish in ${AUTOPILOT_MARKETS_TEXT} becomes a Hyperliquid trade from your account at your size, inside caps you set, while your early access lasts.`
          : `Each of their ${AUTOPILOT_MARKETS_TEXT} trades on Hyperliquid is copied from your account at your size, inside caps you set.`
      }
    >
      {leader ? (
        <FollowForm key={`${leader}-${existing?.id ?? "new"}`} leader={leader} name={name} bot={dir.isBot(leader)} signals={dir.isSignals(leader)} board={dir.leader(leader)} existing={existing} onDone={() => onOpenChange(false)} />
      ) : null}
    </Sheet>
  );
}

function FollowForm({ leader, name, bot, signals, board, existing, onDone }: { leader: string; name?: string; bot: boolean; signals: boolean; board: DirectoryLeader | null; existing: Follow | null; onDone: () => void }) {
  const account = useAccount();
  const grant = useGrant();
  const mine = useHlAddress(account.kind === "passkey" ? account.address : null);
  const qc = useQueryClient();
  const [f, setF] = useState<Form>(existing ? formOf(existing.settings) : FOLLOW_DEFAULTS);
  const [tried, setTried] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const { settings, errors } = validateFollow(f);
  const set = (k: keyof Form, v: string) => setF((x) => ({ ...x, [k]: v }));
  const err = (k: keyof Form) => (tried || f[k] !== (existing ? formOf(existing.settings) : FOLLOW_DEFAULTS)[k] ? errors[k] : undefined);
  const self = mine.data === leader.toLowerCase();

  const follow = useMutation({
    // One passkey prompt approves this leader and exactly these caps.
    mutationFn: () => autopilot.follow(leader, settings!, account.approve),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["follows"] });
      await qc.invalidateQueries({ queryKey: ["hl-leaders"] });
      notify.success(existing ? "Copy settings saved" : `Now copying ${name ?? "this trader"}`, existing ? "The new caps apply to the next trade." : signals ? "Autopilot trades each new signal within your caps." : "Autopilot mirrors their Hyperliquid trades within your caps.");
      onDone();
    },
  });
  const submit = () => {
    setTried(true);
    if (!settings) return;
    if (!grantUsable(grant.data)) {
      setGrantOpen(true);
      return;
    }
    follow.mutate();
  };

  if (!account.authenticated) {
    return (
      <div className="flex flex-col gap-4">
        <LeaderSummary leader={leader} name={name} bot={bot} signals={signals} board={board} />
        <Button block size="lg" onClick={account.login}>
          Sign in to follow
        </Button>
      </div>
    );
  }

  const v = (x: string) => Number(x);
  return (
    <form
      className="flex flex-col gap-5 [font-feature-settings:'calt'_0]"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      noValidate
    >
      <LeaderSummary leader={leader} name={name} bot={bot} signals={signals} board={board} />
      <div className="flex flex-col gap-2">
        <p className="font-strong text-[12.5px] text-text-2">Size of each copy</p>
        <Segmented
          label="Size of each copy"
          value={f.mode}
          onChange={(m) => set("mode", m)}
          options={[
            { value: "ratio", label: "Scale their size" },
            { value: "fixed", label: "Fixed margin" },
          ]}
        />
      </div>
      {f.mode === "ratio" ? (
        <Field label="Ratio of their size" suffix="x" inputMode="decimal" value={f.ratio} onChange={(e) => set("ratio", e.target.value)} error={err("ratio")} hint="0.5 copies half their position, 1 the same size." data-testid="follow-ratio" />
      ) : (
        <Field label="Margin per new position" suffix="USDC" inputMode="decimal" value={f.fixed} onChange={(e) => set("fixed", e.target.value)} error={err("fixed")} hint="Every opening trade they make is copied with this margin." data-testid="follow-fixed" />
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Max margin per position" suffix="USDC" inputMode="decimal" value={f.maxMargin} onChange={(e) => set("maxMargin", e.target.value)} error={err("maxMargin")} data-testid="follow-max-margin" />
        <Field label="Max leverage" suffix="x" inputMode="decimal" value={f.maxLeverage} onChange={(e) => set("maxLeverage", e.target.value)} error={err("maxLeverage")} data-testid="follow-max-leverage" />
      </div>
      <Field label="Stop for the day after losing" suffix="USDC" inputMode="decimal" value={f.maxDailyLoss} onChange={(e) => set("maxDailyLoss", e.target.value)} error={err("maxDailyLoss")} data-testid="follow-daily-loss" />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Max slippage" suffix="%" inputMode="decimal" value={f.maxSlippage} onChange={(e) => set("maxSlippage", e.target.value)} error={err("maxSlippage")} data-testid="follow-slippage" />
        <Field label="Loss cap" suffix="USDC" inputMode="decimal" value={f.maxOpenLoss} onChange={(e) => set("maxOpenLoss", e.target.value)} error={err("maxOpenLoss")} data-testid="follow-loss-cap" />
      </div>
      <div className="flex flex-col gap-2 rounded-2xl border border-line bg-surface-2 p-4" data-testid="caps-explainer">
        <p className="flex items-center gap-2 font-strong text-[13px] text-text">
          <Info className="size-4 text-primary" aria-hidden />
          How your caps work
        </p>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[12.5px] leading-[18px] text-text-2">
          <li>
            {f.mode === "ratio" ? `Each trade is copied at ${f.ratio || "?"}x their size` : `Each opening trade is copied with ${f.fixed || "?"} USDC margin`}, then cut to fit: never more than {f.maxMargin || "?"} USDC margin in one position, and never above {f.maxLeverage || "?"}x (higher leverage is reduced; Autopilot&rsquo;s access opens at up to {COPY_MAX_LEVERAGE}x).
          </li>
          {/* Mainnet and testnet prices drift apart, so a mainnet leader's fill bounds nothing on testnet. */}
          {signals ? (
            <li>Each signal carries the market&rsquo;s price when it was published. A copy never fills more than {f.maxSlippage || "?"}% worse than that price or the market price, whichever is tighter; if the price already moved further, that copy is skipped.</li>
          ) : IS_MAINNET || bot ? (
            <li>A copy never fills more than {f.maxSlippage || "?"}% worse than their own fill or the market price, whichever is tighter. If the price already moved further, that copy is skipped.</li>
          ) : (
            <li>They trade on Hyperliquid mainnet and copies fill on testnet, whose prices drift apart, so a copy never fills more than {f.maxSlippage || "?"}% worse than the testnet price when it goes out.</li>
          )}
          <li>Once you lose {f.maxDailyLoss || "?"} USDC in a UTC day, open losses included, new copies stop until the next day. Closes still copy, so you are never left holding their exit.</li>
          <li>If your open copies of this trader are down {f.maxOpenLoss || "?"} USDC together, Autopilot closes them all, pauses this follow and tells you why.</li>
          <li>
            {signals ? "Signals published before you followed are not copied" : "Positions they opened before you followed are not copied"}, and a copy is skipped if your account already holds that market (from a rule or by hand).
          </li>
          {signals ? <li>When your early access ends, this follow pauses and copies nothing new, closes included. Renew it, then resume.</li> : null}
          <li>Their trades in other markets are skipped: Autopilot trades only {AUTOPILOT_MARKETS_TEXT}, the markets the oracle always marks for your account&rsquo;s order guard.</li>
          <li>Copies go out from your account&rsquo;s own Hyperliquid address through Autopilot&rsquo;s Hyperliquid-only access{grant.data?.state === "active" ? `, which ends ${new Date(grant.data.validUntil * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}; your account contract signs only orders within 2% of the oracle&rsquo;s mark.</li>
        </ul>
      </div>
      <p className="text-[12px] leading-4 text-text-3">
        Copying is not advice. Their past trades do not predict yours: fills, fees and funding differ{v(f.maxLeverage) > 1 ? ", and leverage can liquidate a position" : ""}.
      </p>
      {self ? <ErrorNote message="This is your own account's Hyperliquid address." /> : null}
      {account.kind === "wallet" ? <ErrorNote message="Copies trade through a passkey account's guarded session; a NEAR wallet cannot follow." /> : null}
      {follow.error ? <ErrorNote message={describeError(follow.error)} /> : null}
      <Button type="submit" size="lg" block loading={follow.isPending} disabled={self || account.kind === "wallet"} icon={<Fingerprint className="size-[18px]" aria-hidden />} data-testid="follow-submit">
        {existing ? "Save caps" : grantUsable(grant.data) ? "Start copying" : "Grant access and start copying"}
      </Button>
      <p className="-mt-2 text-center text-[12px] leading-4 text-text-3">Your passkey approves {existing ? "new caps" : "who you copy"}.</p>
      <GrantSheet
        open={grantOpen}
        onOpenChange={setGrantOpen}
        reason="Copies trade through Autopilot's Hyperliquid-only access. Approve it with your passkey, then approve the follow."
        onGranted={() => {
          setGrantOpen(false);
          follow.mutate();
        }}
      />
    </form>
  );
}

function LeaderSummary({ leader, name, bot, signals, board }: { leader: string; name?: string; bot: boolean; signals: boolean; board: DirectoryLeader | null }) {
  const perf = usePerformance(bot ? BOT_ACCOUNT : null);
  const dir = useLeaderDirectory();
  const channel = signals ? dir.channel(leader) : null;
  const record = signals
    ? channel
      ? `${channel.signals ?? 0} signals · public after ${days(channel.reveal_delay_sec)}`
      : "Paid signals"
    : bot
    ? perf.data
      ? `${usdc(perf.data.stats.pnlUsdc, { sign: true })} USDC · ${perf.data.stats.trades} trades${perf.data.stats.trades ? ` · ${Math.round(perf.data.stats.winRate * 100)}% wins` : ""} · ${perf.data.followers} following`
      : "Loading record"
    : board
      ? `${board.pnl >= 0 ? "+" : "-"}$${compact(Math.abs(board.pnl))} this month · ${(board.roi * 100).toFixed(1)}% · ${board.followers} following`
      : "Hyperliquid trader";
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-line p-3.5">
      {bot ? (
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary">
          <Bot className="size-5" aria-hidden />
        </span>
      ) : (
        <Avatar address={signals ? signalIdentity(leader) : leader} size={40} />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate font-strong text-[14px] text-text">{name ?? (bot ? "Tredio bot" : leader)}</p>
        <p className="num truncate text-[12.5px] text-text-2">{record}</p>
      </div>
    </div>
  );
}
