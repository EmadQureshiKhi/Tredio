import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58Decode } from "@tredio/chain";
import type { EnclaveOutput } from "./outlayer";

/**
 * The checks before the registry trusts the enclave's key instead of the bootstrap key
 * (scripts/switch-oracle-key.ts runs them, then `set_oracle`). After the switch the registry takes
 * only reports the enclave build signed, so a build that cannot measure (its API unreachable, its
 * API token missing) would leave every trend without updates until the switch is undone: the
 * enclave must prove, in one live run, that it measures trends and signs with the expected key.
 */

export interface RunVerdict {
  ok: boolean;
  problems: string[];
  /** Trends the run measured (updates and new listings) and marks it carried. */
  measured: number;
  marks: number;
}

/** Judges one enclave run's output against the key the registry is about to trust. */
export function judgeRun(output: EnclaveOutput, expectedKey: string): RunVerdict {
  const problems: string[] = [];
  if (output.error) problems.push(`the enclave failed: ${output.error}`);
  if (!output.report_json || !output.signature || !output.public_key) {
    problems.push("the enclave returned no signed report");
    return { ok: false, problems, measured: 0, marks: 0 };
  }
  if (output.public_key !== expectedKey) problems.push(`the enclave signs with ${output.public_key}, not ${expectedKey}`);
  let signed = false;
  try {
    signed = ed25519.verify(Buffer.from(output.signature, "base64"), sha256(new TextEncoder().encode(output.report_json)), base58Decode(output.public_key.replace(/^ed25519:/, "")));
  } catch {
    signed = false;
  }
  if (!signed) problems.push("the report's signature does not verify under the enclave's key");
  let report: { updates?: unknown[]; new_trends?: unknown[]; marks?: unknown[] } = {};
  try {
    report = JSON.parse(output.report_json) as typeof report;
  } catch {
    problems.push("the report is not JSON");
  }
  const measured = (report.updates?.length ?? 0) + (report.new_trends?.length ?? 0);
  const marks = report.marks?.length ?? 0;
  // A run that measured nothing read no readings: its API (compiled into the build) did not answer it.
  if (measured === 0) problems.push(`the run measured no trend (only ${marks} marks): the enclave got no readings from its API`);
  for (const w of output.warnings ?? []) if (/api|backend|token|unauthor/i.test(w)) problems.push(`enclave warning: ${w}`);
  return { ok: problems.length === 0, problems, measured, marks };
}

/** The registry's `set_oracle` argument for an ed25519 key. */
export const teeSigner = (publicKey: string) => ({ oracle: { tee_signer: { public_key: publicKey } } });

/** `.env` text with `key` set to `value` (replaced in place, or appended). */
export function setEnv(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  return re.test(text) ? text.replace(re, line) : `${text.replace(/\n*$/, "\n")}${line}\n`;
}
