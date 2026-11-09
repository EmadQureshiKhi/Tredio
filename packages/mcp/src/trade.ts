/**
 * Trade tools: Up/Down outcome swaps, attention perps, trend coins and calls, sent for the user
 * within the trading policy (policy.ts) by the configured signer (signers.ts).
 *
 * Every tool is a dry run unless `confirm` is true: it answers the quote, read from the contracts'
 * own views and the same arithmetic the contracts run (quote.ts), the exact calls it would send,
 * and whether the policy allows them. With `confirm: true` it builds a fresh quote, checks the
 * policy again, reserves the spend in the ledger, sends, and records the transaction.
 *
 * Which signer can do what:
 * - session key of a passkey account: Up/Down buys and sells (`swap`, always anchored), perp opens
 *   and closes (`perp_open`, `perp_close`);
 * - a NEAR account's own key: all of those through the contracts' normal calls, plus margin
 *   top-ups and coin buys and sells, which on a passkey account are owner actions only the
 *   passkey signs;
 * - calls (`post_call`) are signed by a caller identity key, apart from either.
 */
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toNear, TxError } from "@tredio/chain";
import {
  AccountVersions,
  type Call,
  calls as callsOf,
  COIN_DECIMALS,
  type Curve,
  type CurveQuote,
  type Depth,
  explorerTx,
  fromRaw,
  type IndexSnapshot,
  indexPoints,
  type Market,
  type NearEvent,
  parseEvents,
  type PerpMarket,
  type Position,
  type PositionState,
  type Series,
  type Session,
  type SessionAction,
  sessionCallPrepaid,
  sessionCallTgas,
  type Side,
  toRaw,
  USDC_DECIMALS,
} from "@tredio/contracts";
import { z } from "zod";
import { policyJson, PolicyRefusal, SPENDING_TOOLS, type SpendGuard, type TradeTool } from "./policy";
import { acceptableIndex, anchoredLimit, type BookSide, LOT, minimumOut, PERP, perpPreview, quoteBuy, quoteSell } from "./quote";
import type { ServerDeps } from "./server";
import type { CallerKey, Signer, TxOutcome } from "./signers";
import { identifier, run, WINDOWS, type WindowName, windowName } from "./tools";

export interface TradingDeps {
  /** Who signs trades; null when only calls are configured. */
  signer: Signer | null;
  /** The identity that signs calls; null leaves `post_call` out. */
  caller: CallerKey | null;
  /** The policy and its ledger. */
  guard: SpendGuard;
  /** Tredio's relayer, which refills a session's gas key and contract storage as it does for the app. */
  relayerUrl?: string | null;
  now?: () => number;
}

/** NEAR a plain account deposits for storage where a trade stores something new for it (the app's amounts). */
const OUTCOMES_STORAGE = 2n * 10n ** 22n;
const PERPS_STORAGE = 10n ** 22n;
/** Below this much free storage deposit (yoctoNEAR) at a contract, a trade there tops it up first. */
const STORAGE_MIN = 5n * 10n ** 21n;

const usdc = (raw: bigint | string) => fromRaw(BigInt(raw), USDC_DECIMALS);
const tokens = usdc;
const coins = (raw: bigint | string) => fromRaw(BigInt(raw), COIN_DECIMALS, 9);
const price = (raw: bigint | number) => Number(raw) / 1e6;
const message = (e: unknown) => String((e as Error)?.message ?? e);
const iso = (sec: number) => new Date(sec * 1000).toISOString();

const decimal = (places: number, what: string) =>
  z
    .string()
    .trim()
    .regex(new RegExp(`^\\d+(\\.\\d{1,${places}})?$`), `${what} as a decimal string with at most ${places} places, for example "2.5"`)
    .refine((s) => /[1-9]/.test(s), `${what} must be above 0`);
const usdcAmount = decimal(USDC_DECIMALS, "a USDC amount");
const slippage = (dflt: number, what: string) =>
  z.number().int().min(0).max(2_000).default(dflt).describe(`${what}, in basis points (100 = 1%, at most 2000); default ${dflt}`);
const confirm = z
  .boolean()
  .default(false)
  .describe("false (default): a dry run that sends nothing and answers the quote, the exact calls and the policy check; true: send it now, within the trading policy");
const seriesArgs = {
  series: z.number().int().positive().optional().describe("series id (get_trend, get_market); or give trend and window"),
  trend: identifier.optional().describe("trend identifier, with window, to trade its current series"),
  window: z.enum(["15m", "24h", "7d"]).default("24h").describe("series window when picking by trend (15m exists on testnet only)"),
  side: z.enum(["up", "down"]).describe("up pays 1 USDC if the index ends above its opening value, down if it does not"),
};

const SIGNING = {
  both: "Signing: a passkey account's session key (session action, within the session's scope and on-chain daily USDC limit) or a NEAR account's own key (the contract call itself).",
  account:
    "Signing: a NEAR account's own key only. On a passkey account this is an owner action the passkey signs in the app, so a session key cannot send it; with a session key configured, the dry run still quotes and says so.",
};
const POLICY_NOTE = "Sends only with confirm: true and only within the user's trading policy (the tool named in its allowlist, the USDC cap per call and the daily cap); get_trading_policy shows it.";

/** A trade, ready to show or send. */
interface Plan {
  /** USDC the trade sends out of the account (raw); 0 for sales, closes and calls. */
  spend: bigint;
  quote: Record<string, unknown>;
  /** The exact calls, in order: storage registrations first, the trade last. */
  calls: Call[];
  /** Why it cannot be sent now; the dry run still answers the quote. */
  blocker: string | null;
  notes: string[];
  /** The session's state, on the session path. */
  session?: Record<string, unknown>;
  /** Contracts where a session's account needs free storage (the relayer tops it up). */
  storageAt?: string[];
  /** What the trade did, read from its events; null when the receipts show no trade. */
  result(events: NearEvent[]): Record<string, unknown> | null;
}

/** Every event the transaction's receipts logged. */
export function eventsOf(o: TxOutcome): NearEvent[] {
  return parseEvents([...(o.transaction_outcome?.outcome?.logs ?? []), ...(o.receipts_outcome ?? []).flatMap((r) => r.outcome.logs ?? [])]);
}

const dataOf = (e: NearEvent) => (Array.isArray(e.data) ? e.data[0] : e.data) as Record<string, unknown>;
const find = (events: NearEvent[], standard: string, name: string) => events.find((e) => e.standard === standard && e.event === name);

/** A refusal a contract logged instead of failing (the token call returned the USDC), or null. */
export function refusalOf(events: NearEvent[]): string | null {
  const e = events.find((x) => /(_refused|_rejected)$/.test(x.event));
  if (!e) return null;
  const reason = dataOf(e)?.reason;
  return typeof reason === "string" ? reason : e.event.replace(/_/g, " ");
}

const hashOf = (o: TxOutcome) => o.transaction?.hash ?? o.transaction_outcome?.id ?? "";

export function registerTradeTools(server: McpServer, d: ServerDeps, t: TradingDeps): void {
  const c = d.deployment.contracts;
  const C = callsOf(d.deployment);
  const feeBps = BigInt(d.deployment.params.bookTakerFeeBps);
  const fetchImpl = d.fetchImpl ?? fetch;
  const now = t.now ?? Date.now;
  const nowSec = () => Math.floor(now() / 1000);
  const view = <T>(contract: string, method: string, args: object = {}) => d.chain.view<T>(contract, method, args);
  const versions = new AccountVersions((a) => view<number>(a, "version"));

  const signerJson = (s: Signer) => ({
    path: s.kind === "session" ? "session key of a passkey account" : "own key of a NEAR account",
    account: s.account,
    publicKey: s.publicKey,
  });

  const usdcBalance = async (account: string) => BigInt((await view<string | null>(c.usdc, "ft_balance_of", { account_id: account })) ?? "0");

  /** A gas key's prepaid balance, or null for a plain key (or none). */
  const gasKeyOf = async (account: string, publicKey: string): Promise<bigint | null> => {
    let r: { permission: unknown };
    try {
      r = await d.chain.rpc<{ permission: unknown }>("query", { request_type: "view_access_key", finality: "optimistic", account_id: account, public_key: publicKey });
    } catch (e) {
      if (/UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|does not exist/i.test(message(e))) return null;
      throw e;
    }
    const p = r.permission as Record<string, { balance?: string }> | string;
    const g = typeof p === "object" ? (p.GasKeyFunctionCall ?? p.GasKeyFullAccess) : undefined;
    return g?.balance === undefined ? null : BigInt(g.balance);
  };

  const relayer = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await fetchImpl(`${t.relayerUrl!.replace(/\/+$/, "")}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    const answer = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok) throw new Error(`the relayer answered ${res.status}${answer?.error ? `: ${answer.error}` : ""}`);
    return answer as T;
  };

  // --- Session path -----------------------------------------------------------------------------

  /** The session's state for an action needing `scope` that sends `spend`, and why it cannot act now. */
  const sessionCheck = async (s: Signer, scope: "outcomes" | "perps", spend: bigint) => {
    const [session, frozen, version, gas] = await Promise.all([
      view<Session | null>(s.account, "session", { public_key: s.publicKey }).catch(() => null),
      view<boolean>(s.account, "frozen").catch(() => false),
      versions.of(s.account),
      gasKeyOf(s.account, s.publicKey).catch(() => null),
    ]);
    const today = Math.floor(now() / 86_400_000);
    const spent = session && session.day === today ? BigInt(session.spent) : 0n;
    const left = session && BigInt(session.daily_limit) > spent ? BigInt(session.daily_limit) - spent : 0n;
    const prepaid = sessionCallPrepaid(version);
    const blocker = !session
      ? `${s.publicKey} is not a session of ${s.account}: it was never added or has been revoked`
      : session.expires_at <= nowSec()
        ? `the session expired at ${iso(session.expires_at)}; the account's owner renews it with the passkey`
        : frozen
          ? "the account's owner froze its sessions"
          : !session.scope[scope]
            ? `the session's scope leaves out ${scope}`
            : spend > left
              ? `${usdc(spend)} USDC is above what the session's on-chain daily limit leaves today (${usdc(left)} of ${usdc(session.daily_limit)} USDC)`
              : null;
    return {
      blocker,
      version,
      info: session
        ? {
            label: session.label,
            scope: session.scope,
            expiresAt: session.expires_at,
            dailyLimitUsdc: usdc(session.daily_limit),
            spentTodayUsdc: usdc(spent),
            leftTodayUsdc: usdc(left),
            accountCodeVersion: version,
            sessionCallTgas: sessionCallTgas(version),
            gasKeyNear: gas === null ? null : toNear(gas),
            gasPerCallNear: toNear(prepaid),
          }
        : { found: false },
    };
  };

  /**
   * Before a session sends: its gas key must hold what a session call prepays, and the account
   * needs free storage where the trade stores something new; the relayer refills both for Tredio
   * accounts, as it does for the app.
   */
  const readySession = async (s: Signer, storageAt: string[]) => {
    const [version, gas] = await Promise.all([versions.of(s.account), gasKeyOf(s.account, s.publicKey)]);
    const needed = sessionCallPrepaid(version);
    if (gas !== null && gas < needed) {
      if (!t.relayerUrl) throw new Error(`the session's gas key holds ${toNear(gas)} NEAR, below the ${toNear(needed)} NEAR a session call prepays; set TREDIO_RELAYER_URL so the relayer refills it, or refill it in the app`);
      await relayer("/v1/sessions/fund", { account: s.account, publicKey: s.publicKey });
    }
    if (!t.relayerUrl) return;
    await Promise.all(
      storageAt.map(async (contract) => {
        const b = await view<{ available: string } | null>(contract, "storage_balance_of", { account_id: s.account }).catch(() => undefined);
        // A failure here leaves the trade to report the problem, as in the app.
        if (b === undefined || (b && BigInt(b.available) >= STORAGE_MIN)) return;
        await relayer("/v1/storage/fund", { account: s.account, contract }).catch(() => null);
      }),
    );
  };

  // --- Plain account path -------------------------------------------------------------------------

  const storageCall = (contract: string, account: string, deposit: bigint): Call => ({
    receiverId: contract,
    methodName: "storage_deposit",
    args: { account_id: account, registration_only: false },
    deposit: deposit.toString(),
    gas: (30n * 10n ** 12n).toString(),
  });

  /** Storage deposits a plain account needs before the trade: USDC registration, and free room where the trade stores something. */
  const storageFor = async (account: string, at: Array<{ contract: string; deposit: bigint }>, usdcRegistration: boolean): Promise<Call[]> => {
    const [usdcReg, ...rooms] = await Promise.all([
      usdcRegistration ? view<unknown>(c.usdc, "storage_balance_of", { account_id: account }) : Promise.resolve(true),
      ...at.map((x) => view<{ available: string } | null>(x.contract, "storage_balance_of", { account_id: account })),
    ]);
    return [
      ...(usdcReg ? [] : [C.usdc.storageDeposit(account)]),
      ...at.flatMap((x, i) => {
        const b = rooms[i];
        return b && BigInt(b.available) >= STORAGE_MIN ? [] : [storageCall(x.contract, account, x.deposit)];
      }),
    ];
  };

  // --- Sending ------------------------------------------------------------------------------------

  const requireSigner = (): Signer => {
    if (!t.signer) throw new Error("no trading key is configured: set TREDIO_TRADER_ACCOUNT and TREDIO_TRADER_PRIVATE_KEY (a NEAR account) or TREDIO_SESSION_ACCOUNT and TREDIO_SESSION_KEY (a passkey account's session)");
    return t.signer;
  };

  /** A dry run, or the trade sent within the policy and recorded in the ledger. */
  const execute = async (tool: TradeTool, args: Record<string, unknown>, build: (s: Signer) => Promise<Plan>): Promise<Record<string, unknown>> => {
    const s = requireSigner();
    const plan = await build(s);
    const policy = t.guard.check(tool, plan.spend);
    const head = {
      tool,
      network: d.network,
      signer: signerJson(s),
      spendUsdc: usdc(plan.spend),
      quote: plan.quote,
      ...(plan.session ? { session: plan.session } : {}),
      calls: plan.calls,
      ...(plan.notes.length ? { notes: plan.notes } : {}),
      policy,
    };
    if (args.confirm !== true) {
      const blocker = plan.blocker ?? (policy.allowed ? null : `the trading policy refuses it: ${policy.reason}`);
      return { dryRun: true, ready: blocker === null, blocker, ...head, next: blocker === null ? "call again with the same arguments and confirm: true to send it (the quote is read again then)" : null };
    }
    if (plan.blocker) throw new Error(`not sent: ${plan.blocker}`);
    const { confirm: _, ...recorded } = args;
    let entry;
    try {
      entry = t.guard.reserve({ tool, account: s.account, signer: s.kind, spend: plan.spend, args: recorded });
    } catch (e) {
      if (e instanceof PolicyRefusal) throw new Error(`not sent: the trading policy refuses it: ${e.message}`);
      throw e;
    }
    const setupHashes: string[] = [];
    try {
      if (s.kind === "session") await readySession(s, plan.storageAt ?? []);
      for (const call of plan.calls.slice(0, -1)) setupHashes.push(hashOf(await s.send(call)));
    } catch (e) {
      t.guard.settle(entry.id, { status: "failed", setupHashes, error: message(e) });
      throw new Error(`not sent: ${message(e)}`);
    }
    let outcome: TxOutcome;
    let warning: string | null = null;
    try {
      outcome = await s.send(plan.calls.at(-1)!);
    } catch (e) {
      const ran = e instanceof TxError && e.outcome !== undefined;
      const hash = e instanceof TxError ? (e.hash ?? null) : null;
      // A receipt can fail after the trade itself went through (a delivery the contract then kept for the account).
      if (ran && plan.result(eventsOf(e.outcome as TxOutcome)) !== null) {
        outcome = e.outcome as TxOutcome;
        warning = `the trade went through, but a later receipt failed: ${message(e)}`;
      } else {
        const neverSent = e instanceof TxError && !e.hash;
        t.guard.settle(entry.id, { status: ran || neverSent ? "failed" : "unknown", hash, setupHashes, error: message(e) });
        if (ran) throw new Error(`the transaction failed on chain: ${message(e)}; nothing was spent (a failed token call returns its USDC). Transaction ${hash}: ${explorerTx(d.network, hash!)}`);
        if (neverSent) throw new Error(`not sent: ${message(e)}`);
        throw new Error(`the transaction's outcome is unknown: ${message(e)}${hash ? `. Look it up before trying again: ${explorerTx(d.network, hash)}` : ""}; its USDC counts against today's cap until then`);
      }
    }
    const hash = hashOf(outcome);
    const events = eventsOf(outcome);
    const refused = refusalOf(events);
    if (refused) {
      t.guard.settle(entry.id, { status: "refused", hash, setupHashes, error: refused });
      throw new Error(`the contract refused it: ${refused}; the USDC went back. Transaction ${hash}: ${explorerTx(d.network, hash)}`);
    }
    t.guard.settle(entry.id, { status: "sent", hash, setupHashes });
    const after = t.guard.check(tool, 0n);
    return {
      sent: true,
      tool,
      network: d.network,
      signer: signerJson(s),
      hash,
      explorer: explorerTx(d.network, hash),
      ...(setupHashes.length ? { setupHashes } : {}),
      spendUsdc: usdc(plan.spend),
      result: plan.result(events),
      ...(warning ? { warning } : {}),
      policy: { spentTodayUsdc: after.spentTodayUsdc, leftTodayUsdc: after.leftTodayUsdc, dailyCapUsdc: after.dailyCapUsdc },
    };
  };

  // --- Calls ----------------------------------------------------------------------------------------

  const caller = t.caller;
  if (caller) {
    type CallArgs = { trend: string; direction: "up" | "down"; horizon: "24h" | "7d"; note: string; confirm: boolean };
    server.registerTool(
      "post_call",
      {
        title: "Post a call",
        description:
          "Posts a public call on a live trend: that its index will be up or down after 24 hours or 7 days, with an optional note. Calls resolve against the registry's own checkpoints and build the caller's public hit rate (get_leaders callers); at most 20 a day per caller. Spends nothing. " +
          "Posts only with confirm: true and only when the user's trading policy names post_call (get_trading_policy shows it). Signed by the caller identity configured here (ed25519 over the call text; the caller id is its public key in hex), through Tredio's API. It is the agent's own identity, not the person's: a passkey account's identity is derived from the passkey inside the app and never leaves it.",
        inputSchema: {
          trend: identifier.describe("a live (active or cooling) trend"),
          direction: z.enum(["up", "down"]),
          horizon: z.enum(["24h", "7d"]).default("24h"),
          note: z.string().max(280).default("").describe("why, at most 280 characters (public)"),
          confirm,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      run(async (a: CallArgs) => {
        const snap = await view<IndexSnapshot | null>(c.registry, "index_of", { id: a.trend });
        const horizonSec = WINDOWS[a.horizon];
        const issuedAt = nowSec();
        const text = `Tredio call\ntrend: ${a.trend}\ndirection: ${a.direction}\nhorizon: ${horizonSec}\nnote: ${createHash("sha256").update(a.note).digest("hex")}\nissued: ${issuedAt}`;
        const policy = t.guard.check("post_call", 0n);
        const blocker = !snap ? `no trend ${a.trend} in the registry` : snap.status === "retired" ? `${a.trend} retired; calls are made on live trends` : null;
        const head = { tool: "post_call", network: d.network, caller: caller.identity, api: `${d.api.baseUrl}/v1/calls`, call: { trend: a.trend, direction: a.direction, horizonSec, note: a.note, indexNow: snap ? indexPoints(snap.index) : null }, signedText: text, policy };
        if (!a.confirm) {
          const b = blocker ?? (policy.allowed ? null : `the trading policy refuses it: ${policy.reason}`);
          return { dryRun: true, ready: b === null, blocker: b, ...head, next: b === null ? "call again with confirm: true to post it" : null };
        }
        if (blocker) throw new Error(`not posted: ${blocker}`);
        const { confirm: _, ...recorded } = a;
        let entry;
        try {
          entry = t.guard.reserve({ tool: "post_call", account: caller.identity, signer: "caller", spend: 0n, args: recorded });
        } catch (e) {
          if (e instanceof PolicyRefusal) throw new Error(`not posted: the trading policy refuses it: ${e.message}`);
          throw e;
        }
        try {
          const r = await d.api.post<{ call: { id: number; openingIndex: number; calledAt: number; resolvesAt: number } }>("/v1/calls", {
            caller: caller.identity,
            identifier: a.trend,
            direction: a.direction,
            horizonSec,
            note: a.note,
            issuedAt,
            signature: caller.sign(text),
          });
          t.guard.settle(entry.id, { status: "sent", hash: `call:${r.call.id}` });
          return { posted: true, tool: "post_call", caller: caller.identity, call: { id: r.call.id, trend: a.trend, direction: a.direction, horizonSec, openingIndex: r.call.openingIndex, calledAt: r.call.calledAt, resolvesAt: r.call.resolvesAt }, url: `${d.api.baseUrl}/v1/calls/${r.call.id}` };
        } catch (e) {
          t.guard.settle(entry.id, { status: "failed", error: message(e) });
          throw new Error(`not posted: ${message(e)}`);
        }
      }),
    );
  }

  // --- The policy -----------------------------------------------------------------------------------

  server.registerTool(
    "get_trading_policy",
    {
      title: "Trading policy and today's spend",
      description:
        "What the trade tools may do here: the signer (a passkey account's session key or a NEAR account's own key) and which tools it can send, the caller identity for calls, the user's policy (the tools it allows, the USDC cap per call of each spending tool, the daily cap across them, UTC days), today's spend and what is left, and every trade sent today with its transaction.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    run(async () => {
      const s = t.signer;
      const sessionTools = ["buy_outcome", "sell_outcome", "open_perp", "close_perp"];
      return {
        network: d.network,
        signer: s ? { ...signerJson(s), canSend: s.kind === "session" ? sessionTools : ["buy_outcome", "sell_outcome", "open_perp", "close_perp", "add_perp_margin", "buy_coin", "sell_coin"] } : null,
        caller: caller ? { identity: caller.identity, canSend: ["post_call"] } : null,
        policy: policyJson(t.guard.policy),
        spendingTools: SPENDING_TOOLS,
        ledger: t.guard.ledger.file,
        today: t.guard.summary(),
      };
    }),
  );

  // Trading itself needs a key; without one only calls and the policy are offered.
  if (!t.signer) return;

  /** The session call for `action`, with the gas the account's code needs. */
  const sessionCall = async (s: Signer, action: SessionAction) => C.account.sessionCall(s.account, action, sessionCallTgas(await versions.of(s.account)));

  // --- Up/Down --------------------------------------------------------------------------------------

  const resolveSeries = async (a: { series?: number; trend?: string; window: WindowName }): Promise<Series> => {
    if (a.series === undefined && !a.trend) throw new Error("give a series id, or a trend and a window");
    const s = a.series !== undefined ? await view<Series | null>(c.outcomes, "get_series", { series: a.series }) : await view<Series | null>(c.outcomes, "latest_series", { trend: a.trend, window: WINDOWS[a.window] });
    if (!s) throw new Error(a.series !== undefined ? `no series ${a.series}` : `no ${a.window} series for ${a.trend}`);
    return s;
  };

  type OutcomeArgs = { series?: number; trend?: string; window: WindowName; side: Side; slippageBps: number; confirm: boolean };

  const outcomePlan = async (s: Signer, a: OutcomeArgs, buy: boolean, amount: bigint): Promise<Plan> => {
    const series = await resolveSeries(a);
    const side = a.side;
    const tokenId = `${series.id}:${side}`;
    const open = series.outcome === "open" && series.expiry > nowSec();
    const [market, snap, depth, fairUp, held] = await Promise.all([
      view<Market | null>(c.book, "get_market", { series: series.id, side }),
      view<IndexSnapshot | null>(c.registry, "index_of", { id: series.trend }),
      view<Depth>(c.book, "depth", { series: series.id, side, levels: 50 }).catch(() => null),
      open ? view<string>(c.registry, "fair_up", { id: series.trend, opening: series.opening_index, expiry: series.expiry }).catch(() => null) : Promise.resolve(null),
      buy ? usdcBalance(s.account) : view<string>(c.outcomes, "mt_balance_of", { account_id: s.account, token_id: tokenId }).then((b) => BigInt(b ?? "0")),
    ]);
    const fair = fairUp === null ? null : side === "up" ? BigInt(fairUp) : 1_000_000n - BigInt(fairUp);
    const limit = fair === null ? null : anchoredLimit(buy, fair);
    const book: BookSide = { bids: (depth?.bids ?? []).map((l) => ({ tick: l.tick, size: BigInt(l.size) })), asks: (depth?.asks ?? []).map((l) => ({ tick: l.tick, size: BigInt(l.size) })) };
    const q = limit === null ? null : buy ? quoteBuy(book, amount, feeBps, limit) : quoteSell(book, amount, feeBps, limit);
    const minOut = q ? minimumOut(q.out, a.slippageBps) : 0n;
    const action: SessionAction = { swap: { series: series.id, side, buy, amount: amount.toString(), min_out: minOut.toString() } };
    const msg = JSON.stringify({ swap: { series: series.id, side, limit_tick: null, min_out: minOut.toString(), anchored: true } });
    const session = s.kind === "session" ? await sessionCheck(s, "outcomes", buy ? amount : 0n) : null;
    const calls =
      s.kind === "session"
        ? [await sessionCall(s, action)]
        : buy
          ? [...(await storageFor(s.account, [{ contract: c.outcomes, deposit: OUTCOMES_STORAGE }], true)), C.book.depositUsdc(amount.toString(), msg)]
          : [...(await storageFor(s.account, [], true)), C.outcomes.toBook(series.id, side, amount.toString(), msg)];
    const what = buy ? "asks" : "bids";
    const blocker =
      series.outcome !== "open"
        ? `series ${series.id} has settled (${series.outcome}); it trades no more`
        : series.expiry <= nowSec()
          ? `series ${series.id} expired at ${iso(series.expiry)}; it trades no more`
          : !market
            ? `the book does not list series ${series.id} ${side}`
            : !snap || !snap.fresh || snap.status === "retired"
              ? `the index of ${series.trend} is not fresh, and anchored swaps refuse a stale index`
              : fair === null
                ? "could not read the attention-implied value from the registry; try again"
                : !buy && amount < LOT
                  ? "sell at least 0.001 tokens (the book trades lots of 0.001)"
                  : held < amount
                    ? buy
                      ? `the account holds ${usdc(held)} USDC, less than ${usdc(amount)}`
                      : `the account holds ${tokens(held)} ${side} tokens of series ${series.id}, less than ${tokens(amount)}`
                    : !q || q.out === 0n
                      ? `nothing would fill: the book has no ${what} within the anchored band (0.10 USDC around the implied value ${price(fair)})`
                      : (session?.blocker ?? null);
    const notes = [
      "The swap is anchored: the book reads the registry when it runs and fills only within 0.10 USDC of the attention-implied value, and only while the index is fresh; otherwise it refunds.",
      ...(q && !q.complete && q.out > 0n ? [buy ? "The book fills only part of the budget within the band; the unused USDC comes back." : "The bids within the band take only part of the tokens; the rest come back."] : []),
    ];
    return {
      spend: buy ? amount : 0n,
      quote: {
        series: series.id,
        trend: series.trend,
        window: windowName(series.window),
        expiry: series.expiry,
        side,
        indexNow: snap ? indexPoints(snap.index) : null,
        openingIndex: indexPoints(series.opening_index),
        fairValue: fair === null ? null : price(fair),
        worstPriceAllowed: limit === null ? null : limit / 1000,
        ...(buy
          ? { usdcIn: usdc(amount), tokensOut: q ? tokens(q.out) : "0", usdcUsed: q ? usdc(q.filled) : "0", minTokensOut: tokens(minOut) }
          : { tokensIn: tokens(amount), usdcOut: q ? usdc(q.out) : "0", tokensSold: q ? tokens(q.filled) : "0", minUsdcOut: usdc(minOut) }),
        averagePrice: q?.averagePrice ?? null,
        worstPrice: q?.worstTick == null ? null : q.worstTick / 1000,
        fillsCompletely: q?.complete ?? false,
        takerFeeBps: Number(feeBps),
        slippageBps: a.slippageBps,
      },
      calls,
      blocker,
      notes,
      ...(session ? { session: session.info } : {}),
      storageAt: [c.book, c.outcomes],
      result: (events) => {
        const e = find(events, "tredio-book", "swap");
        if (!e) return null;
        const x = dataOf(e) as { amount_in: string; amount_out: string; fair?: string | null };
        return buy
          ? { series: series.id, side, usdcSpent: usdc(x.amount_in), tokensReceived: tokens(x.amount_out), fairValue: x.fair ? price(BigInt(x.fair)) : null }
          : { series: series.id, side, tokensSold: tokens(x.amount_in), usdcReceived: usdc(x.amount_out), fairValue: x.fair ? price(BigInt(x.fair)) : null };
      },
    };
  };

  server.registerTool(
    "buy_outcome",
    {
      title: "Buy Up or Down tokens",
      description:
        `Buys Up or Down tokens of an outcome series with USDC through an anchored swap on Tredio's book: it fills only within 0.10 USDC of the attention-implied fair value and only while the index is fresh, and the rest of the budget comes back. Spends at most usdc. ${POLICY_NOTE} ` +
        `The dry run answers the fair value, the tokens the book would fill now (taker fee included), the average and worst price and the minimum accepted. ${SIGNING.both} Session action: swap (outcomes scope); own key: ft_transfer_call of USDC to the book with a swap message.`,
      inputSchema: { ...seriesArgs, usdc: usdcAmount.describe("USDC to spend, for example \"5\""), slippageBps: slippage(100, "how far below the quoted tokens the swap may fill"), confirm },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    run(async (a: OutcomeArgs & { usdc: string }) => execute("buy_outcome", a, (s) => outcomePlan(s, a, true, toRaw(a.usdc, USDC_DECIMALS)))),
  );

  server.registerTool(
    "sell_outcome",
    {
      title: "Sell Up or Down tokens",
      description:
        `Sells Up or Down tokens of an outcome series for USDC through an anchored swap on Tredio's book (within 0.10 USDC of the attention-implied value, fresh index only; unsold tokens come back). Spends no USDC. ${POLICY_NOTE} ` +
        `The dry run answers the USDC the bids would pay now after the taker fee, the average and worst price and the minimum accepted. ${SIGNING.both} Session action: swap with buy false (outcomes scope); own key: mt_transfer_call of the tokens to the book with a swap message.`,
      inputSchema: { ...seriesArgs, tokens: decimal(USDC_DECIMALS, "a token amount").describe("tokens to sell (6 decimals; the book trades lots of 0.001), for example \"10\""), slippageBps: slippage(100, "how far below the quoted USDC the swap may fill"), confirm },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    run(async (a: OutcomeArgs & { tokens: string }) => execute("sell_outcome", a, (s) => outcomePlan(s, a, false, toRaw(a.tokens, USDC_DECIMALS)))),
  );

  // --- Perps ----------------------------------------------------------------------------------------

  type OpenArgs = { trend: string; side: "long" | "short"; margin: string; leverage: number; slippageBps: number; confirm: boolean };
  server.registerTool(
    "open_perp",
    {
      title: "Open an attention perp",
      description:
        `Opens an attention perp position on a trend: margin in USDC (the 10 bps fee on notional comes out of it), isolated, 1x to 3x; one contract gains or loses 1 USDC per index point. Refuses when the index is stale, the trend is not active, the index moved past acceptableIndex, or the side's open interest cap is full (the contract then returns the margin). Spends margin. ${POLICY_NOTE} ` +
        `The dry run answers the fee, net margin, notional, contracts, liquidation index, funding per hour and the worst entry index. ${SIGNING.both} Session action: perp_open (perps scope); own key: ft_transfer_call of the margin to the perps contract with an open message.`,
      inputSchema: {
        trend: identifier.describe("trend identifier"),
        side: z.enum(["long", "short"]).describe("long gains when the index rises"),
        margin: usdcAmount.describe("USDC margin, fee included (at least about 1 USDC stays as margin), for example \"10\""),
        leverage: z.number().min(1).max(3).default(1).describe("notional over margin, 1 to 3 (two decimals at most)"),
        slippageBps: slippage(100, "how far the index may move against the entry before the open refuses"),
        confirm,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    run(async (a: OpenArgs) =>
      execute("open_perp", a, async (s) => {
        const margin = toRaw(a.margin, USDC_DECIMALS);
        const isLong = a.side === "long";
        const leverageBps = Math.round(a.leverage * 10_000);
        const [snap, market, held, mine] = await Promise.all([
          view<IndexSnapshot | null>(c.registry, "index_of", { id: a.trend }),
          view<PerpMarket>(c.perps, "get_market", { trend: a.trend }),
          usdcBalance(s.account),
          view<Position[]>(c.perps, "positions_of", { account_id: s.account }),
        ]);
        if (!snap) throw new Error(`no trend ${a.trend} in the registry`);
        const index = indexPoints(snap.index);
        const cap = BigInt(await view<string>(c.perps, "open_interest_cap", { index: snap.index }));
        const p = perpPreview({ margin, leverageBps, index, isLong, longQty: BigInt(market.long_qty), shortQty: BigInt(market.short_qty) });
        const acceptable = acceptableIndex(index, isLong, a.slippageBps);
        const action: SessionAction = { perp_open: { trend: a.trend, is_long: isLong, margin: margin.toString(), leverage_bps: leverageBps, acceptable_index: acceptable } };
        const session = s.kind === "session" ? await sessionCheck(s, "perps", margin) : null;
        const calls =
          s.kind === "session"
            ? [await sessionCall(s, action)]
            : [...(await storageFor(s.account, [{ contract: c.perps, deposit: PERPS_STORAGE }], true)), C.perps.open(a.trend, isLong, margin.toString(), leverageBps, acceptable)];
        const blocker =
          snap.status !== "active"
            ? `perps open only on active trends; ${a.trend} is ${snap.status}`
            : !snap.fresh
              ? `the index of ${a.trend} is not fresh, and the perps contract refuses a stale index`
              : !p || p.net < PERP.minMargin
                ? "the margin left after the fee would be under 1 USDC; give more margin"
                : p.sideNotionalAfter > cap
                  ? `the ${a.side} side's open interest would reach ${usdc(p.sideNotionalAfter)} USDC, over its cap of ${usdc(cap)} USDC`
                  : held < margin
                    ? `the account holds ${usdc(held)} USDC, less than ${usdc(margin)}`
                    : mine.length >= 32
                      ? "the account already holds 32 perp positions, the most the contract keeps per account"
                      : (session?.blocker ?? null);
        return {
          spend: margin,
          quote: {
            trend: a.trend,
            side: a.side,
            index,
            fresh: snap.fresh,
            leverage: leverageBps / 10_000,
            marginUsdc: usdc(margin),
            feeUsdc: p ? usdc(p.fee) : null,
            netMarginUsdc: p ? usdc(p.net) : null,
            notionalUsdc: p ? usdc(p.notional) : null,
            contracts: p ? coins(p.qty) : null,
            usdcPerIndexPoint: p?.perPoint ?? null,
            liquidationIndex: p?.liquidationIndex ?? null,
            fundingPctPerHour: p?.fundingPerHourPct ?? null,
            acceptableIndex: indexPoints(acceptable),
            sideNotionalAfterUsdc: p ? usdc(p.sideNotionalAfter) : null,
            openInterestCapUsdc: usdc(cap),
            closeFeeUsdcNow: p ? usdc(p.closeFee) : null,
          },
          calls,
          blocker,
          notes: ["A refused open (stale index, cap, price moved) is logged by the perps contract and returns the margin."],
          ...(session ? { session: session.info } : {}),
          storageAt: [c.perps],
          result: (events) => {
            const e = find(events, "tredio-perps", "position_opened");
            if (!e) return null;
            const x = dataOf(e) as { id: number; entry_index: number; qty: string; margin: string; fee: string };
            return { position: x.id, trend: a.trend, side: a.side, entryIndex: indexPoints(x.entry_index), contracts: coins(x.qty), marginUsdc: usdc(x.margin), feeUsdc: usdc(x.fee) };
          },
        };
      }),
    ),
  );

  const ownPosition = async (s: Signer, id: number) => {
    const p = await view<Position | null>(c.perps, "get_position", { id });
    if (!p) throw new Error(`no perp position ${id}; get_account lists the account's positions`);
    if (p.owner !== s.account) throw new Error(`position ${id} belongs to ${p.owner}, not ${s.account}`);
    return p;
  };

  type CloseArgs = { position: number; slippageBps: number; confirm: boolean };
  server.registerTool(
    "close_perp",
    {
      title: "Close an attention perp",
      description:
        `Closes one of the account's attention perp positions at the current index and pays out its equity in USDC (10 bps fee on notional). Refuses when the index is stale or moved past acceptableIndex; a retired trend's position settles through settle_retired instead. Spends no USDC. ${POLICY_NOTE} ` +
        `The dry run answers the equity, PnL, funding, close fee and the worst exit index. ${SIGNING.both} Session action: perp_close (perps scope); own key: close on the perps contract.`,
      inputSchema: { position: z.number().int().min(0).describe("position id (get_account lists them)"), slippageBps: slippage(100, "how far the index may move against the exit before the close refuses"), confirm },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    run(async (a: CloseArgs) =>
      execute("close_perp", a, async (s) => {
        const p = await ownPosition(s, a.position);
        const [snap, state] = await Promise.all([view<IndexSnapshot | null>(c.registry, "index_of", { id: p.trend }), view<PositionState>(c.perps, "position_state", { id: p.id })]);
        if (!snap) throw new Error(`no trend ${p.trend} in the registry`);
        const index = indexPoints(snap.index);
        const acceptable = acceptableIndex(index, !p.is_long, a.slippageBps);
        const session = s.kind === "session" ? await sessionCheck(s, "perps", 0n) : null;
        const calls = s.kind === "session" ? [await sessionCall(s, { perp_close: { id: p.id, acceptable_index: acceptable } })] : [...(await storageFor(s.account, [], true)), C.perps.close(p.id, acceptable)];
        const fee = (BigInt(state.notional) * PERP.feeBps) / 10_000n;
        const equity = BigInt(state.equity);
        const blocker =
          snap.status === "retired"
            ? `${p.trend} retired: the position settles at the final index with settle_retired on the perps contract, which anyone may call`
            : !snap.fresh
              ? `the index of ${p.trend} is not fresh, and the perps contract refuses a stale index`
              : (session?.blocker ?? null);
        return {
          spend: 0n,
          quote: {
            position: p.id,
            trend: p.trend,
            side: p.is_long ? "long" : "short",
            entryIndex: indexPoints(p.entry_index),
            index,
            contracts: coins(p.qty),
            marginUsdc: usdc(p.margin),
            equityUsdc: Number(state.equity) / 1e6,
            pnlUsdc: Number(state.pnl) / 1e6,
            fundingUsdc: Number(state.funding) / 1e6,
            closeFeeUsdc: usdc(fee),
            payoutUsdcAbout: equity > fee ? usdc(equity - fee) : "0",
            liquidatable: state.liquidatable,
            acceptableIndex: indexPoints(acceptable),
          },
          calls,
          blocker,
          notes: [],
          ...(session ? { session: session.info } : {}),
          result: (events) => {
            const e = find(events, "tredio-perps", "position_closed");
            if (!e) return null;
            const x = dataOf(e) as { id: number; exit_index: number; pnl: string; funding: string; fee: string; payout: string };
            return { position: x.id, exitIndex: indexPoints(x.exit_index), pnlUsdc: Number(x.pnl) / 1e6, fundingUsdc: Number(x.funding) / 1e6, feeUsdc: usdc(x.fee), payoutUsdc: usdc(x.payout) };
          },
        };
      }),
    ),
  );

  const OWNER_ONLY = (what: string) =>
    `${what} is an owner action on a passkey account (the passkey signs it in the app); a session key cannot send it. Use a NEAR account's own key (TREDIO_TRADER_ACCOUNT) for it.`;

  type MarginArgs = { position: number; usdc: string; confirm: boolean };
  server.registerTool(
    "add_perp_margin",
    {
      title: "Add margin to a perp",
      description: `Adds USDC margin to one of the account's attention perp positions, which moves its liquidation index away. Spends usdc. ${POLICY_NOTE} ${SIGNING.account} Own key: ft_transfer_call of the USDC to the perps contract with an add_margin message.`,
      inputSchema: { position: z.number().int().min(0).describe("position id (get_account lists them)"), usdc: usdcAmount.describe("USDC to add, for example \"5\""), confirm },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    run(async (a: MarginArgs) =>
      execute("add_perp_margin", a, async (s) => {
        const amount = toRaw(a.usdc, USDC_DECIMALS);
        const p = await ownPosition(s, a.position);
        const [state, held] = await Promise.all([view<PositionState>(c.perps, "position_state", { id: p.id }), usdcBalance(s.account)]);
        const blocker = s.kind === "session" ? OWNER_ONLY("Adding margin") : held < amount ? `the account holds ${usdc(held)} USDC, less than ${usdc(amount)}` : null;
        return {
          spend: amount,
          quote: { position: p.id, trend: p.trend, side: p.is_long ? "long" : "short", marginUsdc: usdc(p.margin), marginAfterUsdc: usdc(BigInt(p.margin) + amount), equityUsdc: Number(state.equity) / 1e6, liquidationIndexNow: indexPoints(state.liquidation_index) },
          calls: s.kind === "session" ? [] : [C.perps.addMargin(p.id, amount.toString())],
          blocker,
          notes: [],
          result: (events) => {
            const e = find(events, "tredio-perps", "margin_added");
            return e ? { position: p.id, addedUsdc: usdc((dataOf(e) as { amount: string }).amount) } : null;
          },
        };
      }),
    ),
  );

  // --- Coins ----------------------------------------------------------------------------------------

  const curveOf = async (trend: string) => {
    const curve = await view<Curve | null>(c.coins, "get_curve", { trend });
    if (!curve) throw new Error(`${trend} has no coin yet`);
    return curve;
  };
  const spot = (raw: string) => fromRaw(BigInt(raw), USDC_DECIMALS + 18, 12);

  type CoinBuyArgs = { trend: string; usdc: string; slippageBps: number; confirm: boolean };
  server.registerTool(
    "buy_coin",
    {
      title: "Buy a trend coin",
      description: `Buys a trend's coin on its bonding curve with USDC (fee included), at least the quoted coins less slippage; the curve refuses (and returns the USDC) when the trend is not active or the curve has graduated. Spends usdc. ${POLICY_NOTE} The dry run answers the coins out, the fee and the spot price before and after, from the coins contract's own quote. ${SIGNING.account} Own key: ft_transfer_call of the USDC to the coins factory with a buy message.`,
      inputSchema: { trend: identifier.describe("trend identifier"), usdc: usdcAmount.describe("USDC to spend, for example \"2\""), slippageBps: slippage(200, "how far below the quoted coins the buy may fill"), confirm },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    run(async (a: CoinBuyArgs) =>
      execute("buy_coin", a, async (s) => {
        const amount = toRaw(a.usdc, USDC_DECIMALS);
        const [curve, snap, held] = await Promise.all([curveOf(a.trend), view<IndexSnapshot | null>(c.registry, "index_of", { id: a.trend }), usdcBalance(s.account)]);
        // A buy first raises the floor to the trend's peak attention, so the quote takes the registry's peak.
        const [q, spotNow] = await Promise.all([
          view<CurveQuote | null>(c.coins, "quote_buy", { trend: a.trend, usdc_in: amount.toString(), ...(snap ? { peak_index: snap.peak_index } : {}) }),
          curve.stage === "creating" ? Promise.resolve("0") : view<string>(c.coins, "spot_price", { trend: a.trend }),
        ]);
        const minOut = q ? minimumOut(BigInt(q.out), a.slippageBps) : 0n;
        const blocker =
          s.kind === "session"
            ? OWNER_ONLY("A coin trade")
            : curve.stage !== "open"
              ? `the curve is ${curve.stage}: coins sell on the curve only while it is open${curve.pool_id !== null ? ` (it trades on Rhea pool ${curve.pool_id} now)` : ""}`
              : snap?.status !== "active"
                ? `coin buys need an active trend; ${a.trend} is ${snap?.status ?? "unknown"}`
                : !q
                  ? "the curve will not quote this amount"
                  : held < amount
                    ? `the account holds ${usdc(held)} USDC, less than ${usdc(amount)}`
                    : null;
        return {
          spend: amount,
          quote: { trend: a.trend, coin: curve.coin, stage: curve.stage, usdcIn: usdc(amount), coinsOut: q ? coins(q.out) : null, feeUsdc: q ? usdc(q.fee) : null, minCoinsOut: coins(minOut), spotUsdc: spot(spotNow), spotAfterUsdc: q ? spot(q.spot_after) : null, slippageBps: a.slippageBps },
          calls: s.kind === "session" ? [] : [...(await storageFor(s.account, [], true)), C.coins.buy(a.trend, amount.toString(), minOut.toString())],
          blocker,
          notes: [],
          result: (events) => {
            const e = events.find((x) => x.standard === "tredio-coins" && x.event === "trade" && dataOf(x).is_buy === true);
            if (!e) return null;
            const x = dataOf(e) as { usdc: string; coins: string; fee: string; spot: string };
            return { coin: curve.coin, usdcSpent: usdc(x.usdc), coinsReceived: coins(x.coins), feeUsdc: usdc(x.fee), spotAfterUsdc: spot(x.spot) };
          },
        };
      }),
    ),
  );

  type CoinSellArgs = { trend: string; coins: string; slippageBps: number; confirm: boolean };
  server.registerTool(
    "sell_coin",
    {
      title: "Sell a trend coin",
      description: `Sells a trend's coin back to its bonding curve for USDC (fee deducted), at least the quoted USDC less slippage. Spends no USDC. ${POLICY_NOTE} The dry run answers the USDC out, the fee and the spot price before and after, from the coins contract's own quote. ${SIGNING.account} Own key: ft_transfer_call of the coins to the coins factory with a sell message.`,
      inputSchema: { trend: identifier.describe("trend identifier"), coins: decimal(COIN_DECIMALS, "a coin amount").describe("coins to sell (18 decimals), for example \"1000\""), slippageBps: slippage(200, "how far below the quoted USDC the sale may fill"), confirm },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    run(async (a: CoinSellArgs) =>
      execute("sell_coin", a, async (s) => {
        const amount = toRaw(a.coins, COIN_DECIMALS);
        const curve = await curveOf(a.trend);
        const [q, spotNow, held] = await Promise.all([
          view<CurveQuote | null>(c.coins, "quote_sell", { trend: a.trend, coins_in: amount.toString() }),
          curve.stage === "creating" ? Promise.resolve("0") : view<string>(c.coins, "spot_price", { trend: a.trend }),
          view<string | null>(curve.coin, "ft_balance_of", { account_id: s.account }).then((b) => BigInt(b ?? "0")),
        ]);
        const minOut = q ? minimumOut(BigInt(q.out), a.slippageBps) : 0n;
        const blocker =
          s.kind === "session"
            ? OWNER_ONLY("A coin trade")
            : curve.stage !== "open" && curve.stage !== "ready"
              ? `the curve is ${curve.stage}: coins sell back to the curve only before it graduates${curve.pool_id !== null ? ` (it trades on Rhea pool ${curve.pool_id} now)` : ""}`
              : held < amount
                ? `the account holds ${coins(held)} coins, less than ${coins(amount)}`
                : !q
                  ? "the curve will not quote this amount"
                  : null;
        return {
          spend: 0n,
          quote: { trend: a.trend, coin: curve.coin, stage: curve.stage, coinsIn: coins(amount), usdcOut: q ? usdc(q.out) : null, feeUsdc: q ? usdc(q.fee) : null, minUsdcOut: usdc(minOut), spotUsdc: spot(spotNow), spotAfterUsdc: q ? spot(q.spot_after) : null, slippageBps: a.slippageBps },
          calls: s.kind === "session" ? [] : [...(await storageFor(s.account, [], true)), C.coins.sell(curve.coin, amount.toString(), minOut.toString())],
          blocker,
          notes: [],
          result: (events) => {
            const e = events.find((x) => x.standard === "tredio-coins" && x.event === "trade" && dataOf(x).is_buy === false);
            if (!e) return null;
            const x = dataOf(e) as { usdc: string; coins: string; fee: string; spot: string };
            return { coin: curve.coin, coinsSold: coins(x.coins), usdcReceived: usdc(x.usdc), feeUsdc: usdc(x.fee), spotAfterUsdc: spot(x.spot) };
          },
        };
      }),
    ),
  );
}
