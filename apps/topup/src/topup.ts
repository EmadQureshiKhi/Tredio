import type { Sender, Viewer } from "@tredio/chain";
import { calls, type Deployment } from "@tredio/contracts";
import { burnPerDay, DAY_MS, type Decision, freshMemory, plan, type TargetMemory } from "./plan";
import { format, NEAR, type Target, USDC } from "./targets";

export interface TopUpOptions {
  floor: bigint;
  low: bigint;
  cooldownMs: number;
  dailyCapNear: bigint;
  dailyCapUsdc: bigint;
  dryRun: boolean;
}

export interface Persist {
  load(): Record<string, TargetMemory>;
  save(m: Record<string, TargetMemory>): void;
}

const unitOf = (t: Target) => (t.kind === "usdc" ? USDC : NEAR);
/** Samples are kept at most every ten minutes, for two days. */
const SAMPLE_MS = 600_000;

export class TopUp {
  private memory: Map<string, TargetMemory>;
  lastCheck: { at: number; error: string | null } | null = null;
  treasuryBalance: bigint | null = null;
  balances = new Map<string, bigint | null>();
  decisions: Decision[] = [];
  private treasurySamples: Array<{ at: number; balance: string }> = [];

  constructor(
    private readonly viewer: Viewer,
    private readonly treasury: Sender,
    private readonly minter: Sender | null,
    private readonly d: Deployment,
    readonly targets: readonly Target[],
    private readonly opts: TopUpOptions,
    private readonly store: Persist,
    private readonly log: (fields: Record<string, unknown>, msg: string) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.memory = new Map(Object.entries(store.load()));
  }

  private mem(name: string): TargetMemory {
    let m = this.memory.get(name);
    if (!m) this.memory.set(name, (m = freshMemory()));
    return m;
  }

  private async balanceOf(t: Target): Promise<bigint | null> {
    try {
      if (t.kind === "near") return await this.viewer.balance(t.account);
      if (t.kind === "gasKey") return (await this.viewer.gasKey(t.account, t.publicKey!))?.balance ?? null;
      return BigInt(await this.viewer.view<string>(this.d.contracts.usdc, "ft_balance_of", { account_id: t.account }));
    } catch {
      return null;
    }
  }

  private async send(t: Target, amount: bigint): Promise<string | null> {
    if (t.kind === "near") {
      const o = await this.treasury.sendTx((tx) => tx.transfer(t.account, `${amount} yocto` as never));
      return o.transaction?.hash ?? null;
    }
    if (t.kind === "gasKey") return (await this.treasury.fundGasKey(t.account, t.publicKey!, amount)).transaction?.hash ?? null;
    if (!this.minter) throw new Error("no USDC minter");
    return (await this.minter.send(calls(this.d).usdc.mint(t.account, amount.toString()))).hash;
  }

  async check(): Promise<void> {
    const t0 = this.now();
    try {
      const [treasury, ...balances] = await Promise.all([this.viewer.balance(this.treasury.accountId).catch(() => null), ...this.targets.map((t) => this.balanceOf(t))]);
      this.treasuryBalance = treasury;
      this.balances = new Map(this.targets.map((t, i) => [t.name, balances[i] ?? null]));
      for (const [i, t] of this.targets.entries()) {
        const b = balances[i];
        const m = this.mem(t.name);
        if (b !== null && b !== undefined && (m.samples.length === 0 || t0 - m.samples[m.samples.length - 1]!.at >= SAMPLE_MS)) m.samples.push({ at: t0, balance: b.toString() });
        m.samples = m.samples.filter((s) => t0 - s.at <= 2 * DAY_MS);
        m.sent = m.sent.filter((s) => t0 - s.at <= 2 * DAY_MS);
      }
      if (treasury !== null && (this.treasurySamples.length === 0 || t0 - this.treasurySamples[this.treasurySamples.length - 1]!.at >= SAMPLE_MS)) this.treasurySamples.push({ at: t0, balance: treasury.toString() });
      this.treasurySamples = this.treasurySamples.filter((s) => t0 - s.at <= 2 * DAY_MS);
      const spendableNear = treasury === null ? 0n : treasury > this.opts.floor ? treasury - this.opts.floor : 0n;
      this.decisions = plan(this.targets, this.balances, this.memory, t0, {
        cooldownMs: this.opts.cooldownMs,
        dailyCap: (t) => (t.kind === "usdc" ? this.opts.dailyCapUsdc : this.opts.dailyCapNear),
        // Test USDC is minted, so only the daily cap bounds it.
        spendable: (k) => (k === "usdc" ? (this.minter ? 10n ** 30n : 0n) : spendableNear),
      });
      for (const dcs of this.decisions) {
        if (dcs.amount <= 0n || this.opts.dryRun) continue;
        const m = this.mem(dcs.target.name);
        const shown = `${format(dcs.amount, unitOf(dcs.target))} ${dcs.target.kind === "usdc" ? "USDC" : "NEAR"}`;
        try {
          // Recorded before the send, so a crash mid-send never refills twice past the cap.
          m.sent.push({ at: this.now(), amount: dcs.amount.toString() });
          this.store.save(Object.fromEntries(this.memory));
          const hash = await this.send(dcs.target, dcs.amount);
          m.lastTransfer = { at: this.now(), amount: dcs.amount.toString(), hash, status: "sent" };
          m.failures = 0;
          m.retryAt = 0;
          this.log({ target: dcs.target.name, account: dcs.target.account, amount: shown, tx: hash }, "refilled");
        } catch (e) {
          m.sent.pop();
          m.failures++;
          m.retryAt = this.now() + Math.min(60_000 * 2 ** m.failures, 3_600_000);
          m.lastTransfer = { at: this.now(), amount: dcs.amount.toString(), hash: null, status: "failed" };
          this.log({ target: dcs.target.name, err: e instanceof Error ? e.message.slice(0, 300) : String(e) }, "refill failed");
        }
      }
      this.store.save(Object.fromEntries(this.memory));
      this.lastCheck = { at: Math.floor(this.now() / 1000), error: null };
    } catch (e) {
      this.lastCheck = { at: Math.floor(this.now() / 1000), error: e instanceof Error ? e.message.slice(0, 300) : String(e) };
    }
  }

  /** The treasury and every target, in the shape the status views read (`treasury`, `targets`). */
  report() {
    const nowMs = this.now();
    const burns = this.targets.map((t) => (t.kind === "usdc" ? null : burnPerDay(this.mem(t.name), nowMs)));
    const totalBurn = burns.reduce<bigint | null>((a, b) => (b === null ? a : (a ?? 0n) + b), null);
    const balance = this.treasuryBalance;
    const spendable = balance === null ? null : balance > this.opts.floor ? balance - this.opts.floor : 0n;
    const runwayDays = spendable !== null && totalBurn !== null && totalBurn > 0n ? Number((spendable * 100n) / totalBurn) / 100 : null;
    return {
      treasury: {
        account: this.treasury.accountId,
        balance: balance === null ? null : format(balance, NEAR),
        floor: format(this.opts.floor, NEAR),
        spendable: spendable === null ? null : format(spendable, NEAR),
        burnPerDay: totalBurn === null ? null : format(totalBurn, NEAR),
        runwayDays,
        low: balance !== null && balance < this.opts.low,
      },
      targets: this.targets.map((t, i) => {
        const m = this.mem(t.name);
        const b = this.balances.get(t.name);
        const decision = this.decisions.find((x) => x.target.name === t.name);
        const unit = unitOf(t);
        const state = b === null || b === undefined ? "unknown" : m.failures >= 3 ? "failing" : b < t.min ? (decision?.skip ? "waiting" : "refilling") : "ok";
        return {
          name: t.name,
          kind: t.kind,
          account: t.account,
          publicKey: t.publicKey,
          balance: b === null || b === undefined ? null : format(b, unit),
          min: format(t.min, unit),
          target: format(t.target, unit),
          state,
          waitingFor: b !== null && b !== undefined && b < t.min ? (decision?.skip ?? null) : null,
          burnPerDay: burns[i] === null || burns[i] === undefined ? null : format(burns[i]!, unit),
          lastTransfer: m.lastTransfer ? { hash: m.lastTransfer.hash, amount: format(BigInt(m.lastTransfer.amount), unit), at: Math.floor(m.lastTransfer.at / 1000), status: m.lastTransfer.status } : null,
          lastError: m.failures > 0 ? "the last refill failed" : null,
        };
      }),
    };
  }
}
