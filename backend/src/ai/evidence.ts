import { createHash } from "node:crypto";

/**
 * A NEAR AI Cloud review as Tredio stores and serves it, and the checks anyone can run on it with
 * no SDK and no API key.
 *
 * NEAR AI Cloud signs `signedText`. For an answer signed inside the model's enclave
 * (`provider_tee`) it is `<model>:<request hash>:<response hash>`; for one only the gateway signed
 * (`gateway`) it is `<request hash>:<response hash>`. Each hash is the lowercase hex SHA-256 of the
 * exact UTF-8 bytes: the request JSON as sent to POST /v1/chat/completions, and the response body
 * as received. Tredio keeps both bodies beside the evidence (GET /v1/reviews/<hash>), so
 * `checkReviewBodies` recomputes the two hashes and shows what the model was asked and answered.
 * The review hash the registry stores is the SHA-256 of the evidence, which holds `signedText`, so
 * it commits to the bodies as well.
 */

/** What one verified completion proves. */
export interface ReviewEvidence {
  provider: "near-ai-cloud";
  model: string;
  completionId: string;
  /** `provider_tee`: signed by the attested model enclave; `gateway`: by the attested gateway only. */
  signatureKind: "provider_tee" | "gateway";
  signingAlgo: string;
  signingAddress: string;
  /** The exact text the signer signed (the model and the hashes of the request and response). */
  signedText: string;
  signature: string;
  verifiedAt: string;
  verifyUrl: string;
}

/** The exact bodies a review's signature covers. */
export interface ReviewBodies {
  /** The request JSON exactly as sent to NEAR AI Cloud. */
  request: string;
  /** The response body exactly as received. */
  response: string;
}

/** A verified review: its evidence and the bodies its signature covers. */
export interface SignedReview extends ReviewBodies {
  evidence: ReviewEvidence;
}

/** What `checkReviewBodies` recomputed and compared. */
export interface ReviewBodiesCheck {
  /** SHA-256 (hex) of the request and of the response, recomputed from the bodies. */
  requestHash: string;
  responseHash: string;
  /** The model the request names, or null when the request is not JSON with a string `model`. */
  requestModel: string | null;
  /** The text the signer must have signed for these bodies. */
  expectedText: string;
  /** Each recomputed hash is the one in `signedText`. */
  requestHashMatches: boolean;
  responseHashMatches: boolean;
  /** The request asked the model the evidence names. */
  modelMatches: boolean;
  /** `signedText` is exactly `expectedText`: the signature covers these bodies. */
  signedTextMatches: boolean;
  /** Every check above holds. */
  ok: boolean;
}

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** SHA-256 (hex) of the evidence's canonical JSON (keys sorted): the review hash stored on chain. */
export function reviewHash(e: ReviewEvidence): string {
  const keys = Object.keys(e).sort() as (keyof ReviewEvidence)[];
  return sha256Hex(JSON.stringify(e, keys));
}

function modelOf(request: string): string | null {
  try {
    const model = (JSON.parse(request) as { model?: unknown } | null)?.model;
    return typeof model === "string" ? model : null;
  } catch {
    return null;
  }
}

/**
 * Recomputes the request and response hashes from the bodies and checks them against the
 * evidence's `signedText`, as NEAR AI Cloud's SDK does before it accepts a signature. Pure: it
 * checks what was signed, not the signature itself or the signer's attestation.
 */
export function checkReviewBodies(e: Pick<ReviewEvidence, "model" | "signatureKind" | "signedText">, b: ReviewBodies): ReviewBodiesCheck {
  const requestHash = sha256Hex(b.request);
  const responseHash = sha256Hex(b.response);
  const requestModel = modelOf(b.request);
  // A model enclave signs the model the request names (the SDK reads it from the request too).
  const enclave = e.signatureKind === "provider_tee";
  const expectedText = enclave ? `${requestModel ?? ""}:${requestHash}:${responseHash}` : `${requestHash}:${responseHash}`;
  // The hashes are the last two fields; a model id may itself contain a colon.
  const fields = e.signedText.split(":");
  const requestHashMatches = fields.length >= 2 && fields.at(-2) === requestHash;
  const responseHashMatches = fields.length >= 2 && fields.at(-1) === responseHash;
  const modelMatches = requestModel !== null && requestModel === e.model;
  const signedTextMatches = (!enclave || requestModel !== null) && e.signedText === expectedText;
  return {
    requestHash,
    responseHash,
    requestModel,
    expectedText,
    requestHashMatches,
    responseHashMatches,
    modelMatches,
    signedTextMatches,
    ok: requestHashMatches && responseHashMatches && modelMatches && signedTextMatches,
  };
}
