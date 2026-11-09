/**
 * The spending policy the trade tools obey, and the ledger that remembers what they sent.
 *
 * The policy names the tools that may send (an allowlist), a USDC cap per call for each tool that
 * spends, and one USDC cap per UTC day across all of them. Without a policy nothing may send.
 * Every confirmed trade is checked and reserved in the ledger under a lock before it goes out, so
 * parallel calls (or two servers sharing the file) cannot together pass the daily cap, and the
 * ledger is a JSON file, so a restart keeps the day's spend.
 */
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fromRaw, toRaw, USDC_DECIMALS } from "@tredio/contracts";
import { z } from "zod";

/** Tools that move USDC out of the account; each needs a per-call cap in the policy. */
export const SPENDING_TOOLS = ["buy_outcome", "open_perp", "add_perp_margin", "buy_coin"] as const;
/** Tools that send without spending USDC (sales, closes, calls); the policy still has to name them. */
export const OTHER_TRADE_TOOLS = ["sell_outcome", "close_perp", "sell_coin", "post_call"] as const;
export const TRADE_TOOLS = [...SPENDING_TOOLS, ...OTHER_TRADE_TOOLS] as const;
export type SpendingTool = (typeof SPENDING_TOOLS)[number];
export type TradeTool = (typeof TRADE_TOOLS)[number];

export const isSpendingTool = (t: TradeTool): t is SpendingTool => (SPENDING_TOOLS as readonly string[]).includes(t);

export interface Policy {
  /** USDC (raw) all spending tools together may send per UTC day. */
  dailyCap: bigint;
  /** The tools that may send; a spending tool carries its cap per call (raw USDC). */
  tools: Partial<Record<TradeTool, { maxPerCall: bigint | null }>>;
  /** The ledger file the policy file names, if any. */
  ledgerFile: string | null;
}

/** No tool may send. */
export const NO_POLICY: Policy = { dailyCap: 0n, tools: {}, ledgerFile: null };

const usdc = (raw: bigint) => fromRaw(raw, USDC_DECIMALS);
const amount = z.union([z.string().trim(), z.number().nonnegative()]).transform((v, ctx) => {
  const s = typeof v === "number" ? String(v) : v;
  if (!/^\d+(\.\d{1,6})?$/.test(s)) {
    ctx.addIssue({ code: "custom", message: `${JSON.stringify(v)} is not a USDC amount (a decimal with at most 6 places, such as "10" or 2.5)` });
    return z.NEVER;
  }
  return toRaw(s, USDC_DECIMALS);
});
const policySchema = z
  .object({
    dailyCapUsdc: amount,
    tools: z.partialRecord(z.enum(TRADE_TOOLS), z.union([z.literal(true), z.object({ maxUsdc: amount.optional() }).strict()])),
    ledgerFile: z.string().min(1).optional(),
  })
  .strict();

/** Reads a policy (the parsed JSON of a policy file); throws with every problem spelled out. */
export function parsePolicy(json: unknown): Policy {
  const r = policySchema.safeParse(json);
  if (!r.success) throw new Error(`the trading policy is invalid: ${r.error.issues.map((i) => `${i.path.join(".") || "policy"}: ${i.message}`).join("; ")}`);
  const tools: Policy["tools"] = {};
  const problems: string[] = [];
  for (const [name, entry] of Object.entries(r.data.tools) as Array<[TradeTool, true | { maxUsdc?: bigint }]>) {
    const max = entry === true ? undefined : entry.maxUsdc;
    if (isSpendingTool(name)) {
      if (max === undefined || max === 0n) problems.push(`tools.${name} spends USDC, so it needs a "maxUsdc" above 0`);
      tools[name] = { maxPerCall: max ?? 0n };
    } else {
      if (max !== undefined) problems.push(`tools.${name} spends no USDC; drop its "maxUsdc" (use true or {})`);
      tools[name] = { maxPerCall: null };
    }
  }
  if (problems.length) throw new Error(`the trading policy is invalid: ${problems.join("; ")}`);
  return { dailyCap: r.data.dailyCapUsdc, tools, ledgerFile: r.data.ledgerFile ?? null };
}

/** The policy as JSON, amounts as decimal USDC. */
export function policyJson(p: Policy) {
  return {
    dailyCapUsdc: usdc(p.dailyCap),
    tools: Object.fromEntries(TRADE_TOOLS.map((t) => [t, p.tools[t] ? { allowed: true, maxUsdcPerCall: p.tools[t]!.maxPerCall === null ? null : usdc(p.tools[t]!.maxPerCall!) } : { allowed: false }])),
  };
}

/** What happened to a ledgered trade: `pending` until its transaction answers. */
export type EntryStatus = "pending" | "sent" | "failed" | "refused" | "unknown";

export interface LedgerEntry {
  id: string;
  /** Unix milliseconds when it was reserved. */
  at: number;
  /** The UTC day (unix days) it counts in. */
  day: number;
  tool: TradeTool;
  /** The account that sent it (or the caller identity, for calls). */
  account: string;
  signer: "session" | "account" | "caller";
  /** USDC it sends out, as a decimal; "0" for tools that spend nothing. */
  usdc: string;
  args: Record<string, unknown>;
  status: EntryStatus;
  /** The trade's transaction (or the call's id), once known. */
  hash: string | null;
  /** Earlier transactions of the same trade (storage registrations). */
  setupHashes?: string[];
  error?: string;
}

/**
 * Statuses whose USDC counts against the day: sent, still pending, or sent with no answer. A
 * transaction the chain ran and failed, or a refusal the contract logged, moved nothing (the
 * token call returned the USDC), so it does not count.
 */
const COUNTS: ReadonlySet<EntryStatus> = new Set(["pending", "sent", "unknown"]);
const KEEP_DAYS = 30;
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 10_000;

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** A refusal by the policy (as opposed to a failure of the chain). */
export class PolicyRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyRefusal";
  }
}

export interface PolicyCheck {
  allowed: boolean;
  /** Why not, when not allowed. */
  reason: string | null;
  maxUsdcPerCall: string | null;
  dailyCapUsdc: string;
  spentTodayUsdc: string;
  leftTodayUsdc: string;
}

/** The ledger file: reads, and changes under an exclusive lock file so readers never see half a write. */
export class SpendLedger {
  constructor(
    readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  today(): number {
    return Math.floor(this.now() / 86_400_000);
  }

  entries(): LedgerEntry[] {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    // A ledger that does not parse holds the day's spend we can no longer read: refuse rather than start over.
    let parsed: { entries?: unknown };
    try {
      parsed = JSON.parse(text) as { entries?: unknown };
    } catch {
      throw new Error(`the ledger ${this.file} is not valid JSON; fix or move it (it records what the trade tools spent)`);
    }
    if (!Array.isArray(parsed.entries)) throw new Error(`the ledger ${this.file} has no entries list; fix or move it`);
    return parsed.entries as LedgerEntry[];
  }

  /** USDC (raw) counted against `day`. */
  spentOn(entries: readonly LedgerEntry[], day: number): bigint {
    return entries.filter((e) => e.day === day && COUNTS.has(e.status)).reduce((a, e) => a + toRaw(e.usdc, USDC_DECIMALS), 0n);
  }

  /** Runs `change` on the entries under the lock and writes what it returns. */
  update<T>(change: (entries: LedgerEntry[]) => T): T {
    mkdirSync(dirname(this.file), { recursive: true });
    const lock = `${this.file}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    let fd: number | null = null;
    while (fd === null) {
      try {
        fd = openSync(lock, "wx");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        // A lock left by a process that died mid-write.
        try {
          if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
        } catch {
          // Gone already.
        }
        if (Date.now() > deadline) throw new Error(`the ledger ${this.file} is locked (${lock}); another tredio-mcp is writing it`);
        sleepSync(15);
      }
    }
    try {
      const entries = this.entries();
      const out = change(entries);
      const keepFrom = this.today() - KEEP_DAYS;
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ version: 1, entries: entries.filter((e) => e.day >= keepFrom) }, null, 2)}\n`);
      renameSync(tmp, this.file);
      return out;
    } finally {
      closeSync(fd);
      unlinkSync(lock);
    }
  }
}

/** The policy and the ledger together: checks, reservations and the day's summary. */
export class SpendGuard {
  constructor(
    readonly policy: Policy,
    readonly ledger: SpendLedger,
  ) {}

  /** Whether `tool` may send `spend` (raw USDC) now, given what the day has spent. */
  check(tool: TradeTool, spend: bigint, spentToday = this.ledger.spentOn(this.ledger.entries(), this.ledger.today())): PolicyCheck {
    const p = this.policy;
    const rule = p.tools[tool];
    const left = p.dailyCap > spentToday ? p.dailyCap - spentToday : 0n;
    const base = { maxUsdcPerCall: rule?.maxPerCall == null ? null : usdc(rule.maxPerCall), dailyCapUsdc: usdc(p.dailyCap), spentTodayUsdc: usdc(spentToday), leftTodayUsdc: usdc(left) };
    const refuse = (reason: string): PolicyCheck => ({ allowed: false, reason, ...base });
    if (!rule) return refuse(`the trading policy does not allow ${tool}; the user enables it by naming it under "tools" in the policy`);
    if (isSpendingTool(tool)) {
      if (spend > rule.maxPerCall!) return refuse(`${usdc(spend)} USDC is above ${tool}'s cap of ${usdc(rule.maxPerCall!)} USDC per call`);
      if (spentToday + spend > p.dailyCap) return refuse(`${usdc(spend)} USDC would bring today's spend (UTC) to ${usdc(spentToday + spend)} USDC, above the daily cap of ${usdc(p.dailyCap)} USDC; ${usdc(left)} USDC is left today`);
    }
    return { allowed: true, reason: null, ...base };
  }

  /** Checks again under the lock and records the trade as pending; throws a PolicyRefusal when the policy says no. */
  reserve(r: { tool: TradeTool; account: string; signer: LedgerEntry["signer"]; spend: bigint; args: Record<string, unknown> }): LedgerEntry {
    return this.ledger.update((entries) => {
      const day = this.ledger.today();
      const c = this.check(r.tool, r.spend, this.ledger.spentOn(entries, day));
      if (!c.allowed) throw new PolicyRefusal(c.reason!);
      const entry: LedgerEntry = { id: randomUUID(), at: Date.now(), day, tool: r.tool, account: r.account, signer: r.signer, usdc: usdc(r.spend), args: r.args, status: "pending", hash: null };
      entries.push(entry);
      return entry;
    });
  }

  /** Records how a reserved trade ended. */
  settle(id: string, end: { status: Exclude<EntryStatus, "pending">; hash?: string | null; setupHashes?: string[]; error?: string }): void {
    this.ledger.update((entries) => {
      const e = entries.find((x) => x.id === id);
      if (!e) return;
      e.status = end.status;
      if (end.hash !== undefined) e.hash = end.hash;
      if (end.setupHashes?.length) e.setupHashes = end.setupHashes;
      if (end.error) e.error = end.error.slice(0, 500);
    });
  }

  /** Today's spend and trades, for `get_trading_policy`. */
  summary() {
    const entries = this.ledger.entries();
    const day = this.ledger.today();
    const spent = this.ledger.spentOn(entries, day);
    return {
      day: new Date(day * 86_400_000).toISOString().slice(0, 10),
      spentUsdc: usdc(spent),
      leftUsdc: usdc(this.policy.dailyCap > spent ? this.policy.dailyCap - spent : 0n),
      trades: entries.filter((e) => e.day === day),
    };
  }
}
