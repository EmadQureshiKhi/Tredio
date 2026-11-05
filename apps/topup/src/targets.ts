/**
 * What the top-up service keeps funded, from comma-separated entries:
 *
 * - NEAR on an account: `name=account@min/target` (NEAR amounts), for example
 *   `relayer=tredio-relayer.testnet@2/5`.
 * - NEAR in a gas key: `name=account/ed25519:<key>@min/target`; the treasury funds the key directly.
 * - Testnet USDC: `name=account@min/target` in USDC_TARGETS, minted by the USDC minter account.
 */

export type Kind = "near" | "gasKey" | "usdc";

export interface Target {
  name: string;
  kind: Kind;
  account: string;
  publicKey: string | null;
  /** Raw units: yoctoNEAR, or USDC with 6 decimals. */
  min: bigint;
  target: bigint;
}

export const NEAR = 10n ** 24n;
export const USDC = 10n ** 6n;

function amount(v: string, unit: bigint): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(v)) throw new Error(`bad amount "${v}"`);
  const [whole, frac = ""] = v.split(".");
  return BigInt(whole!) * unit + (BigInt(frac.padEnd(6, "0")) * unit) / 1_000_000n;
}

export function parseTargets(value: string | undefined, kind: "near" | "usdc"): Target[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const m = /^([a-z0-9_-]+)=([a-z0-9._-]+)(?:\/(ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}))?@([\d.]+)\/([\d.]+)$/.exec(entry);
      if (!m) throw new Error(`bad target "${entry}" (name=account[/ed25519:key]@min/target)`);
      const unit = kind === "usdc" ? USDC : NEAR;
      const t: Target = { name: m[1]!, kind: m[3] ? "gasKey" : kind, account: m[2]!, publicKey: m[3] ?? null, min: amount(m[4]!, unit), target: amount(m[5]!, unit) };
      if (t.kind === "gasKey" && kind === "usdc") throw new Error(`USDC targets have no gas key: "${entry}"`);
      if (t.target <= t.min) throw new Error(`target "${entry}": the target must be above the minimum`);
      return t;
    });
}

/** Decimal text of a raw amount (six decimals at most). */
export function format(raw: bigint, unit: bigint): string {
  const whole = raw / unit;
  const frac = (((raw % unit) * 1_000_000n) / unit).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
