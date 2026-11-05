import { createHash } from "node:crypto";
import { InferenceClient } from "@nearai/inference-sdk/node";
import { HttpError } from "../sources/http";
import type { Provider, Schema } from "./providers";

/**
 * NEAR AI Cloud models running in TEEs (Intel TDX with NVIDIA confidential GPUs). Every answer is
 * checked with the SDK's `verifyResponse()`: the response signature must match the exact request
 * and response bytes and come from a signer whose attestation verified. The signed evidence is
 * kept, and its SHA-256 (`reviewHash`) is what the registry stores with a listing, so anyone can
 * fetch the bundle (/v1/reviews/<hash>) and re-check it at https://cloud.near.ai/verify.
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
  /** The exact text the signer signed (hashes of the request and response). */
  signedText: string;
  signature: string;
  verifiedAt: string;
  verifyUrl: string;
}

export const VERIFY_URL = "https://cloud.near.ai/verify";

/** SHA-256 (hex) of the evidence's canonical JSON: the review hash stored on chain. */
export function reviewHash(e: ReviewEvidence): string {
  const keys = Object.keys(e).sort() as (keyof ReviewEvidence)[];
  return createHash("sha256").update(JSON.stringify(e, keys)).digest("hex");
}

export interface NearAiClient {
  chat: { completions: { create(body: Record<string, unknown>): Promise<{ id: string; choices?: Array<{ message?: { content?: string | null } }> }> } };
  verifyResponse(id: string): Promise<{ signatureKind: "provider_tee" | "gateway"; signature: { signedText: string; signature: string; signer: { signingAlgo: string; signingAddress: string } } }>;
}

export function nearAiClient(apiKey: string, baseURL: string): NearAiClient {
  return new InferenceClient({ apiKey, baseUrl: baseURL }) as unknown as NearAiClient;
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
      let completion;
      try {
        completion = await client.chat.completions.create({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: `${user}\n\nAnswer with JSON only, matching this schema:\n${JSON.stringify(schema)}` },
          ],
          response_format: { type: "json_object" },
        });
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (typeof status === "number") throw new HttpError(name, status, String((e as Error).message ?? ""));
        throw e;
      }
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
      return { value, evidence };
    },
  };
}
