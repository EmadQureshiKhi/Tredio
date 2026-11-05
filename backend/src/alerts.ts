import { changePct, valueAt } from "@tredio/autopilot";
import type { ChainTrend } from "./chain";
import type { Sql } from "./db";
import type { IndexPoint } from "./history";
import { baseOf } from "./identifiers";
import type { Push } from "./notify/push";

/**
 * Attention alerts: an account hears, by push, when a topic's attention index rises or drops by a
 * percentage within a window, or crosses a level. An alert follows the topic (its base identifier)
 * across listings and checks the newest live one; a topic that is not live waits. Rises and drops
 * fire at most once per window; a crossing fires once and re-arms when the index is back on the
 * near side of the level.
 */

export type AlertKind = "rise" | "drop" | "above" | "below";

export interface Alert {
  id: number;
  account: string;
  base: string;
  kind: AlertKind;
  changePct: number | null;
  windowMin: number | null;
  level: number | null;
  armed: boolean;
  createdAt: Date;
  lastFiredAt: Date | null;
  firedCount: number;
}

interface AlertRow {
  id: string;
  account: string;
  base: string;
  kind: AlertKind;
  change_pct: number | null;
  window_min: number | null;
  level: number | null;
  armed: boolean;
  created_at: Date;
  last_fired_at: Date | null;
  fired_count: number;
}

const toAlert = (r: AlertRow): Alert => ({
  id: Number(r.id),
  account: r.account,
  base: r.base,
  kind: r.kind,
  changePct: r.change_pct,
  windowMin: r.window_min,
  level: r.level,
  armed: r.armed,
  createdAt: r.created_at,
  lastFiredAt: r.last_fired_at,
  firedCount: r.fired_count,
});

/** Active alerts one account may hold at once. */
export const MAX_ALERTS = 20;
/** A rise or drop never fires again sooner than this, whatever its window. */
const MIN_REPEAT_SEC = 30 * 60;

export interface AlertCheck {
  /** Push now. */
  fire: boolean;
  /** The crossing state to store (unchanged for rises and drops). */
  armed: boolean;
  /** The index now, and its change over the window (rises and drops). */
  value: number | null;
  change: number | null;
}

/** Whether an alert fires now, from the topic's index points (oldest first). Pure. */
export function checkAlert(a: Pick<Alert, "kind" | "changePct" | "windowMin" | "level" | "armed" | "lastFiredAt">, points: readonly IndexPoint[], nowSec: number): AlertCheck {
  const value = valueAt(points, nowSec);
  if (value === null) return { fire: false, armed: a.armed, value, change: null };
  if (a.kind === "above" || a.kind === "below") {
    const level = a.level ?? 0;
    const past = a.kind === "above" ? value >= level : value <= level;
    // Fires on the crossing, then waits until the index is back on the near side.
    return { fire: a.armed && past, armed: !past, value, change: null };
  }
  const windowSec = (a.windowMin ?? 60) * 60;
  const change = changePct(points, nowSec, windowSec);
  const target = a.changePct ?? 0;
  const hit = change !== null && (a.kind === "rise" ? change >= target : change <= -target);
  const lastSec = a.lastFiredAt ? Math.floor(a.lastFiredAt.getTime() / 1000) : null;
  const rested = lastSec === null || nowSec - lastSec >= Math.max(windowSec, MIN_REPEAT_SEC);
  return { fire: hit && rested, armed: a.armed, value, change };
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
const windowLabel = (min: number) => (min % 1440 === 0 ? plural(min / 1440, "day") : min % 60 === 0 ? plural(min / 60, "hour") : `${min} min`);

/** The push for a fired alert. */
export function alertPayload(a: Pick<Alert, "id" | "kind" | "changePct" | "windowMin" | "level">, name: string, identifier: string, check: AlertCheck) {
  const now = check.value !== null ? check.value.toFixed(1) : "-";
  const title =
    a.kind === "rise" || a.kind === "drop"
      ? `${name} attention ${a.kind === "rise" ? "up" : "down"} ${Math.abs(check.change ?? 0).toFixed(0)}% in ${windowLabel(a.windowMin ?? 60)}`
      : `${name} attention ${a.kind === "above" ? "rose above" : "fell below"} ${a.level}`;
  return { title, body: `The index is at ${now}. Your alert fired.`, url: `/t/${identifier}`, tag: `alert-${a.id}` };
}

export class Alerts {
  constructor(
    private readonly sql: Sql,
    private readonly push: Push,
    private readonly trends: () => Promise<ChainTrend[]>,
    private readonly points: (trendId: string, sinceSec: number) => Promise<IndexPoint[]>,
    private readonly names: (identifiers: string[]) => Promise<Map<string, string>>,
  ) {}

  async list(account: string): Promise<Alert[]> {
    const rows = await this.sql<AlertRow[]>`SELECT * FROM attention_alerts WHERE account = ${account.toLowerCase()} ORDER BY created_at DESC`;
    return rows.map(toAlert);
  }

  async count(account: string): Promise<number> {
    const rows = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM attention_alerts WHERE account = ${account.toLowerCase()}`;
    return rows[0]?.n ?? 0;
  }

  /** `armed` for a crossing is set from the index now, so an alert set past its level waits for the next crossing. */
  async create(account: string, a: { base: string; kind: AlertKind; changePct: number | null; windowMin: number | null; level: number | null; armed: boolean }): Promise<Alert> {
    const rows = await this.sql<AlertRow[]>`
      INSERT INTO attention_alerts (account, base, kind, change_pct, window_min, level, armed)
      VALUES (${account.toLowerCase()}, ${a.base}, ${a.kind}, ${a.changePct}, ${a.windowMin}, ${a.level}, ${a.armed})
      RETURNING *`;
    return toAlert(rows[0]!);
  }

  async remove(account: string, id: number): Promise<boolean> {
    const rows = await this.sql`DELETE FROM attention_alerts WHERE id = ${id} AND account = ${account.toLowerCase()} RETURNING id`;
    return rows.length > 0;
  }

  /** One pass: checks every alert against its topic's newest live listing and pushes the ones that fire. */
  async tick(nowSec = Math.floor(Date.now() / 1000)): Promise<{ checked: number; fired: number }> {
    const rows = (await this.sql<AlertRow[]>`SELECT * FROM attention_alerts ORDER BY id`).map(toAlert);
    if (rows.length === 0) return { checked: 0, fired: 0 };
    const live = new Map<string, ChainTrend>();
    for (const t of await this.trends()) {
      if (t.status !== "Active" && t.status !== "Cooling") continue;
      const prior = live.get(baseOf(t.identifier));
      if (!prior || t.createdAt > prior.createdAt) live.set(baseOf(t.identifier), t);
    }
    const bases = [...new Set(rows.map((r) => r.base))].filter((b) => live.has(b));
    const longest = Math.max(...rows.map((r) => (r.windowMin ?? 60) * 60), 3600);
    const history = new Map(await Promise.all(bases.map(async (b) => [b, await this.points(live.get(b)!.id, nowSec - longest - 3600)] as const)));
    const names = await this.names(bases.map((b) => live.get(b)!.identifier));
    let checked = 0;
    let fired = 0;
    for (const a of rows) {
      const t = live.get(a.base);
      const pts = history.get(a.base);
      if (!t || !pts || pts.length === 0) continue;
      checked++;
      const check = checkAlert(a, pts, nowSec);
      if (check.fire && this.push.enabled) {
        const name = names.get(t.identifier) ?? a.base;
        await this.push.notify(a.account, "alerts", alertPayload(a, name, t.identifier, check));
        fired++;
      }
      if (check.fire || check.armed !== a.armed) {
        await this.sql`
          UPDATE attention_alerts SET armed = ${check.armed},
                 last_fired_at = CASE WHEN ${check.fire} THEN now() ELSE last_fired_at END,
                 fired_count = fired_count + CASE WHEN ${check.fire} THEN 1 ELSE 0 END
           WHERE id = ${a.id}`;
      }
    }
    return { checked, fired };
  }
}
