import webpush from "web-push";
import type { Sql } from "../db";

/**
 * Web Push (RFC 8030 with VAPID): an account's devices subscribe from the app's service worker,
 * and the backend sends each one an encrypted payload. Subscriptions the push service reports
 * gone (404, 410) are dropped; others are dropped after repeated failures.
 */

export type Topic = "autopilot" | "copy" | "calls" | "markets" | "alerts";
export const TOPICS: readonly Topic[] = ["autopilot", "copy", "calls", "markets", "alerts"];

export interface PushPayload {
  title: string;
  body: string;
  /** Where tapping the notification goes, inside the app. */
  url: string;
  /** Replaces an earlier notification with the same tag. */
  tag?: string;
}

/** The browsers' push services: Chrome and most others (FCM), Firefox, Safari and Edge. */
const PUSH_HOSTS = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);
const WINDOWS_PUSH = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.notify\.windows\.com$/;

/**
 * True for an endpoint at a known browser push service, over https on the default port. The
 * backend posts to every stored endpoint, so any other URL would let a user aim it elsewhere.
 */
export function isPushEndpoint(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443") || url.username || url.password) return false;
  return PUSH_HOSTS.has(url.hostname) || WINDOWS_PUSH.test(url.hostname);
}

export interface Sender {
  send(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string): Promise<{ statusCode: number }>;
}

export class Push {
  private readonly sender: Sender;
  constructor(
    private readonly sql: Sql,
    readonly vapid: { publicKey: string; privateKey: string; subject: string } | null,
    sender?: Sender,
  ) {
    this.sender =
      sender ??
      ({
        send: (sub, payload) => webpush.sendNotification(sub, payload, { vapidDetails: vapid ?? undefined, TTL: 3600, urgency: "normal" }),
      } satisfies Sender);
  }

  get enabled(): boolean {
    return this.vapid !== null;
  }

  /**
   * Stores a device's subscription. An endpoint another account holds stays theirs (it is their
   * device until they unsubscribe), so this returns false and changes nothing.
   */
  async subscribe(account: string, s: { endpoint: string; p256dh: string; auth: string; topics: readonly Topic[] }): Promise<boolean> {
    const rows = await this.sql`
      INSERT INTO push_subscriptions (endpoint, account, p256dh, auth, topics) VALUES (${s.endpoint}, ${account.toLowerCase()}, ${s.p256dh}, ${s.auth}, ${this.sql.array([...s.topics])})
      ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, topics = EXCLUDED.topics, failures = 0
       WHERE push_subscriptions.account = EXCLUDED.account
      RETURNING endpoint`;
    return rows.length > 0;
  }

  async unsubscribe(account: string, endpoint: string): Promise<void> {
    await this.sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint} AND account = ${account.toLowerCase()}`;
  }

  /** Sends to every device of `account` subscribed to `topic`; returns how many accepted it. */
  async notify(account: string, topic: Topic, payload: PushPayload): Promise<number> {
    if (!this.vapid) return 0;
    const subs = await this.sql<{ endpoint: string; p256dh: string; auth: string }[]>`
      SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE account = ${account.toLowerCase()} AND ${topic} = ANY(topics)`;
    let sent = 0;
    for (const s of subs) {
      // Stored before endpoints were checked: never post anywhere but a push service.
      if (!isPushEndpoint(s.endpoint)) {
        await this.sql`DELETE FROM push_subscriptions WHERE endpoint = ${s.endpoint}`;
        continue;
      }
      try {
        await this.sender.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload));
        sent++;
        await this.sql`UPDATE push_subscriptions SET failures = 0 WHERE endpoint = ${s.endpoint} AND failures > 0`;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await this.sql`DELETE FROM push_subscriptions WHERE endpoint = ${s.endpoint}`;
        else await this.sql`UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ${s.endpoint}`;
      }
    }
    await this.sql`DELETE FROM push_subscriptions WHERE failures >= 10`;
    return sent;
  }
}
