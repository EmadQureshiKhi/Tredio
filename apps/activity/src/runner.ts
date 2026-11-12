import { Sender, type Viewer } from "@tredio/chain";
import { AccountVersions, calls, type Deployment, type Depth, type Series, type SessionAction, sessionCallTgas } from "@tredio/contracts";
import { callNote, postBody } from "./content";
import type { Persona } from "./personas";
import { type Action, type Holding, isAwake, nextAction, type PerpPosition, type Rng, type State, type TrendView } from "./plan";
import { Caller } from "./social";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Log = (fields: Record<string, unknown>, msg: string) => void;
type Outcome = Awaited<ReturnType<Sender["sendOutcome"]>>;

/** What the funder adds to a persona's storage deposit with a contract at a time: about eight entries (the app's 0.02 NEAR). */
const STORAGE_TOP_UP = 20_000_000_000_000_000_000_000n;

export interface RunnerOptions {
  api: string;
  rpc: ConstructorParameters<typeof Sender>[0]["rpc"];
  gasKeyMin: bigint;
  gasKeyTopUp: bigint;
  rng?: Rng;
  fetchImpl?: Fetch;
  now?: () => number;
}

/** A contract's logged refusal (`*_refused`, `*_rejected`): the transaction succeeded, the action did not. */
export function refusalIn(o: Outcome): string | null {
  const logs = [...(o.transaction_outcome?.outcome?.logs ?? []), ...(o.receipts_outcome ?? []).flatMap((r) => r.outcome.logs ?? [])];
  for (const l of logs) {
    if (!l.startsWith("EVENT_JSON:")) continue;
    try {
      const e = JSON.parse(l.slice(11)) as { event?: string; data?: unknown };
      if (e.event && /(_refused|_rejected)$/.test(e.event)) {
        const d = (Array.isArray(e.data) ? e.data[0] : e.data) as { reason?: string } | undefined;
        return d?.reason ?? e.event;
      }
    } catch {
      // Not an event.
    }
  }
  return null;
}

export interface Done {
  at: number;
  persona: string;
  kind: Action["kind"];
  detail: string;
  ref: string | null;
}

/**
 * Takes one turn for one awake persona: reads what it holds and sees, picks an action with its
 * style (plan.ts) and carries it out with its own session key or caller key.
 */
export class Runner {
  private readonly C;
  private readonly versions: AccountVersions;
  private readonly senders = new Map<string, Sender>();
  private readonly callers = new Map<string, Caller>();
  private readonly rng: Rng;
  private readonly fetchImpl: Fetch;
  private readonly now: () => number;
  private seriesCache: { at: number; byTrend: Map<string, number | null> } | null = null;
  private windows: number[] | null = null;
  /** Calls each persona made on a UTC day, kept here (the API caps them too). */
  private calls = new Map<string, { day: string; trends: string[] }>();
  readonly recent: Done[] = [];
  readonly counts: Record<string, number> = {};
  failures = 0;
  lastError: string | null = null;
  lastActionAt: number | null = null;

  constructor(
    private readonly personas: readonly Persona[],
    private readonly viewer: Viewer,
    private readonly funder: Sender,
    private readonly d: Deployment,
    private readonly o: RunnerOptions,
    private readonly log: Log = () => {},
  ) {
    this.C = calls(d);
    this.versions = new AccountVersions((a) => viewer.view<number>(a, "version"));
    this.rng = o.rng ?? Math.random;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.now = o.now ?? Date.now;
  }

  private nowSec = () => Math.floor(this.now() / 1000);

  private async api<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.o.api}${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
    return (await res.json()) as T;
  }

  /** Live trends, each with its newest series that is on the book and not about to expire. */
  private async trends(): Promise<TrendView[]> {
    const { trends } = await this.api<{ trends: Array<{ identifier: string; displayName: string; status: string; index: string | number; change24h: string | number | null }> }>("/v1/trends");
    const live = trends.filter((t) => t.status === "active");
    if (!this.seriesCache || this.nowSec() - this.seriesCache.at > 600) {
      this.windows ??= await this.viewer.view<number[]>(this.d.contracts.outcomes, "windows");
      const byTrend = new Map<string, number | null>();
      for (const t of live) byTrend.set(t.identifier, await this.openSeries(t.identifier).catch(() => null));
      this.seriesCache = { at: this.nowSec(), byTrend };
    }
    return live.map((t) => ({ identifier: t.identifier, displayName: t.displayName, index: Number(t.index), change24h: Number(t.change24h ?? 0), series: this.seriesCache!.byTrend.get(t.identifier) ?? null }));
  }

  private async openSeries(trend: string): Promise<number | null> {
    for (const w of this.windows ?? []) {
      const s = await this.viewer.view<Series | null>(this.d.contracts.outcomes, "latest_series", { trend, window: w });
      if (!s || s.expiry < this.nowSec() + 1_800) continue;
      if ((await this.viewer.view<unknown>(this.d.contracts.book, "get_market", { series: s.id, side: "up" })) !== null) return s.id;
    }
    return null;
  }

  private async state(p: Persona, trends: TrendView[]): Promise<State> {
    const [usdc, holdings, positions] = await Promise.all([
      this.viewer.view<string>(this.d.contracts.usdc, "ft_balance_of", { account_id: p.account }).then(BigInt),
      this.api<{ holdings: Array<{ series: number; trend: string; outcome: string; upBalance: string; downBalance: string }> }>(`/v1/accounts/${p.account}/outcomes`)
        .then((r) => r.holdings.map((h): Holding => ({ series: h.series, trend: h.trend, outcome: h.outcome, up: BigInt(h.upBalance), down: BigInt(h.downBalance) })))
        .catch(() => [] as Holding[]),
      this.viewer
        .view<Array<{ id: number; trend: string; is_long: boolean; opened_at: number }>>(this.d.contracts.perps, "positions_of", { account_id: p.account })
        .then((xs) => xs.map((x): PerpPosition => ({ id: x.id, trend: x.trend, isLong: x.is_long, openedAt: x.opened_at }))),
    ]);
    // Another persona's open call, in a random live trend's thread, to answer.
    let callToAnswer: State["callToAnswer"] = null;
    const t = trends[Math.floor(this.rng() * trends.length)];
    if (t) {
      const thread = await this.api<{ calls: Array<{ id: number; caller: string; handle: string | null; direction: "up" | "down"; outcome: string }> }>(`/v1/trends/${encodeURIComponent(t.identifier)}/thread`).catch(() => ({ calls: [] }));
      const theirs = thread.calls.filter((c) => c.caller !== p.identity && c.outcome === "open" && c.handle);
      const c = theirs[Math.floor(this.rng() * theirs.length)];
      if (c) callToAnswer = { id: Number(c.id), identifier: t.identifier, handle: c.handle!, direction: c.direction };
    }
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const made = this.calls.get(p.handle);
    const called = made?.day === day ? made.trends : [];
    return { nowSec: this.nowSec(), usdc, trends, holdings, positions, callsToday: called.length, calledToday: called, callToAnswer };
  }

  private sender(p: Persona): Sender {
    let s = this.senders.get(p.handle);
    if (!s) {
      s = new Sender({ network: "testnet", accountId: p.account, privateKey: p.sessionSecretKey, gasKeyLanes: 4, rpc: this.o.rpc });
      this.senders.set(p.handle, s);
    }
    return s;
  }

  private caller(p: Persona): Caller {
    let c = this.callers.get(p.handle);
    if (!c) {
      c = new Caller(p.identitySecret, this.o.api, this.fetchImpl, this.nowSec);
      this.callers.set(p.handle, c);
    }
    return c;
  }

  /** One session call from the persona's gas key, which the funder tops up first when it runs low. */
  private async session(p: Persona, action: SessionAction): Promise<string> {
    const gas = await this.viewer.gasKey(p.account, p.sessionPublicKey);
    if (!gas || gas.balance < this.o.gasKeyMin) {
      await this.funder.fundGasKey(p.account, p.sessionPublicKey, this.o.gasKeyTopUp);
      this.log({ persona: p.handle, topUp: Number(this.o.gasKeyTopUp) / 1e24 }, "gas key topped up");
    }
    const tgas = sessionCallTgas(await this.versions.of(p.account));
    const send = async () => {
      const o = await this.sender(p).sendOutcome(this.C.account.sessionCall(p.account, action, tgas));
      const refused = refusalIn(o);
      const hash = o.transaction?.hash ?? "";
      if (refused) throw new Error(`refused: ${refused} (${hash})`);
      return hash;
    };
    try {
      return await send();
    } catch (e) {
      // Each position or balance a contract keeps for the account needs its storage deposit, which the
      // app tops up before such trades; the funder does it here, then the trade goes again once.
      if (!(e instanceof Error) || !/needs a larger storage deposit|not registered for storage/.test(e.message)) throw e;
      const contracts = typeof action === "object" && ("perp_open" in action || "perp_close" in action) ? [this.d.contracts.perps] : [this.d.contracts.outcomes, this.d.contracts.book];
      for (const contract of contracts) {
        await this.funder.send({ receiverId: contract, methodName: "storage_deposit", args: { account_id: p.account, registration_only: false }, deposit: STORAGE_TOP_UP.toString(), gas: (30n * 10n ** 12n).toString() });
      }
      this.log({ persona: p.handle, contracts }, "storage deposit topped up");
      return send();
    }
  }

  /** Whether the book has anything to fill a buy (asks) or a sell (bids) of that side right now. */
  private async fillable(series: number, side: "up" | "down", buy: boolean): Promise<boolean> {
    const d = await this.viewer.view<Depth | null>(this.d.contracts.book, "depth", { series, side, levels: 1 }).catch(() => null);
    return (buy ? d?.asks : d?.bids)?.length ? true : false;
  }

  private balanceOf = (account: string, series: number, side: "up" | "down") =>
    this.viewer.view<string>(this.d.contracts.outcomes, "mt_balance_of", { account_id: account, token_id: `${series}:${side}` }).then(BigInt);

  private async act(p: Persona, a: Action): Promise<{ detail: string; ref: string | null }> {
    const usd = (x: bigint) => (Number(x) / 1e6).toFixed(2);
    switch (a.kind) {
      case "faucet":
        return { detail: "drew test USDC", ref: await this.session(p, "faucet") };
      case "redeem": {
        const [up, down] = await Promise.all([this.balanceOf(p.account, a.series, "up"), this.balanceOf(p.account, a.series, "down")]);
        if (up === 0n && down === 0n) return { detail: `series ${a.series} already redeemed`, ref: null };
        return { detail: `redeemed series ${a.series}`, ref: await this.session(p, { redeem_winnings: { series: a.series, up: up.toString(), down: down.toString() } }) };
      }
      case "buy": {
        // Nobody offers that side: take the other one if it is offered, as a trader at the screen would.
        const other = a.side === "up" ? "down" : "up";
        const side = (await this.fillable(a.series, a.side, true)) ? a.side : (await this.fillable(a.series, other, true)) ? other : null;
        if (!side) return { detail: `no offers on ${a.trend.identifier}`, ref: null };
        return {
          detail: `bought ${side.toUpperCase()} on ${a.trend.identifier} for ${usd(a.amount)} USDC`,
          ref: await this.session(p, { swap: { series: a.series, side, buy: true, amount: a.amount.toString(), min_out: "1" } }),
        };
      }
      case "sell": {
        const held = await this.balanceOf(p.account, a.holding.series, a.side);
        const amount = a.amount < held ? a.amount : held;
        if (amount === 0n) return { detail: `nothing left to sell in series ${a.holding.series}`, ref: null };
        if (!(await this.fillable(a.holding.series, a.side, false))) return { detail: `no bids for ${a.holding.trend}`, ref: null };
        return {
          detail: `sold ${usd(amount)} ${a.side.toUpperCase()} of ${a.holding.trend}`,
          ref: await this.session(p, { swap: { series: a.holding.series, side: a.side, buy: false, amount: amount.toString(), min_out: "1" } }),
        };
      }
      case "perpOpen":
        return {
          detail: `${a.isLong ? "long" : "short"} ${a.trend.identifier}, ${usd(a.margin)} USDC at ${a.leverageBps / 10_000}x`,
          ref: await this.session(p, { perp_open: { trend: a.trend.identifier, is_long: a.isLong, margin: a.margin.toString(), leverage_bps: a.leverageBps, acceptable_index: a.acceptableIndex } }),
        };
      case "perpClose":
        return { detail: `closed perp ${a.position.id} on ${a.position.trend}`, ref: await this.session(p, { perp_close: { id: a.position.id, acceptable_index: a.acceptableIndex } }) };
      case "call": {
        const note = callNote(a.trend, a.direction, a.horizonSec, this.rng);
        const r = await this.caller(p).call({ identifier: a.trend.identifier, direction: a.direction, horizonSec: a.horizonSec, note });
        const day = new Date(this.now()).toISOString().slice(0, 10);
        const made = this.calls.get(p.handle);
        this.calls.set(p.handle, { day, trends: [...(made?.day === day ? made.trends : []), a.trend.identifier] });
        return { detail: `called ${a.direction} on ${a.trend.identifier} (${a.horizonSec / 86_400} d)`, ref: `call ${r.call.id}` };
      }
      case "post": {
        const reply = a.reply ? { handle: a.reply.handle, agree: this.rng() < 0.6 } : undefined;
        const r = await this.caller(p).post({ identifier: a.trend.identifier, body: postBody(a.trend, this.rng, reply), callId: a.reply?.id ?? null });
        return { detail: a.reply ? `answered @${a.reply.handle} on ${a.trend.identifier}` : `posted on ${a.trend.identifier}`, ref: `post ${r.post.id}` };
      }
    }
  }

  /** One turn: a random awake persona acts once. Never throws; failures are counted and logged. */
  async turn(): Promise<Done | null> {
    const awake = this.personas.filter((p) => isAwake(p, this.nowSec()));
    const p = awake[Math.floor(this.rng() * awake.length)];
    if (!p) return null;
    let action: Action | null = null;
    try {
      const trends = await this.trends();
      action = nextAction(p, await this.state(p, trends), this.rng);
      if (!action) return null;
      const r = await this.act(p, action);
      if (r.ref === null) {
        this.log({ persona: p.handle, kind: action.kind, detail: r.detail }, "skipped");
        return null;
      }
      const done: Done = { at: this.nowSec(), persona: p.handle, kind: action.kind, detail: r.detail, ref: r.ref };
      this.counts[action.kind] = (this.counts[action.kind] ?? 0) + 1;
      this.lastActionAt = done.at;
      this.recent.unshift(done);
      this.recent.length = Math.min(this.recent.length, 30);
      this.log({ persona: p.handle, kind: action.kind, detail: r.detail, ref: r.ref }, "acted");
      return done;
    } catch (e) {
      this.failures += 1;
      this.lastError = `${p.handle} ${action?.kind ?? "reading"}: ${e instanceof Error ? e.message.slice(0, 240) : String(e)}`;
      this.log({ persona: p.handle, kind: action?.kind ?? null, err: this.lastError }, "action failed");
      return null;
    }
  }
}
