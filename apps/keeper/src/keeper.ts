import type { Viewer } from "@tredio/chain";
import type { Deployment } from "@tredio/contracts";
import type { Executor } from "./executor";
import { type PlanConfig, plan } from "./plan";
import { snapshot } from "./snapshot";

export interface KeeperOptions extends PlanConfig {
  scanIntervalSec: number;
  maxActionsPerScan: number;
  staleAlertSec: number;
  /** Trends rotating out (their index goes stale on purpose); none when unknown. */
  rotating?: () => Promise<ReadonlySet<string>>;
}

/** Scans the chain, plans and sends, on a timer; one scan at a time. */
export class Keeper {
  lastScan: { at: number; actions: number; started: number; ms: number } | null = null;
  lastScanError: string | null = null;
  oracle = { live: 0, stale: 0, staleIds: [] as string[] };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly viewer: Viewer,
    private readonly deployment: Deployment,
    private readonly executor: Executor,
    private readonly opts: KeeperOptions,
    private readonly log: (fields: Record<string, unknown>, msg: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  async scan(): Promise<void> {
    const t0 = this.now();
    const nowSec = Math.floor(t0 / 1000);
    const s = await snapshot(this.viewer, this.deployment, nowSec);
    const rotating = (await this.opts.rotating?.().catch(() => null)) ?? new Set<string>();
    const live = s.trends.filter((t) => t.status !== "retired");
    const stale = live.filter((t) => !rotating.has(t.id) && nowSec - t.updated_at > this.opts.staleAlertSec);
    this.oracle = { live: live.length, stale: stale.length, staleIds: stale.map((t) => t.id).slice(0, 10) };
    const actions = plan(s, this.deployment, this.opts);
    const started = await this.executor.run(actions, this.opts.maxActionsPerScan);
    this.lastScan = { at: Math.floor(this.now() / 1000), actions: actions.length, started, ms: this.now() - t0 };
    this.lastScanError = null;
    if (started > 0) this.log({ planned: actions.length, started, ms: this.lastScan.ms }, "scan");
  }

  start(): void {
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.scan();
      } catch (e) {
        this.lastScanError = e instanceof Error ? e.message.slice(0, 300) : String(e);
        this.log({ err: this.lastScanError }, "scan failed");
      }
      if (!this.stopped) this.timer = setTimeout(tick, this.opts.scanIntervalSec * 1000);
    };
    void tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
