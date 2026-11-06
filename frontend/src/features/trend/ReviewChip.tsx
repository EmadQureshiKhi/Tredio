"use client";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Button, ErrorNote, Row, Sheet, Skeleton } from "@/components/ui";
import { reviews } from "@/lib/api";
import { NEAR_AI_VERIFY_URL } from "@/lib/config";
import { shortAddress } from "@/lib/format";
import { copyText } from "@/lib/toast";

/** What one verified completion proves (backend/src/ai/nearai.ts ReviewEvidence). */
interface Evidence {
  provider?: string;
  model?: string;
  completionId?: string;
  signatureKind?: string;
  signingAlgo?: string;
  signingAddress?: string;
  signedText?: string;
  signature?: string;
  verifiedAt?: string;
  verifyUrl?: string;
}

/**
 * "Verified": the listing was approved by a verifiable model on NEAR AI Cloud. The registry stores
 * the hash of the signed evidence with the trend; this opens the evidence and links to NEAR AI
 * Cloud's verifier, where anyone can check the enclave's signature.
 */
export function ReviewChip({ hash }: { hash: string }) {
  const [open, setOpen] = useState(false);
  const review = useQuery({ queryKey: ["review", hash], queryFn: () => reviews.get(hash), enabled: open, staleTime: Infinity, retry: 1 });
  const e = (review.data?.evidence ?? null) as Evidence | null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-full border border-transparent bg-up-soft px-2.5 font-strong text-[11.5px] tracking-[0.01em] text-up transition-[filter] hover:brightness-95"
        data-testid="review-verified"
      >
        <ShieldCheck className="size-3" aria-hidden />
        Verified
      </button>
      <Sheet open={open} onOpenChange={setOpen} title="Verified AI review" description="A verifiable model on NEAR AI Cloud reviewed this listing inside a TEE and signed its answer. The registry stores the hash of that evidence with the trend." testId="review-sheet">
        <div className="flex flex-col gap-4">
          {review.isLoading ? (
            <Skeleton className="h-48 rounded-2xl" />
          ) : review.error ? (
            <ErrorNote message="The review's evidence could not load." onRetry={() => void review.refetch()} />
          ) : e ? (
            <>
              <div className="flex flex-col gap-2 rounded-xl border border-line px-3.5 py-3">
                <Row label="Model" value={e.model ?? "-"} />
                <Row label="Signed by" value={e.signatureKind === "provider_tee" ? "Model enclave (TEE)" : (e.signatureKind ?? "-")} />
                <Row label="Signing key" value={e.signingAddress ? shortAddress(e.signingAddress) : "-"} tone="muted" />
                <Row label="Algorithm" value={e.signingAlgo ?? "-"} tone="muted" />
                <Row label="Reviewed" value={e.verifiedAt ? new Date(e.verifiedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "-"} tone="muted" />
                <Row label="Evidence hash" value={shortAddress(hash)} tone="muted" />
              </div>
              <p className="text-[12.5px] leading-[18px] text-text-3">To check it yourself, open NEAR AI Cloud&rsquo;s verifier and paste the signed text, the signature and the signing key below.</p>
              <div className="grid grid-cols-2 gap-2">
                <Button tone="secondary" size="sm" disabled={!e.signedText} onClick={() => e.signedText && void copyText(e.signedText, "Signed text copied")}>
                  Copy signed text
                </Button>
                <Button tone="secondary" size="sm" disabled={!e.signature} onClick={() => e.signature && void copyText(e.signature, "Signature copied")}>
                  Copy signature
                </Button>
              </div>
              <Button tone="ghost" size="sm" onClick={() => void copyText(JSON.stringify(review.data?.evidence, null, 2), "Evidence copied")}>
                Copy the whole evidence
              </Button>
            </>
          ) : null}
          <a href={e?.verifyUrl ?? NEAR_AI_VERIFY_URL} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center gap-1.5 font-strong text-[13.5px] text-primary underline-offset-4 hover:underline">
            Check it at NEAR AI Cloud
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        </div>
      </Sheet>
    </>
  );
}
