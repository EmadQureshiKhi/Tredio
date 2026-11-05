import { type Fetch, HttpError, query } from "./http";

/**
 * GDELT DOC 2.0 (https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/), keyless: how many news
 * articles worldwide matched a query over the last day.
 *
 * GDELT asks for at most one request every 5 seconds and refuses bursts, often with a 429 even
 * when a client keeps to that, so every request goes through one pacer: one at a time, each
 * starting a jittered 6 to 10 seconds after the previous answer ended (GDELT counts from there,
 * and an answer can take many seconds). A refusal (a 429, the plain-text plea GDELT sometimes
 * sends with a 200, or empty answers) rests the lane that got it for its Retry-After or a backoff
 * that doubles from 2 minutes to an hour, and the next request takes another lane. Refusals on
 * several lanes in a row mean GDELT itself is shedding load, so the whole source then rests too,
 * from 5 minutes doubling to an hour, until a reading comes back. A lane is a Fetch with an optional readiness check;
 * the default is a single direct one.
 */

export const GDELT_MIN_GAP_MS = 6_000;
export const GDELT_MAX_GAP_MS = 10_000;
export const GDELT_FIRST_REST_MS = 120_000;
export const GDELT_MAX_REST_MS = 3_600_000;
/** Refusals in a row, on any lanes, that rest the whole source. */
export const GDELT_SOURCE_STRIKES = 3;
export const GDELT_FIRST_SOURCE_REST_MS = 300_000;
/** Empty answers in a row on one lane before they count as a refusal. */
export const GDELT_EMPTY_STRIKES = 2;
const THROTTLED_TEXT = /^\s*please limit requests/i;

export interface GdeltLane {
  /** For logs and tests only. */
  id: string;
  fetch: Fetch;
  /** False while the lane may not be used (another client needs it, or its budget is spent). */
  ready?: () => boolean;
}

export interface GdeltOptions {
  /**
   * Ways to reach GDELT. The first takes every request while it is ready and not resting; the others
   * take turns while it rests.
   */
  lanes?: GdeltLane[];
  /** A number in [0, 1) for the jitter. */
  random?: () => number;
}

/** GDELT answered, but with nothing a reading can come from (see parseTimeline). */
export class GdeltEmpty extends Error {
  constructor(readonly reason: string) {
    super(`gdelt: ${reason}`);
  }
}

interface LaneState {
  lane: GdeltLane;
  restUntil: number;
  restMs: number;
  empties: number;
}

export class Gdelt {
  private queue: Promise<unknown> = Promise.resolve();
  private nextAt = 0;
  private turn = 0;
  private strikes = 0;
  private sourceRestUntil = 0;
  private sourceRestMs = GDELT_FIRST_SOURCE_REST_MS;
  private readonly lanes: LaneState[];
  private readonly random: () => number;
  /** Counters for the admin view and the logs. */
  readonly counts = { requests: 0, refused: 0, empty: 0, readings: 0 };

  constructor(
    fetchImpl: Fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly now: () => number = Date.now,
    opts: GdeltOptions = {},
  ) {
    const lanes = opts.lanes && opts.lanes.length > 0 ? opts.lanes : [{ id: "direct", fetch: fetchImpl }];
    this.lanes = lanes.map((lane) => ({ lane, restUntil: 0, restMs: GDELT_FIRST_REST_MS, empties: 0 }));
    this.random = opts.random ?? Math.random;
  }

  /** False while the source, or every lane, rests after refusals. */
  get available(): boolean {
    const t = this.now();
    return this.sourceRestUntil <= t && this.lanes.some((l) => l.restUntil <= t);
  }

  /** When a request may go again: now when one may. */
  get restingUntil(): number {
    if (this.available) return this.now();
    return Math.max(this.sourceRestUntil, Math.min(...this.lanes.map((l) => l.restUntil)));
  }

  /**
   * News articles matching any keyword over the last day. Null when GDELT answered without a
   * usable timeline (nothing matched, or its index showed no recent articles at all); throws when
   * every lane is resting or GDELT refused.
   */
  articles(keywords: readonly string[]): Promise<number | null> {
    const q = gdeltQuery(keywords);
    if (q === null) return Promise.reject(new Error("gdelt: no keyword is long enough to search"));
    return this.serial(async () => {
      if (!this.available) throw new Error("gdelt: resting after rate limiting");
      const wait = this.nextAt - this.now();
      if (wait > 0) await this.sleep(wait);
      const state = this.pick();
      if (!state) throw new Error("gdelt: resting after rate limiting");
      this.counts.requests++;
      const url = `https://api.gdeltproject.org/api/v2/doc/doc?${query({ query: q, mode: "timelinevolraw", timespan: "1d", format: "json" })}`;
      let body: string;
      try {
        const res = await state.lane.fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
        body = await res.text();
        // GDELT also throttles with a 200 and a plain-text plea instead of a 429.
        if (res.status === 429 || THROTTLED_TEXT.test(body)) {
          const after = Number(res.headers.get("retry-after"));
          this.rest(state, Number.isFinite(after) && after > 0 ? after * 1000 : undefined);
          throw new HttpError("gdelt", 429, body);
        }
        if (!res.ok) throw new HttpError("gdelt", res.status, body);
      } finally {
        this.nextAt = this.now() + this.gap();
      }
      let count: number | null;
      try {
        count = parseTimeline(body, this.now() / 1000);
      } catch (e) {
        if (!(e instanceof GdeltEmpty)) throw e;
        // GDELT answers some throttled requests with an empty or stale timeline: a lane that keeps
        // getting them rests like one that was refused.
        this.counts.empty++;
        if (++state.empties >= GDELT_EMPTY_STRIKES) this.rest(state);
        return null;
      }
      state.empties = 0;
      state.restMs = GDELT_FIRST_REST_MS;
      this.strikes = 0;
      this.sourceRestMs = GDELT_FIRST_SOURCE_REST_MS;
      this.counts.readings++;
      return count;
    });
  }

  /** The first lane when it can take the request, otherwise the next of the others in turn. */
  private pick(): LaneState | null {
    const t = this.now();
    const usable = (l: LaneState) => l.restUntil <= t && (l.lane.ready?.() ?? true);
    if (usable(this.lanes[0]!)) return this.lanes[0]!;
    const others = this.lanes.length - 1;
    for (let i = 0; i < others; i++) {
      const k = 1 + ((this.turn + i) % others);
      if (usable(this.lanes[k]!)) {
        this.turn = k % others;
        return this.lanes[k]!;
      }
    }
    return null;
  }

  private rest(state: LaneState, retryAfter?: number): void {
    this.counts.refused++;
    const ms = Math.min(GDELT_MAX_REST_MS, Math.max(state.restMs, retryAfter ?? 0));
    state.restUntil = this.now() + ms;
    state.restMs = Math.min(state.restMs * 2, GDELT_MAX_REST_MS);
    state.empties = 0;
    if (++this.strikes >= GDELT_SOURCE_STRIKES) {
      this.sourceRestUntil = this.now() + this.sourceRestMs;
      this.sourceRestMs = Math.min(this.sourceRestMs * 2, GDELT_MAX_REST_MS);
      this.strikes = 0;
    }
  }

  private gap(): number {
    return Math.round(GDELT_MIN_GAP_MS + this.random() * (GDELT_MAX_GAP_MS - GDELT_MIN_GAP_MS));
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/**
 * A GDELT query from keywords: phrases quoted, ORed in parentheses. GDELT rejects words under
 * three letters, and cashtags are not news vocabulary, so both are dropped.
 */
export function gdeltQuery(keywords: readonly string[]): string | null {
  const terms = keywords
    .map((k) => k.trim().replace(/["()]/g, ""))
    .filter((k) => !k.startsWith("$") && k.replace(/\s/g, "").length >= 3);
  if (terms.length === 0) return null;
  const quoted = [...new Set(terms)].slice(0, 5).map((t) => (/\s/.test(t) ? `"${t}"` : t));
  return quoted.length === 1 ? quoted[0]! : `(${quoted.join(" OR ")})`;
}

/** How far behind now (or its own window) GDELT's newest data may be before the timeline is stale. */
export const GDELT_STALE_SEC = 6 * 3600;

/**
 * Sum of the article counts in a `timelinevolraw` response. Throws GdeltEmpty when there is no
 * reading to take: an empty object (GDELT answers both "nothing matched" and some throttled
 * requests with `{}`), a timeline that ends hours before now (GDELT cuts a timeline off where its
 * index stops), or one whose `norm` (every article GDELT monitored in each interval) is zero across
 * the day or stops hours before the window ends. Each means GDELT's index was not keeping up, and
 * recorded as zero it would drag the index of a trend that is all over the news.
 */
export function parseTimeline(body: string, nowSec: number = Date.now() / 1000): number {
  let json: { timeline?: Array<{ data?: Array<{ date?: unknown; value?: unknown; norm?: unknown }> }> };
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`gdelt: ${body.slice(0, 120)}`);
  }
  const series = json.timeline?.[0]?.data;
  if (!series || series.length === 0) throw new GdeltEmpty("no timeline");
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const lastAt = gdeltDate(series.at(-1)!.date);
  if (lastAt !== null && nowSec - lastAt > GDELT_STALE_SEC) throw new GdeltEmpty("index is behind");
  if (series.some((p) => p.norm !== undefined)) {
    const monitored = series.filter((p) => num(p.norm) > 0);
    if (monitored.length === 0) throw new GdeltEmpty("index shows no articles monitored today");
    const newestAt = gdeltDate(monitored.at(-1)!.date);
    if (lastAt !== null && newestAt !== null && lastAt - newestAt > GDELT_STALE_SEC) throw new GdeltEmpty("index is behind");
  }
  return series.reduce((a, p) => a + num(p.value), 0);
}

/** Seconds since the epoch from GDELT's "20261013T041500Z". */
export function gdeltDate(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) / 1000 : null;
}
