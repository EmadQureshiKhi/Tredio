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

// The Tredio logo (sources in assets/brand): the eye-T glyph in the accent and the wordmark in the text color.
const LOGO_LENS = "M0 21.02Q45.04 -21.02 90.07 21.02Q45.04 63.05 0 21.02ZM45.04 11.63A9.38 9.38 0 1 0 45.04 30.4A9.38 9.38 0 1 0 45.04 11.63Z";
const LOGO_STEM = "M36.03 39.03H54.04V69.06A9.01 9.01 0 0 1 36.03 69.06Z";
const LOGO_WORD =
  "M142.3 74.78Q138.6 74.78 135.35 73.33Q132.1 71.88 130.2 68.63Q128.3 65.38 128.3 60.08V12.58L139.5 6.38V56.98Q139.5 61.18 140.75 63.43Q142 65.68 145.3 65.68Q146.3 65.68 147.65 65.43Q149 65.18 150.5 64.78V73.38Q148.5 74.08 146.45 74.43Q144.4 74.78 142.3 74.78ZM118.9 33.18V24.58H150.5V33.18ZM158.4 73.88V24.58H169.6V37.88L167.5 38.18Q168 33.88 170.4 30.63Q172.8 27.38 176.25 25.53Q179.7 23.68 183.1 23.68Q185.5 23.68 187.7 24.28Q189.9 24.88 192.3 26.28L186.9 36.28Q185.8 35.58 184.05 35.13Q182.3 34.68 180.7 34.68Q178.6 34.68 176.55 35.48Q174.5 36.28 172.9 37.93Q171.3 39.58 170.5 42.18Q170 43.58 169.75 45.83Q169.5 48.08 169.5 52.08V73.88ZM217.3 74.78Q211.1 74.78 206.55 72.78Q202 70.78 199.1 67.18Q196.2 63.58 194.8 59.03Q193.4 54.48 193.4 49.58Q193.4 44.68 194.75 40.03Q196.1 35.38 198.9 31.68Q201.7 27.98 206.1 25.83Q210.5 23.68 216.5 23.68Q222.2 23.68 226.45 25.63Q230.7 27.58 233.5 31.03Q236.3 34.48 237.65 38.88Q239 43.28 239 48.28Q239 48.98 238.95 50.28Q238.9 51.58 238.7 52.88H204.5Q204.9 58.78 208.5 61.88Q212.1 64.98 217.7 64.98Q221.8 64.98 225.2 63.68Q228.6 62.38 231.4 59.58L237.5 66.98Q234.4 69.78 231.3 71.48Q228.2 73.18 224.85 73.98Q221.5 74.78 217.3 74.78ZM228.1 47.28Q228.3 46.48 228.35 45.68Q228.4 44.88 228.4 44.08Q228.4 41.88 227.65 39.88Q226.9 37.88 225.4 36.33Q223.9 34.78 221.7 33.83Q219.5 32.88 216.7 32.88Q212.8 32.88 210.15 34.58Q207.5 36.28 206.05 38.93Q204.6 41.58 204.3 44.68H231.7ZM267 74.78Q260.4 74.78 255.55 71.43Q250.7 68.08 248.1 62.28Q245.5 56.48 245.5 49.18Q245.5 41.18 248.35 35.48Q251.2 29.78 256.1 26.73Q261 23.68 267 23.68Q271.2 23.68 274.75 25.38Q278.3 27.08 280.75 30.33Q283.2 33.58 284.2 38.28L281.6 38.38V4.18H292.7V73.88H281.6V60.18L284.6 59.48Q283.3 64.88 280.65 68.23Q278 71.58 274.5 73.18Q271 74.78 267 74.78ZM269.7 64.58Q273.6 64.58 276.5 62.68Q279.4 60.78 281 57.28Q282.6 53.78 282.6 49.18Q282.6 44.58 281 41.13Q279.4 37.68 276.5 35.73Q273.6 33.78 269.7 33.78Q265.8 33.78 262.85 35.68Q259.9 37.58 258.25 41.08Q256.6 44.58 256.6 49.18Q256.6 53.78 258.25 57.28Q259.9 60.78 262.85 62.68Q265.8 64.58 269.7 64.58ZM303.6 73.88V24.58H314.7V73.88ZM303.1 16.48V4.18H315.2V16.48ZM347.8 74.78Q340.8 74.78 335.2 71.48Q329.6 68.18 326.45 62.38Q323.3 56.58 323.3 49.18Q323.3 41.78 326.45 35.98Q329.6 30.18 335.15 26.93Q340.7 23.68 347.8 23.68Q355 23.68 360.45 26.93Q365.9 30.18 369.1 35.98Q372.3 41.78 372.3 49.18Q372.3 56.58 369.15 62.38Q366 68.18 360.45 71.48Q354.9 74.78 347.8 74.78ZM347.9 64.98Q352 64.98 355 63.08Q358 61.18 359.6 57.58Q361.2 53.98 361.2 49.18Q361.2 44.28 359.6 40.73Q358 37.18 355 35.28Q352 33.38 347.9 33.38Q343.6 33.38 340.6 35.33Q337.6 37.28 336 40.78Q334.4 44.28 334.4 49.18Q334.4 53.98 336 57.58Q337.6 61.18 340.6 63.08Q343.6 64.98 347.9 64.98Z";

function Logo() {
  return (
    <Link href="/system" className="flex shrink-0 items-center gap-2.5 rounded-md" aria-label="Tredio admin home">
      <svg viewBox="0 0 372.3 78.06" className="h-[18px] w-auto" aria-hidden>
        <g className="text-accent" fill="currentColor">
          <path d={LOGO_LENS} fillRule="evenodd" />
          <path d={LOGO_STEM} />
        </g>
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
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Logo />
        {session && (
          <div className="hidden lg:block">
            <NavLinks layout="inline" />
          </div>
        )}
        <div className="flex-1" />
        {session && (
          <div className="flex items-center gap-2">
            <span
              className="flex h-8 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 font-mono text-[13px] text-fg"
              title={`Signed in as ${session.account} until ${formatDate(session.expiresAt * 1000)}`}
              data-testid="session-account"
            >
              <span aria-hidden className="size-2 rounded-full bg-ok" />
              {shortAddress(session.account)}
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
