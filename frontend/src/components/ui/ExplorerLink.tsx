import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { EXPLORER_NAME } from "@/lib/config";
import { cn } from "./cn";

/**
 * A link to the block explorer. `full` reads "View on" and the explorer's name where there is
 * room, `short` is the icon and the name, and `icon` the icon alone for the densest rows (its
 * label stays for screen readers and as a tooltip).
 */
export function ExplorerLink({ href, size = "full", className, children, testId }: { href: string; size?: "full" | "short" | "icon"; className?: string; children?: ReactNode; testId?: string }) {
  const label = `View on ${EXPLORER_NAME}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      data-testid={testId}
      aria-label={size === "icon" && !children ? label : undefined}
      title={size === "icon" || children ? label : undefined}
      className={cn("inline-flex items-center gap-1.5 text-text-3 transition-colors hover:text-text", className)}
    >
      {children ?? (size === "icon" ? null : <span>{size === "full" ? label : EXPLORER_NAME}</span>)}
      <ExternalLink className="size-3.5 shrink-0" aria-hidden />
    </a>
  );
}
