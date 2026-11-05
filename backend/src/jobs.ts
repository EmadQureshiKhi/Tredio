import { scrub } from "./errors";
import type { Log } from "./log";
import type { Store } from "./store";

/**
 * Background loops. Each job runs on its interval and never overlaps itself; a run can also be
 * triggered on demand (the admin API) and is recorded the same way.
 */
export class Jobs {
  private readonly jobs = new Map<string, { run: () => Promise<void>; running: boolean; timer: ReturnType<typeof setInterval> | null }>();

  constructor(
    private readonly store: Store,
    private readonly log: Log,
  ) {}

  add(name: string, intervalSec: number, job: () => Promise<object>, opts: { start: boolean }): void {
    const entry = { running: false, timer: null as ReturnType<typeof setInterval> | null, run: async () => {} };
    entry.run = async () => {
      if (entry.running) return;
      entry.running = true;
      const started = Date.now();
      try {
        const report = await job();
        await this.store.jobOk(name, { ...report, ms: Date.now() - started });
        this.log.info({ job: name, ms: Date.now() - started, ...report }, "job done");
      } catch (e) {
        // Errors from RPC clients quote the endpoint URL, keys included: never store or show those.
        const message = scrub(e instanceof Error ? e.message : String(e), 500);
        await this.store.jobFailed(name, message).catch(() => {});
        this.log.error({ job: name, err: message }, "job failed");
      } finally {
        entry.running = false;
      }
    };
    if (opts.start) {
      entry.timer = setInterval(() => void entry.run(), intervalSec * 1000);
      void entry.run();
    }
    this.jobs.set(name, entry);
  }

  /** Starts a run now unless one is in progress. Returns false when it was already running. */
  trigger(name: string): boolean {
    const entry = this.jobs.get(name);
    if (!entry) throw new Error(`unknown job ${name}`);
    if (entry.running) return false;
    void entry.run();
    return true;
  }

  stop(): void {
    for (const e of this.jobs.values()) if (e.timer) clearInterval(e.timer);
  }
}
