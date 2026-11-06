/**
 * The transaction feed (`INDEXER_SOURCE=txs`, the default): Tredio's events from FastNEAR's
 * transactions API, which needs no key and lists only the transactions that touched an account,
 * so one cycle costs a dozen requests instead of one per block.
 *
 * A cycle:
 * 1. Reads the API's committed head and takes the block `safetyBlocks` below it as the end of the
 *    window (or the start plus `backfillWindow` while catching up).
 * 2. Lists, oldest first, every transaction included in the window (and `lookbackBlocks` before
 *    it) that touched a core account: the deployment's contracts and the relayers. Every Tredio
 *    action touches one of them except a few that only touch a user account or a trend coin, so
 *    those (slow accounts, found in the tables and in receipts) are listed too, a few per cycle in
 *    turn, each from where it was last listed.
 * 3. Fetches the new transactions (20 a request) and every one still running, and turns each
 *    successful receipt of a Tredio executor into the same events the block feed stores.
 * 4. Commits the events of the window block by block, in block order, and moves the cursor to
 *    the window's end. Every transaction included up to there that touched a core account has
 *    been seen, so a later one cannot land below the cursor. Events above it wait in memory for
 *    a later window; a transaction still running is fetched again each cycle until it ends.
 *
 * Events found below the cursor (only through slow accounts: user-to-user coin transfers, and
 * user account actions that touch no contract) are committed as found. Their tables (coin
 * balances, session actions, signatures, sessions, account flags) do not depend on the order of
 * other accounts' events. A restart lists again from `lookbackBlocks` below the cursor, and the
 * events table makes every repeat a no-op.
 */
import type { Sql } from "./db";
import type { Tracker } from "./deployments";
import { type StoredEvent, txComplete, txEvents } from "./extract";
import { sleep, StoppedError } from "./http";
import type { IngestStatus } from "./ingest";
import type { Log } from "./log";
import { commitRetrying, readCursor, writeCursor } from "./store";
import type { ApiBlock, TxApi, TxRecord } from "./txapi";

export interface TxIngestOptions {
  sql: Sql;
  api: TxApi;
  tracker: Tracker;
  network: string;
  startBlock: number;
  /** Listed every cycle: the deployment's contracts and the relayer accounts. */
  coreAccounts: string[];
  /** Blocks kept between the API's head and the window's end. */
  safetyBlocks: number;
  /** How far before the window each listing starts, for transactions whose first touch came late. */
  lookbackBlocks: number;
  /** Most blocks one window spans while catching up. */
  backfillWindow: number;
  /** Slow accounts listed per cycle. */
  slowPerCycle: number;
  /** Shortest time between cycles at the head. */
  pollMs: number;
  /** A transaction still running after this many blocks is given up (with a warning). */
  pendingMaxBlocks: number;
  log: Log;
  signal: AbortSignal;
}

const PROGRESS_LOG_MS = 15_000;
const BATCH = 20;

const key = (e: StoredEvent) => `${e.receipt_id}#${e.log_index}`;
const byOrder = (a: StoredEvent, b: StoredEvent) => a.block_height - b.block_height || a.idx - b.idx;

export class TxIngestor {
  readonly status: IngestStatus = { height: 0, head: 0, blockTime: null, eventsProcessed: 0, startedAt: new Date(), beat: Date.now() };
  /** Slow accounts and the height each one's next listing starts from. */
  private readonly slow = new Map<string, number>();
  private slowTurn = 0;
  /** Finished transactions seen in the lookback range, by hash, with their inclusion height. */
  private readonly done = new Map<string, number>();
  /** Running transactions, fetched again every cycle, with their inclusion height. */
  private readonly running = new Map<string, number>();
  /** Events above the cursor from finished transactions, until their window comes. */
  private readonly held = new Map<string, StoredEvent>();
  private readonly core: Set<string>;
  private lastLog = 0;
  private lastLogHeight = 0;

  constructor(private readonly o: TxIngestOptions) {
    this.core = new Set(o.coreAccounts);
  }

  beat() {
    this.status.beat = Date.now();
  }

  async run(): Promise<void> {
    const { o, status } = this;
    const saved = await readCursor(o.sql, o.network);
    status.height = saved?.height ?? o.startBlock - 1;
    status.blockTime = saved?.blockTime ?? null;
    this.lastLogHeight = status.height;
    this.lastLog = Date.now();
    try {
      await this.loadSlowAccounts();
      o.log.info("tx feed start", { from: status.height + 1, resumed: Boolean(saved), core: this.core.size, slow: this.slow.size });
      while (!o.signal.aborted) {
        this.beat();
        const started = Date.now();
        const caughtUp = await this.cycle();
        this.progress();
        if (caughtUp) await sleep(Math.max(0, o.pollMs - (Date.now() - started)), o.signal);
      }
    } catch (e) {
      if (!(e instanceof StoppedError)) throw e;
    }
  }

  /** Coins and user accounts already in the tables, listed from the lookback below the cursor. */
  private async loadSlowAccounts() {
    const rows = await this.o.sql<{ a: string }[]>`select coin as a from curves union select account from accounts`;
    for (const r of rows) this.addSlow(r.a, this.status.height + 1);
  }

  /** A slow account seen at `height`: its listings start a lookback before. */
  private addSlow(account: string, height: number) {
    if (this.core.has(account) || this.slow.has(account)) return;
    this.slow.set(account, Math.max(this.o.startBlock, height - this.o.lookbackBlocks));
  }

  /** One cycle; true when the window reached the API's head (time to wait). */
  private async cycle(): Promise<boolean> {
    const { o, status } = this;
    const recent = await o.api.blocks(o.safetyBlocks + 1);
    if (!recent.length) return true;
    status.head = recent[0]!.height;
    const S = status.height;
    let end: ApiBlock = recent[recent.length - 1]!;
    if (end.height - S > o.backfillWindow) {
      const [b] = await o.api.blocks(1, S + o.backfillWindow);
      if (b && b.height > S) end = b;
    }
    const caughtUp = end === recent[recent.length - 1];
    if (end.height <= S) return true;
    const E = end.height;
    const from = Math.max(o.startBlock, S + 1 - o.lookbackBlocks);

    // 2. Listings.
    const listed = new Map<string, number>();
    for (const account of this.core) await this.list(account, from, E, listed, Infinity);
    // One page per slow account: the next listing goes on from where a partial one stopped, or
    // starts a lookback below the window's end once one reached it.
    const slowNext: Array<[string, number]> = [];
    for (const account of this.slowAccountsThisCycle()) {
      const since = Math.min(this.slow.get(account)!, E);
      const reached = await this.list(account, since, E, listed, 1);
      slowNext.push([account, reached === E ? Math.max(o.startBlock, E + 1 - o.lookbackBlocks) : reached]);
    }

    // 3. Transactions: new ones and every one still running.
    const wanted = new Map<string, number>(this.running);
    for (const [hash, height] of listed) if (!this.done.has(hash)) wanted.set(hash, height);
    const fetched = await this.fetch([...wanted.keys()]);
    const events = new Map<string, StoredEvent>(this.held);
    const finished: Array<[string, number]> = [];
    const stillRunning: Array<[string, number]> = [];
    for (const [hash, height] of wanted) {
      const tx = fetched.get(hash);
      if (!tx) {
        // Listed but not served yet: try again next cycle.
        if (E - height > o.pendingMaxBlocks) o.log.warn("transaction never served, given up", { tx: hash, includedAt: height });
        else stillRunning.push([hash, height]);
        continue;
      }
      for (const e of txEvents(tx, o.tracker)) events.set(key(e), e);
      this.discover(tx);
      if (txComplete(tx)) finished.push([hash, height]);
      else if (E - height > o.pendingMaxBlocks) {
        o.log.warn("transaction still running, given up", { tx: hash, includedAt: height });
        finished.push([hash, height]);
      } else stillRunning.push([hash, height]);
    }

    // 4. Commit: late events as found, the window block by block, then the cursor.
    const all = [...events.values()].sort(byOrder);
    const late = all.filter((e) => e.block_height <= S);
    const inWindow = all.filter((e) => e.block_height > S && e.block_height <= E);
    const later = all.filter((e) => e.block_height > E);
    const commit = { ...o, beat: () => this.beat() };
    if (late.length) {
      const n = await commitRetrying(commit, null, late);
      if (n) o.log.info("events below the cursor applied", { events: n, cursor: S });
      status.eventsProcessed += n;
    }
    for (const block of groupByHeight(inWindow)) {
      status.eventsProcessed += await commitRetrying(commit, { height: block[0]!.block_height, blockTime: block[0]!.block_time }, block);
    }
    await writeCursor(o.sql, o.network, { height: E, blockTime: end.time });

    // The cycle is committed: update what is known.
    status.height = E;
    status.blockTime = end.time;
    this.held.clear();
    for (const e of later) this.held.set(key(e), e);
    this.running.clear();
    for (const [hash, height] of stillRunning) this.running.set(hash, height);
    for (const [hash, height] of finished) this.done.set(hash, height);
    for (const [account, next] of slowNext) this.slow.set(account, next);
    const keepFrom = E + 1 - o.lookbackBlocks;
    for (const [hash, height] of this.done) if (height < keepFrom) this.done.delete(hash);
    return caughtUp;
  }

  /**
   * Lists `account`'s transactions included from `from` to `to` into `out`, at most `pages`
   * pages. Returns `to` when the listing reached it, otherwise the height of the last listed
   * transaction, where the next listing starts (inclusive, so nothing at that height is skipped).
   */
  private async list(account: string, from: number, to: number, out: Map<string, number>, pages: number): Promise<number> {
    let resume: string | undefined;
    for (let page = 0; ; page++) {
      const r = await this.o.api.accountTxs(account, from, to, resume);
      for (const t of r.txs) out.set(t.hash, t.height);
      if (!r.resume || !r.txs.length) return to;
      if (page + 1 >= pages) return r.txs[r.txs.length - 1]!.height;
      resume = r.resume;
    }
  }

  private slowAccountsThisCycle(): string[] {
    const all = [...this.slow.keys()];
    if (!all.length) return [];
    const n = Math.min(this.o.slowPerCycle, all.length);
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(all[(this.slowTurn + i) % all.length]!);
    this.slowTurn = (this.slowTurn + n) % all.length;
    return out;
  }

  /** Trend coins and user accounts a transaction ran receipts on become slow accounts. */
  private discover(tx: TxRecord) {
    for (const r of tx.receipts) {
      const executor = r.execution_outcome.outcome.executor_id;
      const role = this.o.tracker.roleOf(executor);
      if (role === "coin" || role === "account") this.addSlow(executor, r.execution_outcome.block_height - 1);
    }
  }

  private async fetch(hashes: string[]): Promise<Map<string, TxRecord>> {
    const out = new Map<string, TxRecord>();
    for (let i = 0; i < hashes.length; i += BATCH) {
      for (const tx of await this.o.api.transactions(hashes.slice(i, i + BATCH))) out.set(tx.transaction.hash, tx);
    }
    return out;
  }

  private progress() {
    const { o, status } = this;
    if (Date.now() - this.lastLog < PROGRESS_LOG_MS) return;
    o.log.info("tx feed progress", {
      height: status.height,
      head: status.head,
      lagBlocks: Math.max(0, status.head - status.height),
      blocksPerSec: Math.round(((status.height - this.lastLogHeight) * 100_000) / (Date.now() - this.lastLog)) / 100,
      events: status.eventsProcessed,
      running: this.running.size,
      held: this.held.size,
      slow: this.slow.size,
      requests: o.api.requests,
    });
    this.lastLog = Date.now();
    this.lastLogHeight = status.height;
  }
}

function groupByHeight(events: StoredEvent[]): StoredEvent[][] {
  const out: StoredEvent[][] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (last && last[0]!.block_height === e.block_height) last.push(e);
    else out.push([e]);
  }
  return out;
}
