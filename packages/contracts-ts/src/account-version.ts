/**
 * Account code versions. v1, the code accounts are born on, has no `version` view; v2 reports 2.
 * A caller reads an account's version once (cached per account) and picks from it what differs
 * between them: the gas a session call attaches, how old a Hyperliquid mark the order guard
 * accepts and whether it binds the mark to the order's asset index, and how sessions renew and
 * revoke. Choosing v1 for a v2 account is always safe (more gas, a stricter mark age, a new key on
 * renewal, no asset index check before the contract's own); the reverse is not, so anything
 * uncertain reads as v1.
 */
import { SESSION_CALL_TGAS_V1, SESSION_CALL_TGAS_V2 } from "./calls";
import type { Deployment } from "./deployments";
import type { OwnerAction } from "./types";

/** An account code version: 1 (no `version` view) or what `version` reports. */
export type AccountVersion = number;

/** Oldest Hyperliquid mark the account's order guard accepts (`HL_MARK_MAX_AGE`), seconds. */
export const HL_MARK_MAX_AGE_V1 = 120;
export const HL_MARK_MAX_AGE_V2 = 300;

/** Tgas a `session_call` attaches on an account of version `v`. */
export const sessionCallTgas = (v: AccountVersion) => (v >= 2 ? SESSION_CALL_TGAS_V2 : SESSION_CALL_TGAS_V1);
/**
 * yoctoNEAR a gas key reserves while one session call of an account of version `v` is in flight:
 * prepaid gas is bought at 1e9 yocto a gas unit, so 0.3 NEAR on v1 (300 Tgas) and 0.15 on v2.
 */
export const sessionCallPrepaid = (v: AccountVersion) => BigInt(sessionCallTgas(v)) * 10n ** 21n;
/** Oldest mark (seconds) the order guard of an account of version `v` accepts. */
export const hlMarkMaxAge = (v: AccountVersion) => (v >= 2 ? HL_MARK_MAX_AGE_V2 : HL_MARK_MAX_AGE_V1);
/**
 * v2 renews a session for a key the account already holds in place, so a gas key keeps its
 * prepaid gas, and keeps a revoked gas key on the account, dormant, instead of deleting it (which
 * burns its balance). v1 does neither: renewing takes a new key and revoking deletes the key.
 */
export const keepsGasKeys = (v: AccountVersion) => v >= 2;
/** v2's order guard refuses an order whose `asset_index` is not the mark's, and any order when the mark has none. */
export const bindsMarkToAssetIndex = (v: AccountVersion) => v >= 2;
/**
 * Whether the account accepts a `session_call` sent directly by the implicit account of one of its
 * session keys: how a policy wallet acts for the account, since its key, held in a custody enclave,
 * signs only for its own implicit account. v1 and v2 accept session calls only from the account
 * itself (`session keys only`); account code that also accepts these reports version 3.
 */
export const acceptsWalletSessions = (v: AccountVersion) => v >= 3;

/**
 * Whether a failed `version` view means the contract ran and has no such method (v1 code), as
 * opposed to an RPC failure or an account that does not exist yet. Nodes say it in the view's
 * error text (`MethodResolveError(MethodNotFound)`) or as a `CONTRACT_EXECUTION_ERROR`; `version`
 * itself never fails on v2.
 */
export function isMissingMethod(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e);
  return /MethodNotFound|MethodResolveError|CONTRACT_EXECUTION_ERROR/.test(m);
}

/** The `version` view's answer as a version; anything but a whole number from 2 up is v1. */
export const versionFrom = (answer: unknown): AccountVersion => (typeof answer === "number" && Number.isInteger(answer) && answer >= 2 ? answer : 1);

export interface AccountVersionsOptions {
  /** How long an answer holds (ms), so a long-running service notices an upgrade. Ten minutes by default. */
  ttlMs?: number;
  now?: () => number;
}

/**
 * Account versions, read with each account's `version` view and cached per account. Any error
 * reads as v1, but only an answer the contract gave (a version, or no such method) is cached: a
 * rate-limited read, or an account that does not exist yet, is asked again next time. Concurrent
 * reads of one account share one view call.
 */
export class AccountVersions {
  private readonly cache = new Map<string, { version: AccountVersion; at: number }>();
  private readonly reading = new Map<string, Promise<AccountVersion>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly readVersion: (account: string) => Promise<unknown>,
    opts: AccountVersionsOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 600_000;
    this.now = opts.now ?? Date.now;
  }

  /** The account's version: cached, or read now. */
  of(account: string): Promise<AccountVersion> {
    const hit = this.cache.get(account);
    if (hit && this.now() - hit.at < this.ttlMs) return Promise.resolve(hit.version);
    let r = this.reading.get(account);
    if (!r) {
      r = this.read(account).finally(() => this.reading.delete(account));
      this.reading.set(account, r);
    }
    return r;
  }

  /** The cached version, without reading; null when there is none. */
  known(account: string): AccountVersion | null {
    const hit = this.cache.get(account);
    return hit && this.now() - hit.at < this.ttlMs ? hit.version : null;
  }

  /** Forgets `account`, so the next `of` reads again (after it upgraded). */
  forget(account: string): void {
    this.cache.delete(account);
  }

  private async read(account: string): Promise<AccountVersion> {
    try {
      const version = versionFrom(await this.readVersion(account));
      this.cache.set(account, { version, at: this.now() });
      return version;
    } catch (e) {
      if (isMissingMethod(e)) this.cache.set(account, { version: 1, at: this.now() });
      return 1;
    }
  }
}

/** The code hashes a Tredio account may run: the factory's birth code (v1) and every later version deployments names. */
export const accountCodeHashes = (d: Deployment): string[] => [d.globalCode.account, ...[d.globalCode.accountV2, d.globalCode.accountV3].filter((h): h is string => Boolean(h))];

/** The newest account code deployments names, with its version, or null while accounts have only their birth code. */
export function latestAccountCode(d: Deployment): { version: AccountVersion; hash: string } | null {
  if (d.globalCode.accountV3) return { version: 3, hash: d.globalCode.accountV3 };
  if (d.globalCode.accountV2) return { version: 2, hash: d.globalCode.accountV2 };
  return null;
}

/** The owner action that moves an account to the newest code, or null while deployments names none past the birth code. */
export const upgradeToLatest = (d: Deployment): OwnerAction | null => {
  const latest = latestAccountCode(d);
  return latest ? { upgrade: { code_hash: latest.hash } } : null;
};
