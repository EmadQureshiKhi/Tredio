import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Where indexing starts when neither START_BLOCK nor the deployments file names a height.
 * Testnet: the block that created `usdc.tredio.testnet` (2026-11-05 18:11:14 UTC), the first
 * account of the deploy script; nothing Tredio logged an event before it. Found with FastNEAR's
 * transaction API (`POST https://tx.test.fastnear.com/v0/account`, oldest `tx_block_height` of
 * each contract account; usdc is the lowest of the eight).
 */
export const DEFAULT_START_BLOCK: Record<string, number> = { testnet: 276_376_358 };

const account = z.string().min(2).max(64);

const Deployment = z.object({
  network: z.enum(["testnet", "mainnet"]),
  root: account,
  startBlock: z.number().int().positive().optional(),
  contracts: z.object({
    usdc: account,
    registry: account,
    outcomes: account,
    book: account,
    perps: account,
    curation: account,
    coins: account,
    accounts: account,
  }),
  params: z.object({ curveGraduationReserve: z.string().regex(/^\d+$/).optional() }).partial().optional(),
});

export type Deployment = z.infer<typeof Deployment>;
export type ContractRole = keyof Deployment["contracts"];
/** What an executor is to Tredio: one of the deployment's contracts, a trend coin or a user account. */
export type Role = ContractRole | "coin" | "account";

export function deploymentsPath(network: string): string {
  return fileURLToPath(new URL(`../../../deployments/${network}.json`, import.meta.url));
}

export function loadDeployment(path: string): Deployment {
  return Deployment.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** A universal account: `0u` and 52 more characters. */
export function isUniversalAccount(id: string): boolean {
  return id.length === 54 && id.startsWith("0u");
}

/** Decides which receipt executors are Tredio's and which of their events count. */
export class Tracker {
  private readonly roles = new Map<string, ContractRole>();
  private readonly coinSuffix: string;
  /** USDC (6 decimals) a curve's reserve must reach to stop selling; a sale below it reopens the curve. */
  readonly graduationReserve: bigint;

  constructor(readonly deployment: Deployment) {
    for (const [role, id] of Object.entries(deployment.contracts)) this.roles.set(id, role as ContractRole);
    this.coinSuffix = `.${deployment.contracts.coins}`;
    this.graduationReserve = BigInt(deployment.params?.curveGraduationReserve ?? "0");
  }

  roleOf(executor: string): Role | null {
    const role = this.roles.get(executor);
    if (role) return role;
    if (executor.endsWith(this.coinSuffix) && !executor.slice(0, -this.coinSuffix.length).includes(".")) return "coin";
    if (isUniversalAccount(executor)) return "account";
    return null;
  }

  /**
   * Whether an event of `standard` logged by an executor of `role` is kept. Contracts keep every
   * event they log; a user account only its `tredio-account` events, so a universal account of
   * another app never enters the tables.
   */
  keeps(role: Role, standard: string): boolean {
    return role !== "account" || standard === "tredio-account";
  }
}
