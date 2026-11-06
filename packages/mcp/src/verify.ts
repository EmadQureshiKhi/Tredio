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
 *   stores, its signature (ECDSA or Ed25519) is the signing address's over the signed text, and
 *   (`checkReviewBodies`) the request and response bodies the API serves hash into that text.
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

/** The NEAR AI Cloud evidence stored for a review (backend `ai/evidence.ts` ReviewEvidence). */
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

/** Whether `signatureHex` is the Ed25519 signature of the key `publicKeyHex` (32 bytes) over the UTF-8 bytes of `text`. */
export function ed25519SignatureValid(text: string, signatureHex: string, publicKeyHex: string): boolean {
  try {
    const sig = Buffer.from(signatureHex.replace(/^0x/i, ""), "hex");
    const key = Buffer.from(publicKeyHex.replace(/^0x/i, ""), "hex");
    return sig.length === 64 && key.length === 32 && ed25519.verify(new Uint8Array(sig), utf8(text), new Uint8Array(key));
  } catch {
    return false;
  }
}

/** The exact bodies a review's signature covers, as GET /v1/reviews/<hash> serves them. */
export interface ReviewBodies {
  request: string;
  response: string;
}

/** What `checkReviewBodies` recomputed and compared. */
export interface ReviewBodiesCheck {
  /** SHA-256 (hex) of the exact UTF-8 bytes of the request and of the response. */
  requestHash: string;
  responseHash: string;
  /** The model the request names, or null when the request is not JSON with a string `model`. */
  requestModel: string | null;
  /** The text the signer must have signed for these bodies. */
  expectedText: string;
  requestHashMatches: boolean;
  responseHashMatches: boolean;
  /** The request asked the model the evidence names. */
  modelMatches: boolean;
  /** `signedText` is exactly `expectedText`: the signature covers these bodies. */
  signedTextMatches: boolean;
  ok: boolean;
}

/**
 * Recomputes the request and response hashes from the bodies and checks them against the signed
 * text, which NEAR AI Cloud forms as `<model>:<sha256(request)>:<sha256(response)>` for a model
 * enclave (`provider_tee`) and `<sha256(request)>:<sha256(response)>` for the gateway. The same
 * check as the backend's `checkReviewBodies` (ai/evidence.ts), written again here so this server
 * trusts nothing of the API's.
 */
export function checkReviewBodies(e: Pick<ReviewEvidence, "model" | "signatureKind" | "signedText">, b: ReviewBodies): ReviewBodiesCheck {
  const requestHash = hex(sha256(utf8(b.request)));
  const responseHash = hex(sha256(utf8(b.response)));
  let requestModel: string | null = null;
  try {
    const model = (JSON.parse(b.request) as { model?: unknown } | null)?.model;
    requestModel = typeof model === "string" ? model : null;
  } catch {
    // Not JSON: no model, and nothing matches.
  }
  const enclave = e.signatureKind === "provider_tee";
  const expectedText = enclave ? `${requestModel ?? ""}:${requestHash}:${responseHash}` : `${requestHash}:${responseHash}`;
  // The hashes are the last two fields; a model id may itself contain a colon.
  const fields = e.signedText.split(":");
  const requestHashMatches = fields.length >= 2 && fields.at(-2) === requestHash;
  const responseHashMatches = fields.length >= 2 && fields.at(-1) === responseHash;
  const modelMatches = requestModel !== null && requestModel === e.model;
  const signedTextMatches = (!enclave || requestModel !== null) && e.signedText === expectedText;
  return { requestHash, responseHash, requestModel, expectedText, requestHashMatches, responseHashMatches, modelMatches, signedTextMatches, ok: requestHashMatches && responseHashMatches && modelMatches && signedTextMatches };
}

export interface ReviewCheck {
  /** The evidence hashes to the review hash asked for. */
  hashMatches: boolean;
  /** ECDSA only: the address the signature recovers. */
  recoveredSigner: string | null;
  /** The signature is the named signer's over the signed text (ECDSA or Ed25519). */
  signatureMatchesSigner: boolean;
  /** The bodies recomputed against the signed text; null when the API serves none. */
  bodies: ReviewBodiesCheck | null;
}

export function checkReview(hash: string, e: ReviewEvidence, bodies: ReviewBodies | null = null): ReviewCheck {
  const algo = e.signingAlgo.toLowerCase();
  const recovered = algo === "ecdsa" ? recoverSigner(e.signedText, e.signature) : null;
  const signatureMatchesSigner = algo === "ecdsa" ? recovered !== null && recovered.toLowerCase() === e.signingAddress.toLowerCase() : algo === "ed25519" && ed25519SignatureValid(e.signedText, e.signature, e.signingAddress);
  return { hashMatches: reviewHashOf(e) === hash.toLowerCase(), recoveredSigner: recovered, signatureMatchesSigner, bodies: bodies ? checkReviewBodies(e, bodies) : null };
}
