import { useEffect, useState } from "react";

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

const numberFormat = new Intl.NumberFormat("en-US");
export const formatNumber = (n: number) => numberFormat.format(n);

/** "just now", "42s ago", "5m ago", "3h ago", "2d ago"; future times read "in 5m". */
export function formatAge(timeMs: number, nowMs: number): string {
  const diff = Math.round((nowMs - timeMs) / 1000);
  const abs = Math.abs(diff);
  if (abs < 5) return "just now";
  const unit = abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.floor(abs / 60)}m` : abs < 86_400 ? `${Math.floor(abs / 3600)}h` : `${Math.floor(abs / 86_400)}d`;
  return diff >= 0 ? `${unit} ago` : `in ${unit}`;
}

const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const formatDate = (timeMs: number) => dateFormat.format(timeMs);

/** 850 -> "850 ms", 4200 -> "4.2 s", 125000 -> "2m 5s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** The current time, refreshed every `intervalMs`, for relative timestamps. */
export function useNow(intervalMs = 10_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Only http(s) links are rendered; anything else from a source reference is shown as text. */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function wikipediaUrl(article: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(article.replace(/ /g, "_"))}`;
}
