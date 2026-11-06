"use client";
import { Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button, cn } from "@/components/ui";
import { useAccount } from "./AccountProvider";

/**
 * What a screen that needs Tredio's API shows while the account is not signed in to it yet. A
 * passkey account signs in on its own with its session key, so it only waits. A wallet signs
 * Tredio's sign-in message when asked (one wallet prompt), so it gets a button.
 */
export function ApiSignIn({ purpose, className }: { purpose: string; className?: string }) {
  const account = useAccount();
  const [busy, setBusy] = useState(false);
  if (!account.authenticated || account.backendReady) return null;
  if (account.kind !== "wallet") {
    return (
      <p className={cn("flex items-center gap-2 text-[13px] text-text-3", className)} data-testid="api-connecting">
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> Connecting to Tredio
      </p>
    );
  }
  return (
    <div className={cn("flex flex-col gap-3 rounded-2xl border border-line p-4", className)} data-testid="api-sign-in">
      <p className="text-[13.5px] leading-5 text-text-2">Sign Tredio&rsquo;s sign-in message with your wallet {purpose}. It moves nothing.</p>
      <Button
        tone="secondary"
        loading={busy}
        icon={<RefreshCw className="size-4" aria-hidden />}
        onClick={async () => {
          setBusy(true);
          await account.syncBackend();
          setBusy(false);
        }}
      >
        Sign in to Tredio
      </Button>
      {account.error ? <p className="text-[12.5px] text-down">{account.error}</p> : null}
    </div>
  );
}
