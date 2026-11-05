"use client";
import { ApiError, push } from "@/lib/api";

/**
 * Web Push for this device: the service worker at /sw.js shows what the backend sends (title,
 * body, url, tag) and opens the url on a tap. The subscription is keyed by its endpoint on the
 * backend; the topics chosen here are remembered on the device, since each subscribe call carries
 * the full list.
 */

export type PushTopic = "autopilot" | "copy" | "calls" | "markets" | "alerts";
export const PUSH_TOPICS: ReadonlyArray<{ value: PushTopic; label: string; hint: string }> = [
  { value: "autopilot", label: "Autopilot", hint: "Your rules open, close, pause or hit a limit" },
  { value: "copy", label: "Copy trading", hint: "A leader you follow trades, or a copy is skipped" },
  { value: "calls", label: "Calls", hint: "Your calls resolve as hits or misses" },
  { value: "markets", label: "Markets", hint: "Trends you trade move or settle, and trends you watch go live" },
  { value: "alerts", label: "Attention alerts", hint: "A trend's attention moves the way an alert you set asks" },
];

/** Topics added after a device chose its list: each joins that list once (the backend turned it on too). */
const ADDED_LATER: readonly PushTopic[] = ["alerts"];
const ADDED_KEY = "tredio.push.added";

const TOPICS_KEY = "tredio.push.topics";
const SW_URL = "/sw.js";

export type PushSupport = "supported" | "install-first" | "unsupported";

/** Whether this browser can take push; iPhone and iPad need the app on the Home Screen first. */
export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  const ok = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (ok) return "supported";
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches;
  return ios && !standalone ? "install-first" : "unsupported";
}

export function storedTopics(): PushTopic[] {
  try {
    const raw = JSON.parse(localStorage.getItem(TOPICS_KEY) ?? "null") as unknown;
    if (Array.isArray(raw)) {
      const valid = raw.filter((t): t is PushTopic => PUSH_TOPICS.some((x) => x.value === t));
      if (valid.length) return withAddedTopics(valid);
    }
  } catch {
    // Storage blocked or malformed: fall back to every topic.
  }
  return PUSH_TOPICS.map((t) => t.value);
}

function withAddedTopics(topics: PushTopic[]): PushTopic[] {
  const added = JSON.parse(localStorage.getItem(ADDED_KEY) ?? "[]") as unknown;
  const seen = Array.isArray(added) ? added : [];
  const fresh = ADDED_LATER.filter((t) => !seen.includes(t));
  if (fresh.length === 0) return topics;
  const next = [...topics, ...fresh.filter((t) => !topics.includes(t))];
  localStorage.setItem(ADDED_KEY, JSON.stringify([...seen, ...fresh]));
  storeTopics(next);
  return next;
}

function storeTopics(topics: PushTopic[]) {
  try {
    localStorage.setItem(TOPICS_KEY, JSON.stringify(topics));
  } catch {
    // The choice lasts this visit.
  }
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== "supported") return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return reg ? reg.pushManager.getSubscription() : null;
}

async function register(subscription: PushSubscription, topics: PushTopic[]) {
  const json = subscription.toJSON() as { endpoint: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.keys?.p256dh || !json.keys.auth) throw new Error("The browser returned an incomplete push subscription.");
  await push.subscribe({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }, topics });
  storeTopics(topics);
}

/** Asks for permission, registers the service worker, subscribes and tells the backend. */
export async function enablePush(topics: PushTopic[]): Promise<PushSubscription> {
  if (pushSupport() !== "supported") throw new Error("This browser cannot receive push notifications.");
  if (Notification.permission === "denied") throw new Error("Notifications are blocked for this site. Allow them in your browser's site settings, then try again.");
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications were not allowed.");
  const reg = await navigator.serviceWorker.register(SW_URL, { scope: "/" });
  await navigator.serviceWorker.ready;
  const { publicKey } = await push.vapid();
  const applicationServerKey = fromBase64Url(publicKey);
  let sub = await reg.pushManager.getSubscription();
  try {
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
  } catch (e) {
    // A subscription made with an earlier server key blocks a new one: replace it.
    const stale = await reg.pushManager.getSubscription();
    if (!stale) throw e;
    await stale.unsubscribe();
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
  }
  try {
    await register(sub, topics);
  } catch (e) {
    // 409: this browser's endpoint belongs to another account (someone else signed in here before
    // without turning push off). A fresh subscription gets a new endpoint for this account.
    if (!(e instanceof ApiError) || e.status !== 409) throw e;
    await sub.unsubscribe();
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
    await register(sub, topics);
  }
  return sub;
}

/** Updates which topics this device gets (at least one). */
export async function setPushTopics(topics: PushTopic[]): Promise<void> {
  if (topics.length === 0) throw new Error("Keep at least one topic, or turn notifications off.");
  const sub = await currentSubscription();
  if (!sub) throw new Error("Notifications are off on this device.");
  // The choice holds on this device at once (leaving the page mid-save keeps it); a failed save undoes it.
  const before = storedTopics();
  storeTopics(topics);
  try {
    await register(sub, topics);
  } catch (e) {
    storeTopics(before);
    throw e;
  }
}

/** Stops push on this device, on the backend and in the browser. */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await push.unsubscribe(sub.endpoint).catch(() => {
    // The backend drops endpoints the push service reports gone, so a failed call here is harmless.
  });
  await sub.unsubscribe();
}

/** True once this device takes `topic`: adds it to the device's topics, or turns push on (asking permission the first time). */
export async function ensurePushTopic(topic: PushTopic): Promise<boolean> {
  try {
    if (pushSupport() !== "supported") return false;
    const topics = storedTopics();
    if (await currentSubscription()) {
      if (!topics.includes(topic)) await setPushTopics([...topics, topic]);
      return true;
    }
    await enablePush(topics.includes(topic) ? topics : [...topics, topic]);
    return true;
  } catch {
    return false;
  }
}
