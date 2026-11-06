import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58Decode, failureOf } from "@tredio/chain";
import { type Checkpoint, type Deployment, explorerTx, indexPoints, type OracleConfig, parseEvents, type Report } from "@tredio/contracts";
import type { FinalExecutionOutcome } from "near-kit";
import type { ChainViews, TxIndex } from "./chain";

/**
 * Independent checks an agent can run instead of trusting the API:
 *
 * - `verifyIndex`: the registry's newest checkpoint of a trend came from a report signed by the
 *   oracle key the registry trusts, checked as the registry checks it (ed25519 over SHA-256 of
 *   the exact report JSON), in a transaction that succeeded and wrote that value.
 * - `checkReview`: a NEAR AI Cloud review's evidence hashes to the review hash the registry
 *   stores, and its ECDSA signature recovers the signing address the evidence names.
 */

const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** Whether `signatureB64` is the oracle key's ed25519 signature over SHA-256 of `reportJson`. */
export function reportSignatureValid(reportJson: string, signatureB64: string, publicKey: string): boolean {
  try {
    const key = base58Decode(publicKey.replace(/^ed25519:/, ""));
    const sig = new Uint8Array(Buffer.from(signatureB64, "base64"));
    return key.length === 32 && sig.length === 64 && ed25519.verify(sig, sha256(utf8(reportJson)), key);
  } catch {
    return false;
  }
}

export interface IndexVerification {
  identifier: string;
  verified: boolean;
  /** Why it is not verified, when it is not. */
  reason?: string;
  checkpoint: { at: number; index: number; raw: number } | null;
  oracle: { publicKey: string; deploymentKey: string; sameAsDeployment: boolean } | null;
  report?: {
    transaction: string;
    explorer: string;
    signer: string;
    runId: number;
    observedAt: number;
    /** What the report proposed (index points), and what the registry applied after its move limit. */
    proposedIndex: number;
    appliedIndex: number | null;
    clamped: boolean;
  };
  checks?: { signature: boolean; transactionSucceeded: boolean; observedAtMatches: boolean; indexWritten: boolean };
}

/** How many recent registry transactions are searched for the report. */
export const REPORT_SEARCH_DEPTH = 120;

export async function verifyIndex(o: { identifier: string; chain: ChainViews; txIndex: TxIndex; deployment: Deployment; network: "testnet" | "mainnet"; depth?: number }): Promise<IndexVerification> {
  const registry = o.deployment.contracts.registry;
  const [history, oracle] = await Promise.all([o.chain.view<Checkpoint[]>(registry, "history", { id: o.identifier }), o.chain.view<OracleConfig>(registry, "get_oracle", {})]);
  const last = history.at(-1);
  const publicKey = oracle.tee_signer.public_key;
  const oracleInfo = { publicKey, deploymentKey: o.deployment.oracle.publicKey, sameAsDeployment: publicKey === o.deployment.oracle.publicKey };
  if (!last) return { identifier: o.identifier, verified: false, reason: "the registry has no checkpoint for this trend", checkpoint: null, oracle: oracleInfo };
  const checkpoint = { at: last.at, index: indexPoints(last.index), raw: last.index };
  // Find the report: a submit_report whose observation time is the checkpoint's and that names the trend.
  let found: { hash: string; signer: string } | null = null;
  let searched = 0;
  for await (const tx of o.txIndex.recent(registry, o.depth ?? REPORT_SEARCH_DEPTH)) {
    searched++;
    const call = tx.calls.find((c) => c.methodName === "submit_report");
    if (!call) continue;
    try {
      const args = JSON.parse(Buffer.from(call.args, "base64").toString("utf8")) as { report_json: string };
      const r = JSON.parse(args.report_json) as Report;
      if (r.observed_at === last.at && (r.updates.some((u) => u.id === o.identifier) || r.new_trends.some((n) => n.identifier === o.identifier))) {
        found = { hash: tx.hash, signer: tx.signerId };
        break;
      }
    } catch {
      // Not a report this tool can read; keep looking.
    }
  }
  if (!found) return { identifier: o.identifier, verified: false, reason: `no report for this checkpoint among the registry's last ${searched} transactions`, checkpoint, oracle: oracleInfo };
  // Everything below is read from RPC, not from the index.
  const outcome = await o.chain.rpc<FinalExecutionOutcome & { transaction: { actions: Array<{ FunctionCall?: { method_name: string; args: string } }> } }>("EXPERIMENTAL_tx_status", { tx_hash: found.hash, sender_account_id: found.signer, wait_until: "FINAL" });
  const fc = outcome.transaction.actions.find((a) => a.FunctionCall?.method_name === "submit_report")?.FunctionCall;
  if (!fc || outcome.transaction.receiver_id !== registry) return { identifier: o.identifier, verified: false, reason: "the located transaction is not a report to the registry", checkpoint, oracle: oracleInfo };
  const args = JSON.parse(Buffer.from(fc.args, "base64").toString("utf8")) as { report_json: string; signature: string };
  const report = JSON.parse(args.report_json) as Report;
  const proposed = report.updates.find((u) => u.id === o.identifier)?.index ?? report.new_trends.find((n) => n.identifier === o.identifier)?.index ?? 0;
  // The registry logs what it applied: index_updated (or trend_created for a listing), and index_clamped when it limited the move.
  const events = (outcome.receipts_outcome ?? []).filter((r) => r.outcome.executor_id === registry).flatMap((r) => parseEvents(r.outcome.logs)).filter((e) => e.standard === "tredio-registry");
  const data = (e: { data: unknown }) => (Array.isArray(e.data) ? e.data[0] : e.data) as { id?: string; index?: number; observed_at?: number };
  const written = events.find((e) => (e.event === "index_updated" || e.event === "trend_created") && data(e).id === o.identifier);
  const applied = written ? (data(written).index ?? null) : null;
  const checks = {
    signature: reportSignatureValid(args.report_json, args.signature, publicKey),
    transactionSucceeded: failureOf(outcome) === null,
    observedAtMatches: report.observed_at === last.at,
    indexWritten: applied === last.index,
  };
  const verified = Object.values(checks).every(Boolean);
  return {
    identifier: o.identifier,
    verified,
    ...(verified ? {} : { reason: `failed: ${Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(", ")}${oracleInfo.sameAsDeployment ? "" : " (the registry's oracle key changed since this deployment file; an older report verifies only against the key of its time)"}` }),
    checkpoint,
    oracle: oracleInfo,
    report: {
      transaction: found.hash,
      explorer: explorerTx(o.network, found.hash),
      signer: found.signer,
      runId: report.run_id,
      observedAt: report.observed_at,
      proposedIndex: indexPoints(proposed),
      appliedIndex: applied === null ? null : indexPoints(applied),
      clamped: applied !== null && applied !== proposed,
    },
    checks,
  };
}

/** The NEAR AI Cloud evidence stored for a review (backend `ai/nearai.ts` ReviewEvidence). */
export interface ReviewEvidence {
  provider: string;
  model: string;
  completionId: string;
  signatureKind: string;
  signingAlgo: string;
  signingAddress: string;
  signedText: string;
  signature: string;
  verifiedAt: string;
  verifyUrl: string;
}

/** The review hash: SHA-256 (hex) of the evidence's JSON with its keys sorted, as the backend computes it. */
export function reviewHashOf(e: ReviewEvidence): string {
  const keys = Object.keys(e).sort();
  return hex(sha256(utf8(JSON.stringify(e, keys))));
}

/** The Ethereum address that signed `text` as a personal message (`personal_sign`: keccak-256 of the "\x19Ethereum Signed Message" prefix, the length and the text), or null. */
export function recoverSigner(text: string, signatureHex: string): string | null {
  try {
    const sig = Buffer.from(signatureHex.replace(/^0x/, ""), "hex");
    if (sig.length !== 65) return null;
    const v = sig[64]! >= 27 ? sig[64]! - 27 : sig[64]!;
    const body = utf8(text);
    const digest = keccak_256(new Uint8Array([...utf8(`\x19Ethereum Signed Message:\n${body.length}`), ...body]));
    const point = secp256k1.Signature.fromBytes(new Uint8Array(sig.subarray(0, 64)), "compact").addRecoveryBit(v).recoverPublicKey(digest);
    return `0x${hex(keccak_256(point.toBytes(false).subarray(1)).subarray(12))}`;
  } catch {
    return null;
  }
}

export function checkReview(hash: string, e: ReviewEvidence): { hashMatches: boolean; recoveredSigner: string | null; signatureMatchesSigner: boolean } {
  const recovered = e.signingAlgo.toLowerCase() === "ecdsa" ? recoverSigner(e.signedText, e.signature) : null;
  return { hashMatches: reviewHashOf(e) === hash.toLowerCase(), recoveredSigner: recovered, signatureMatchesSigner: recovered !== null && recovered.toLowerCase() === e.signingAddress.toLowerCase() };
}
