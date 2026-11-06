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

// The Tredio logo (sources in assets/brand, drawn by tools/make_brand_marks.py): the brush T in the accent and REDIO in the text color.
const LOGO_T = "M0 1.24C23.37 7.15 43.98 -4.55 57.94 2.13V15.53H37.55L34.26 70.83H14.66C14.66 70.83 12.35 27.38 30.99 15.53H0C0 15.5 0 5.81 0 1.24Z";
const LOGO_WORD =
  "M68.86 70.83V2.13H98.06Q109.07 2.13 114.06 3.98Q119.05 5.83 122.05 10.57Q125.05 15.3 125.05 21.39Q125.05 29.12 120.5 34.16Q115.96 39.2 106.91 40.51Q111.41 43.13 114.34 46.27Q117.27 49.41 122.24 57.43L130.62 70.83H114.04L104.01 55.88Q98.66 47.87 96.7 45.78Q94.73 43.7 92.53 42.92Q90.32 42.15 85.54 42.15H82.73V70.83H68.86ZM82.73 31.18H92.99Q102.98 31.18 105.46 30.34Q107.94 29.5 109.35 27.44Q110.75 25.37 110.75 22.28Q110.75 18.81 108.9 16.68Q107.05 14.55 103.68 13.99Q101.99 13.75 93.56 13.75H82.73V31.18ZM138.12 70.83V2.13H189.06V13.75H151.99V28.98H186.48V40.56H151.99V59.25H190.37V70.83H138.12ZM202.09 2.13H227.44Q236.01 2.13 240.51 3.44Q246.56 5.22 250.87 9.77Q255.18 14.31 257.43 20.9Q259.68 27.48 259.68 37.14Q259.68 45.62 257.57 51.76Q254.99 59.25 250.21 63.89Q246.6 67.41 240.47 69.38Q235.87 70.83 228.19 70.83H202.09V2.13ZM215.96 13.75V59.25H226.31Q232.13 59.25 234.7 58.6Q238.08 57.75 240.3 55.74Q242.53 53.72 243.93 49.11Q245.34 44.49 245.34 36.53Q245.34 28.56 243.93 24.3Q242.53 20.03 240 17.64Q237.47 15.25 233.58 14.41Q230.67 13.75 222.19 13.75H215.96ZM271.02 70.83V2.13H284.89V70.83H271.02ZM295.29 36.9Q295.29 26.4 298.43 19.28Q300.78 14.03 304.83 9.86Q308.88 5.69 313.71 3.68Q320.13 0.96 328.52 0.96Q343.7 0.96 352.81 10.38Q361.93 19.8 361.93 36.57Q361.93 53.21 352.89 62.6Q343.84 72 328.7 72Q313.38 72 304.34 62.65Q295.29 53.3 295.29 36.9ZM309.59 36.43Q309.59 48.1 314.97 54.12Q320.36 60.14 328.66 60.14Q336.95 60.14 342.27 54.17Q347.59 48.19 347.59 36.25Q347.59 24.44 342.41 18.62Q337.23 12.82 328.66 12.82Q320.08 12.82 314.83 18.7Q309.59 24.58 309.59 36.43Z";

function Logo() {
  return (
    <Link href="/system" className="flex shrink-0 items-center gap-2.5 rounded-md" aria-label="Tredio admin home">
      <svg viewBox="0 0 361.93 72" className="h-[15px] w-auto" aria-hidden>
        <path d={LOGO_T} className="text-accent" fill="currentColor" />
        <path d={LOGO_WORD} className="text-fg" fill="currentColor" />
      </svg>
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
        const base = "flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium transition-colors";
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
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:gap-6 sm:px-6">
        <Logo />
        {session && (
          <div className="hidden lg:block">
            <NavLinks layout="inline" />
          </div>
        )}
        <div className="flex-1" />
        {session && (
          // On a phone the account name truncates rather than pushing the page sideways.
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="flex h-8 min-w-0 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 font-mono text-[13px] text-fg"
              title={`Signed in as ${session.account} until ${formatDate(session.expiresAt * 1000)}`}
              data-testid="session-account"
            >
              <span aria-hidden className="size-2 shrink-0 rounded-full bg-ok" />
              <span className="truncate">{shortAddress(session.account)}</span>
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
        <div className="mx-auto max-w-6xl border-t border-line px-4 sm:px-6 lg:hidden">
          <NavLinks layout="bar" />
        </div>
      )}
    </header>
  );
}
