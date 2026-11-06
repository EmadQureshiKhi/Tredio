import type { Sql } from "../db";
import type { Push, PushPayload, Topic } from "./push";

/**
 * Turns what happened into notifications: Autopilot and copy-trading events from the audit log,
 * resolved calls and listed candidates. The audit log keeps a cursor; calls and watches are marked
 * on their own rows (calls resolve out of id order), so every event notifies once even across
 * restarts.
 */

interface AuditRow {
  id: string;
  owner: string;
  rule_id: string | null;
  follow_id: string | null;
  event: string;
  detail: Record<string, unknown>;
}

const money = (v: unknown) => (typeof v === "number" ? `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(2)} USDC` : "");

/** The notification for an audit event, or null for events not worth a buzz. */
export function auditNotification(e: AuditRow): { topic: Topic; payload: PushPayload } | null {
  const d = e.detail;
  const copy = e.follow_id !== null;
  const topic: Topic = copy ? "copy" : "autopilot";
  const url = copy ? "/copy" : e.rule_id ? `/autopilot/${e.rule_id}` : "/autopilot";
  const what = copy ? "Copy trade" : "Autopilot";
  switch (e.event) {
    case "order_filled": {
      const opened = d.action === "open";
      const side = String(d.side ?? "");
      return {
        topic,
        payload: {
          title: `${what}: ${opened ? "opened" : "closed"} ${side}`,
          body: opened ? `Filled at ${d.price}` : `Closed at ${d.price}${typeof d.pnlUsdc === "number" ? `, ${money(d.pnlUsdc)} before fees` : ""}`,
          url,
          tag: `order-${d.orderId}`,
        },
      };
    }
    case "order_failed":
      return { topic, payload: { title: `${what}: order failed`, body: String(d.error ?? "The order did not go through."), url, tag: `order-${d.orderId}` } };
    case "rule_paused":
      return d.by === "autopilot" ? { topic: "autopilot", payload: { title: "Autopilot paused a rule", body: String(d.reason ?? ""), url } } : null;
    case "position_closed_externally":
      return { topic, payload: { title: `${what}: position closed outside Autopilot`, body: `Liquidated or closed by hand${typeof d.estimatedPnlUsdc === "number" ? ` (about ${money(d.estimatedPnlUsdc)})` : ""}.`, url } };
    case "copy_loss_cap":
      return {
        topic: "copy",
        payload: {
          title: "Copy trade: loss cap reached",
          body: `Your open copies were down ${Math.abs(Number(d.openPnlUsdc)).toFixed(2)} USDC against a ${Number(d.capUsdc).toFixed(2)} USDC cap. Autopilot is closing them and paused this follow.`,
          url,
          tag: `loss-cap-${e.follow_id}`,
        },
      };
    case "grant_expired":
      return { topic: "autopilot", payload: { title: "Autopilot access expired", body: "Renew it with your passkey to keep your rules and copies trading.", url: "/autopilot" } };
    default:
      return null;
  }
}

export class Dispatcher {
  constructor(
    private readonly sql: Sql,
    private readonly push: Push,
  ) {}

  private async cursor(name: string): Promise<number> {
    const rows = await this.sql<{ position: string }[]>`SELECT position FROM cursors WHERE name = ${name}`;
    if (rows[0]) return Number(rows[0].position);
    // A new stream starts at the present, not by replaying history.
    const start = await this.sql<{ m: string | null }[]>`SELECT max(id) AS m FROM autopilot_audit`;
    const position = Number(start[0]?.m ?? 0);
    await this.sql`INSERT INTO cursors (name, position) VALUES (${name}, ${position}) ON CONFLICT DO NOTHING`;
    return position;
  }

  private setCursor(name: string, position: number) {
    return this.sql`UPDATE cursors SET position = ${position} WHERE name = ${name}`;
  }

  async tick(): Promise<{ notified: number }> {
    if (!this.push.enabled) return { notified: 0 };
    let notified = 0;
    const auditFrom = await this.cursor("audit");
    const events = await this.sql<AuditRow[]>`SELECT id, owner, rule_id, follow_id, event, detail FROM autopilot_audit WHERE id > ${auditFrom} ORDER BY id LIMIT 500`;
    for (const e of events) {
      const n = auditNotification(e);
      if (n) notified += await this.push.notify(e.owner, n.topic, n.payload);
    }
    if (events.length > 0) await this.setCursor("audit", Number(events.at(-1)!.id));

    // Resolved calls notify the caller's linked account (an unlinked identity has no devices here);
    // a call moderation hid stays quiet, and is marked like the rest so a later restore stays quiet too.
    const calls = await this.sql<{ id: string; identifier: string; direction: string; outcome: string; linked_account: string | null; hidden: boolean }[]>`
      SELECT c.id, c.identifier, c.direction, c.outcome, cl.linked_account, c.hidden_at IS NOT NULL AS hidden FROM calls c JOIN callers cl ON cl.address = c.caller
       WHERE c.outcome <> 'open' AND c.notified_at IS NULL ORDER BY c.id LIMIT 500`;
    for (const c of calls) {
      if (!c.linked_account || c.outcome === "void" || c.hidden) continue;
      notified += await this.push.notify(c.linked_account, "calls", {
        title: c.outcome === "hit" ? "Your call hit" : "Your call missed",
        body: `${c.identifier}: attention ${c.direction}`,
        url: `/t/${c.identifier}`,
        tag: `call-${c.id}`,
      });
    }
    if (calls.length > 0) await this.sql`UPDATE calls SET notified_at = now() WHERE id IN ${this.sql(calls.map((c) => c.id))}`;

    // "Notify me when it lists": a watched candidate that listed tells each account waiting on it,
    // once, under the markets topic (an account that turned markets off hears nothing).
    const listed = await this.sql<{ candidate_id: string; account: string; display_name: string; identifier: string }[]>`
      SELECT w.candidate_id, w.account, c.display_name, COALESCE(m.identifier, c.identifier) AS identifier
        FROM candidate_watches w
        JOIN candidates c ON c.id = w.candidate_id
        LEFT JOIN LATERAL (
          SELECT identifier FROM trend_meta WHERE identifier = c.identifier OR identifier LIKE c.identifier || '.%'
           ORDER BY updated_at DESC LIMIT 1
        ) m ON true
       WHERE w.notified_at IS NULL AND c.status = 'live'
       ORDER BY w.created_at LIMIT 500`;
    for (const w of listed) {
      notified += await this.push.notify(w.account, "markets", {
        title: `${w.display_name} is live on Tredio`,
        body: "Its market just opened. Trade it before the crowd.",
        url: `/t/${w.identifier}`,
        tag: `listed-${w.candidate_id}`,
      });
      await this.sql`UPDATE candidate_watches SET notified_at = now() WHERE candidate_id = ${w.candidate_id} AND account = ${w.account}`;
    }
    return { notified };
  }
}
