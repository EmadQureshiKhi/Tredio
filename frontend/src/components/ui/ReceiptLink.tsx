"use client";
import { useQuery } from "@tanstack/react-query";
import { txOfReceipt } from "@/lib/chain/client";
import { explorerTx } from "@/lib/config";
import { ExplorerLink } from "./ExplorerLink";

/**
 * The explorer link for something the indexer recorded by receipt: the receipt's transaction,
 * looked up once (it never changes). Until the lookup answers it renders the same room, empty.
 */
export function ReceiptLink({ receipt, className, testId, children }: { receipt: string; className?: string; testId?: string; children?: React.ReactNode }) {
  const tx = useQuery({ queryKey: ["receipt-tx", receipt], queryFn: () => txOfReceipt(receipt), staleTime: Infinity, gcTime: Infinity, retry: 1 });
  if (!tx.data) return <span className={className} aria-hidden />;
  return (
    <ExplorerLink href={explorerTx(tx.data.hash)} size="icon" className={className} testId={testId}>
      {children}
    </ExplorerLink>
  );
}
