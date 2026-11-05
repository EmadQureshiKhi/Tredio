import type { Metadata } from "next";
import { ButtonLink, Fallback } from "@/components/ui";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <Fallback
      eyebrow="404"
      title="This page is not trending"
      body="It may have moved, or the link is mistyped. Every live market is one tap away."
      actions={
        <>
          <ButtonLink href="/">Back to markets</ButtonLink>
          <ButtonLink href="/portfolio" tone="secondary">
            Your portfolio
          </ButtonLink>
        </>
      }
    />
  );
}
