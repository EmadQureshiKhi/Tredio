/**
 * Recent errors for the admin system view: the backend's own warnings and errors (from the log)
 * and what each service and source reports, kept in memory, deduplicated by where
 * they came from and what they say, with how often and when they were last seen.
 */

/**
 * Text that is safe to show: every URL cut to its scheme and host (paths and queries are where
 * providers put API keys, and user info holds credentials), API keys masked, length capped.
 */
export function scrub(text: string, max = 300): string {
  return text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/"'<>)\]?#]*)([^\s"'<>)\]]*)/gi, (_m, scheme: string, authority: string, rest: string) => {
      const host = authority.slice(authority.lastIndexOf("@") + 1);
      const tail = /[.,;:!?]+$/.exec(rest)?.[0] ?? "";
      // A cut path ends in "...", so trailing dots after it would only repeat that.
      return rest.length > tail.length ? `${scheme}${host}/...${tail.replace(/^\.+/, "")}` : `${scheme}${host}${tail}`;
    })
    .replace(/\belfak_[A-Za-z0-9_-]+/g, "***")
    .replace(/\b(sk-|sk_|pk_|AIza)[A-Za-z0-9_-]{16,}/g, "$1***")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Hashes, ids and long numbers vary between otherwise identical errors. */
const shape = (message: string) => message.replace(/\b[0-9a-fA-F]{16,}\b/g, "…").replace(/\d{4,}/g, "#");

export interface RecentError {
  source: string;
  message: string;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

/** How long an error reported without its own time must be absent before it counts again. */
const REAPPEAR_MS = 120_000;

export class ErrorLog {
  private readonly entries = new Map<string, RecentError & { observedAt: number }>();

  constructor(
    private readonly max = 200,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records an error that just happened (or happened at `at`, when the reporter says): each call counts. */
  note(source: string, message: string, at?: number): void {
    this.record(source, message, at ?? this.now(), at === undefined ? "always" : "newer");
  }

  /**
   * Records an error a reporter keeps showing (a service's lastError, read on every poll): it
   * counts again only after it was absent for a while.
   */
  seen(source: string, message: string): void {
    this.record(source, message, this.now(), "reappeared");
  }

  /** `counts`: when a repeat counts again (always; only with a newer time; only after an absence). */
  private record(source: string, message: string, at: number, counts: "always" | "newer" | "reappeared"): void {
    const text = scrub(message);
    if (!text) return;
    const now = this.now();
    const key = `${source}\u0000${shape(text)}`;
    const e = this.entries.get(key);
    if (!e) {
      this.entries.set(key, { source, message: text, count: 1, firstSeenAt: at, lastSeenAt: at, observedAt: now });
      this.trim();
      return;
    }
    const fresh = counts === "always" || (counts === "newer" ? at > e.lastSeenAt : now - e.observedAt > REAPPEAR_MS);
    if (fresh) e.count++;
    e.message = text;
    e.lastSeenAt = Math.max(e.lastSeenAt, at);
    e.observedAt = now;
  }

  /** The most recent distinct errors since `sinceMs`, newest first. */
  recent(limit = 25, sinceMs = 24 * 3_600_000): RecentError[] {
    const after = this.now() - sinceMs;
    return [...this.entries.values()]
      .filter((e) => e.lastSeenAt >= after)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, limit)
      .map(({ observedAt: _o, ...e }) => e);
  }

  private trim(): void {
    if (this.entries.size <= this.max) return;
    const oldest = [...this.entries].sort((a, b) => a[1].observedAt - b[1].observedAt).slice(0, this.entries.size - this.max);
    for (const [k] of oldest) this.entries.delete(k);
  }
}

/** The backend process's own log of recent errors (the logger feeds it warnings and errors). */
export const backendErrors = new ErrorLog();
