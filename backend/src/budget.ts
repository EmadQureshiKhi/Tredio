import { createHash } from "node:crypto";
import type { Sql } from "./db";

/**
 * Credit budgets for API keys. Plans come with small allowances (Elfa: monthly credits; Nansen: 10
 * credits a day), so every call reserves its credits first, on the key with the most left, and
 * usage is persisted so restarts never overspend. A monthly allowance is paced: a key
 * may spend today only its fair share of what is left this month, so the budget lasts to the reset.
 */

export interface Limits {
  /** Credits per key per UTC day. */
  daily: number;
  /** Credits per key per calendar month (UTC); paced across the days left. */
  monthly?: number;
  /**
   * When set, a key's daily allowance opens hour by hour: by the end of UTC hour h it may have spent
   * its share of (h + 1) / 24 of the day, plus this many credits of slack.
   */
  hourlySlack?: number;
}

export interface Lease {
  key: string;
  keyId: string;
}

export interface KeyUsage {
  keyId: string;
  today: number;
  month: number;
  /** Credits this key may still spend today. */
  left: number;
}

/** Why a key sits out: out of quota, rejected as invalid, throttled, or its network route failed. */
export type BenchReason = "quota" | "rejected" | "throttled" | "route-down" | "route-auth";

/** A short, stable fingerprint, so usage rows never hold a key. */
export const keyId = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 12);

const DAY_MS = 86_400_000;

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function monthStart(d: Date): string {
  return `${d.toISOString().slice(0, 7)}-01`;
}

/** Days left in the month, today included. */
function daysLeftInMonth(d: Date): number {
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) / DAY_MS));
}

/** How long a key the provider rejected as invalid sits out before it is tried again. */
export const REJECTED_KEY_MS = 6 * 60 * 60 * 1000;

/** How long a key the provider throttled (a plain 429) rests while the other keys take its calls. */
export const THROTTLED_KEY_MS = 60_000;

export class KeyRing {
  private readonly ids: string[];
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * Keys the provider refused, benched until a time: quota until the next UTC day, a rejected key
   * for REJECTED_KEY_MS, a throttled one for THROTTLED_KEY_MS.
   */
  private readonly spentUntil = new Map<string, number>();
  /** Why each benched key sits out, for health. */
  private readonly benchReason = new Map<string, BenchReason>();

  constructor(
    private readonly sql: Sql,
    readonly provider: string,
    private readonly keys: readonly string[],
    private readonly limits: Limits,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.ids = keys.map(keyId);
  }

  get size(): number {
    return this.keys.length;
  }

  /** The keys' fingerprints, in key order. */
  get keyIds(): readonly string[] {
    return this.ids;
  }

  /**
   * Reserves `cost` credits on the key with the most left today, or returns null when none can pay.
   * `eligible` narrows the keys, for calls only some keys may make.
   */
  take(cost = 1, eligible: (keyId: string) => boolean = () => true, choose: (ready: KeyUsage[]) => KeyUsage = (ready) => ready[0]!): Promise<Lease | null> {
    return this.serial(async () => {
      const now = this.now();
      const usage = await this.usage();
      const ready = usage
        .filter((u) => u.left >= cost && (this.spentUntil.get(u.keyId) ?? 0) <= now.getTime() && eligible(u.keyId))
        .sort((a, b) => b.left - a.left || a.keyId.localeCompare(b.keyId));
      if (ready.length === 0) return null;
      const pick = choose(ready);
      await this.add(pick.keyId, utcDay(now), cost);
      const i = this.ids.indexOf(pick.keyId);
      return { key: this.keys[i]!, keyId: pick.keyId };
    });
  }

  /** Benches a key until the next UTC day after the provider refused it for quota. */
  exhaust(id: string): void {
    const now = this.now();
    this.spentUntil.set(id, Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY_MS);
    this.benchReason.set(id, "quota");
  }

  /**
   * Benches a key the provider rejected as invalid or expired, so calls move on to the other keys.
   * It is tried again after REJECTED_KEY_MS in case the rejection was temporary.
   */
  reject(id: string): void {
    this.spentUntil.set(id, this.now().getTime() + REJECTED_KEY_MS);
    this.benchReason.set(id, "rejected");
  }

  /**
   * Rests a key the provider throttled for THROTTLED_KEY_MS, so the next call moves to another key.
   * `reason` says why for health (a failed network route rests the key the same way).
   */
  rest(id: string, ms = THROTTLED_KEY_MS, reason: BenchReason = "throttled"): void {
    const until = this.now().getTime() + ms;
    if (until >= (this.spentUntil.get(id) ?? 0)) this.benchReason.set(id, reason);
    this.spentUntil.set(id, Math.max(this.spentUntil.get(id) ?? 0, until));
  }

  /** Each key that sits out right now: until when, and why. */
  benches(): Array<{ keyId: string; until: number; reason: BenchReason }> {
    const now = this.now().getTime();
    return this.ids.flatMap((id) => {
      const until = this.spentUntil.get(id) ?? 0;
      return until > now ? [{ keyId: id, until, reason: this.benchReason.get(id) ?? "throttled" }] : [];
    });
  }

  /** Raises this month's recorded usage to what the provider reports, never lowers it. */
  syncMonth(id: string, used: number): Promise<void> {
    return this.serial(async () => {
      const u = (await this.usage()).find((x) => x.keyId === id);
      const delta = Math.floor(used) - (u?.month ?? 0);
      if (delta > 0) await this.add(id, utcDay(this.now()), delta);
    });
  }

  /** Per-key usage and what each key may still spend today (so far today, when the day opens hourly). */
  async usage(): Promise<KeyUsage[]> {
    return this.usageAt(true);
  }

  private async usageAt(hourly: boolean): Promise<KeyUsage[]> {
    const now = this.now();
    const today = utcDay(now);
    const rows = await this.sql<{ key_id: string; today: number; month: number }[]>`
      SELECT key_id,
             COALESCE(SUM(credits) FILTER (WHERE day = ${today}::date), 0)::int AS today,
             COALESCE(SUM(credits), 0)::int AS month
        FROM api_usage
       WHERE provider = ${this.provider} AND day >= ${monthStart(now)}::date
       GROUP BY key_id`;
    const days = daysLeftInMonth(now);
    return this.ids.map((id) => {
      const r = rows.find((x) => x.key_id === id);
      const todaySpent = r?.today ?? 0;
      const monthSpent = r?.month ?? 0;
      let allowance = this.limits.daily;
      if (this.limits.monthly !== undefined) {
        // Today's fair share of the credits left at the start of today.
        const leftAtDayStart = this.limits.monthly - (monthSpent - todaySpent);
        allowance = Math.min(allowance, Math.floor(leftAtDayStart / days));
      }
      if (hourly && this.limits.hourlySlack !== undefined) {
        const share = Math.ceil((allowance * (now.getUTCHours() + 1)) / 24) + this.limits.hourlySlack;
        allowance = Math.min(allowance, share);
      }
      return { keyId: id, today: todaySpent, month: monthSpent, left: Math.max(0, allowance - todaySpent) };
    });
  }

  /** How many keys sit out right now (rejected, out of quota, throttled, or resting after a failed route). */
  benched(): number {
    const now = this.now().getTime();
    return this.ids.filter((id) => (this.spentUntil.get(id) ?? 0) > now).length;
  }

  /** Credits all keys may still spend today. */
  async leftToday(): Promise<number> {
    const now = this.now().getTime();
    return (await this.usage()).filter((u) => (this.spentUntil.get(u.keyId) ?? 0) <= now).reduce((a, u) => a + u.left, 0);
  }

  /** Credits all keys may spend in a full day at the current pace. */
  async dailyAllowance(): Promise<number> {
    const usage = await this.usageAt(false);
    return usage.reduce((a, u) => a + u.left + u.today, 0);
  }

  private async add(id: string, day: string, credits: number): Promise<void> {
    await this.sql`
      INSERT INTO api_usage (provider, key_id, day, credits)
      VALUES (${this.provider}, ${id}, ${day}::date, ${credits})
      ON CONFLICT (provider, key_id, day) DO UPDATE SET credits = api_usage.credits + EXCLUDED.credits`;
  }

  /** Runs reservations one at a time, so two callers never spend the same credits. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
