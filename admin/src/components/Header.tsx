"use client";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircle, LogOut } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { api } from "@/src/lib/api";
import { signOut, useSession } from "@/src/lib/auth/session";
import { formatDate, shortAddress } from "@/src/lib/format";
import { candidatesKey } from "@/src/modules/candidates/queries";

const LINKS = [
  { href: "/system", label: "System" },
  { href: "/candidates", label: "Candidates" },
  { href: "/rotation", label: "Live board" },
  { href: "/operations", label: "Operations" },
  { href: "/waitlist", label: "Waitlist" },
] as const;

function Logo() {
  return (
    <Link href="/system" className="flex shrink-0 items-center gap-2 rounded-md" aria-label="Tredio admin home">
      <svg viewBox="0 0 32 32" className="h-5 w-auto text-accent" aria-hidden>
        <text x="16" y="25" fill="currentColor" className="font-strong" fontSize="26" textAnchor="middle">
          T
        </text>
      </svg>
      <span className="text-[15px] font-semibold tracking-tight text-fg">tredio</span>
      <span className="rounded border border-accent/30 bg-accent-soft px-1.5 py-px font-mono text-[10px] font-semibold uppercase tracking-wide text-accent">
        admin
      </span>
    </Link>
  );
}

function NavLinks({ layout }: { layout: "inline" | "bar" }) {
  const pathname = usePathname();
  const pending = useQuery({ queryKey: candidatesKey("pending"), queryFn: () => api.candidates("pending") });
  const pendingCount = pending.data?.length ?? 0;

  return (
    <nav aria-label="Main" className={layout === "inline" ? "flex items-center gap-1" : "flex h-11 items-stretch"}>
      {LINKS.map((link) => {
        const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
        const count = link.href === "/candidates" && pendingCount > 0 ? pendingCount : null;
        const base = "flex items-center justify-center gap-2 text-sm font-medium transition-colors";
        const style =
          layout === "inline"
            ? `${base} h-8 rounded-md px-3 ${active ? "bg-raised text-fg" : "text-muted hover:bg-raised hover:text-fg"}`
            : `${base} flex-auto border-b-2 px-1.5 ${active ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"}`;
        return (
          <Link key={link.href} href={link.href} aria-current={active ? "page" : undefined} className={style}>
            {link.label}
            {count !== null && (
              <>
                <span aria-hidden className="min-w-5 rounded-full bg-warn-soft px-1.5 text-center text-[11px] font-semibold leading-5 text-warn tabular-nums">
                  {count}
                </span>
                <span className="sr-only">({count} pending)</span>
              </>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

export default function Header() {
  const { session, signingOut } = useSession();

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-canvas/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Logo />
        {session && (
          <div className="hidden sm:block">
            <NavLinks layout="inline" />
          </div>
        )}
        <div className="flex-1" />
        {session && (
          <div className="flex items-center gap-2">
            <span
              className="flex h-8 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 font-mono text-[13px] text-fg"
              title={`Signed in as ${session.address} until ${formatDate(session.expiresAt * 1000)}`}
              data-testid="session-address"
            >
              <span aria-hidden className="size-2 rounded-full bg-ok" />
              {shortAddress(session.address)}
            </span>
            <button
              type="button"
              onClick={() => void signOut()}
              disabled={signingOut}
              aria-busy={signingOut || undefined}
              className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-60"
            >
              {signingOut ? <LoaderCircle size={15} className="animate-spin" aria-hidden /> : <LogOut size={15} aria-hidden />}
              <span className="sr-only sm:not-sr-only">Sign out</span>
            </button>
          </div>
        )}
      </div>
      {session && (
        <div className="mx-auto max-w-6xl border-t border-line px-4 sm:hidden">
          <NavLinks layout="bar" />
        </div>
      )}
    </header>
  );
}
