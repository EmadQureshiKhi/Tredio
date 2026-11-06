import { InferenceClient } from "@nearai/inference-sdk/node";
import { HttpError } from "../sources/http";
import { checkReviewBodies, type ReviewEvidence, type SignedReview } from "./evidence";
import type { Provider, Schema } from "./providers";

/**
 * NEAR AI Cloud models running in TEEs (Intel TDX with NVIDIA confidential GPUs). Every answer is
 * checked with the SDK's `verifyResponse()`: the response signature must match the exact request
 * and response bytes and come from a signer whose attestation verified. Tredio writes the request
 * JSON itself and reads the response body as received, so it keeps exactly the bytes the signature
 * covers: the evidence and both bodies are stored, the evidence's SHA-256 (`reviewHash`) is what
 * the registry stores with a listing, and anyone can fetch the bundle (/v1/reviews/<hash>),
 * recompute the hashes (ai/evidence.ts) and re-check the signer at https://cloud.near.ai/verify.
 */

export const VERIFY_URL = "https://cloud.near.ai/verify";

/** The SDK's verified result for one completion, as far as Tredio reads it. */
export interface VerifiedSignature {
  signatureKind: "provider_tee" | "gateway";
  signature: { signedText: string; signature: string; signer: { signingAlgo: string; signingAddress: string } };
}

export interface NearAiClient {
  /**
   * POSTs `requestJson`, unchanged, to chat/completions through the SDK's verified transport
   * (attestation preflight, the bytes kept for `verifyResponse`) and returns the raw response.
   */
  complete(requestJson: string): Promise<Response>;
  verifyResponse(id: string): Promise<VerifiedSignature>;
}

export function nearAiClient(apiKey: string, baseURL: string): NearAiClient {
  // Ed25519 is the SDK's default; named so a change of default cannot change the evidence's format.
  const sdk = new InferenceClient({ apiKey, baseUrl: baseURL, signingAlgo: "ed25519" });
  const url = new URL("chat/completions", sdk.getBaseUrl()).toString();
  return {
    complete: (requestJson) => sdk.fetch(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: requestJson }),
    verifyResponse: (id) => sdk.verifyResponse(id),
  };
}

/** The body as text, refusing bytes that are not UTF-8 so the text re-encodes to exactly what was signed. */
async function exactText(provider: string, res: Response): Promise<string> {
  const bytes = await res.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${provider}: response is not UTF-8`);
  }
}

function parseJsonText(provider: string, text: unknown): unknown {
  if (typeof text !== "string" || text.length === 0) throw new Error(`${provider}: empty response`);
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`${provider}: response is not JSON`);
  }
}

/** A verifiable NEAR AI Cloud model as a review provider. Answers that fail verification are refused. */
export function nearAi(client: NearAiClient, model: string, now: () => Date = () => new Date()): Provider {
  const name = `near-ai:${model}`;
  return {
    name,
    async generate(system: string, user: string, schema: Schema) {
      const request = JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `${user}\n\nAnswer with JSON only, matching this schema:\n${JSON.stringify(schema)}` },
        ],
        response_format: { type: "json_object" },
      });
      let res: Response;
      try {
        res = await client.complete(request);
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (typeof status === "number") throw new HttpError(name, status, String((e as Error).message ?? ""));
        throw e;
      }
      if (!res.ok) throw new HttpError(name, res.status, await res.text().catch(() => ""));
      // Read to the end before verifying: the SDK keeps the response bytes once the body completes.
      const response = await exactText(name, res);
      let completion: { id?: unknown; choices?: Array<{ message?: { content?: string | null } }> };
      try {
        completion = JSON.parse(response);
      } catch {
        throw new Error(`${name}: completion is not JSON`);
      }
      if (typeof completion.id !== "string" || completion.id.length === 0) throw new Error(`${name}: completion has no id`);
      const value = parseJsonText(name, completion.choices?.[0]?.message?.content);
      const v = await client.verifyResponse(completion.id);
      const evidence: ReviewEvidence = {
        provider: "near-ai-cloud",
        model,
        completionId: completion.id,
        signatureKind: v.signatureKind,
        signingAlgo: v.signature.signer.signingAlgo,
        signingAddress: v.signature.signer.signingAddress,
        signedText: v.signature.signedText,
        signature: v.signature.signature,
        verifiedAt: now().toISOString(),
        verifyUrl: VERIFY_URL,
      };
      if (evidence.signatureKind !== "provider_tee") throw new Error(`${name}: not signed by a model enclave`);
      // The SDK checked the signature over the bytes its transport saw; these are the bodies Tredio
      // stores and serves, so they must hash to the same signed text or nobody could re-check them.
      const review: SignedReview = { evidence, request, response };
      if (!checkReviewBodies(evidence, review).ok) throw new Error(`${name}: the signed text does not cover this request and response`);
      return { value, review };
    },
  };
}
