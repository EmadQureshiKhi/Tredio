"use client";
import { Bot, Fingerprint, Monitor, Moon, Plus, Search, Settings, Sun, Trophy, TrendingUp, Users, Wallet } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { Button, cn, Num } from "@/components/ui";
import { useAccount } from "@/lib/account/AccountProvider";
import { USDC_DECIMALS } from "@/lib/config";
import { shortAddress, tokenAmount, tokenNumber } from "@/lib/format";
import { useUsdcBalance, useSystemStatus, useTrends } from "@/lib/hooks/queries";
import { useTheme } from "@/lib/theme";
import { matchParts } from "@/lib/highlight";
import { useSheets } from "@/lib/sheets";
import { WaitlistCard } from "@/features/waitlist/Waitlist";
import { baseIdentifier, trendName } from "@/lib/trends";
import ConnectionBanner from "./ConnectionBanner";
import { Mark, Wordmark } from "./Logo";

const NAV = [
  { href: "/", label: "Markets", icon: TrendingUp },
  { href: "/autopilot", label: "Autopilot", icon: Bot },
  { href: "/copy", label: "Copy", icon: Users },
  { href: "/leaders", label: "Leaders", icon: Trophy },
  { href: "/portfolio", label: "Portfolio", icon: Wallet },
] as const;

const isActive = (pathname: string, href: string) => (href === "/" ? pathname === "/" || pathname.startsWith("/t/") : pathname.startsWith(href));

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="min-h-dvh lg:pl-[236px]">
      <Sidebar pathname={pathname} />
      <TopBar />
      <main className="mx-auto w-full max-w-[1240px] px-4 pb-28 pt-4 sm:px-6 lg:px-8 lg:pb-16 lg:pt-6">
        <ConnectionBanner />
        {children}
      </main>
      <BottomNav pathname={pathname} />
    </div>
  );
}

function Sidebar({ pathname }: { pathname: string }) {
  const status = useSystemStatus();
  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-[236px] flex-col border-r border-line bg-bg px-4 py-5 lg:flex" style={{ viewTransitionName: "site-sidebar" }}>
      <Link href="/" className="flex h-9 items-center px-2 text-text" aria-label="Tredio home">
        <Wordmark className="h-[18px] w-auto" />
      </Link>
      <nav aria-label="Main" className="mt-7 flex flex-col gap-0.5">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn("flex h-10 items-center gap-3 rounded-xl px-3 font-strong text-[14px] transition-colors", active ? "bg-surface-2 text-text" : "text-text-2 hover:bg-surface hover:text-text")}
            >
              <Icon className={cn("size-[18px]", active ? "text-primary" : "")} aria-hidden />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto flex flex-col gap-3">
        <WaitlistCard />
        <ProposeButton />
        <div className="flex items-center justify-between px-1">
          <Link href="/status" className="flex items-center gap-2 text-[12.5px] text-text-3 transition-colors hover:text-text-2">
            <span className={cn("live-dot size-2 rounded-full", status.data?.ok ? "bg-up" : status.isLoading ? "bg-text-3" : "bg-warn")} aria-hidden />
            {status.data?.ok ? "All systems live" : status.isLoading ? "Checking" : "Status"}
          </Link>
          <div className="flex items-center gap-0.5">
            <Link href="/settings" className="rounded-lg p-1.5 text-text-3 transition-colors hover:bg-surface-2 hover:text-text" aria-label="Settings" title="Settings">
              <Settings className="size-4" aria-hidden />
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </div>
    </aside>
  );
}

function ProposeButton() {
  const open = useSheets((s) => s.open);
  return (
    <Button tone="secondary" block icon={<Plus className="size-4" aria-hidden />} onClick={() => open("propose")}>
      Propose a trend
    </Button>
  );
}

function ThemeToggle() {
  const { choice, setChoice } = useTheme();
  const next = choice === "system" ? "light" : choice === "light" ? "dark" : "system";
  const Icon = choice === "system" ? Monitor : choice === "light" ? Sun : Moon;
  return (
    <button type="button" onClick={() => setChoice(next)} className="rounded-lg p-1.5 text-text-3 transition-colors hover:bg-surface-2 hover:text-text" aria-label={`Theme: ${choice}. Switch to ${next}`} title={`Theme: ${choice}`}>
      <Icon className="size-4" aria-hidden />
    </button>
  );
}

function TopBar() {
  const account = useAccount();
  const balance = useUsdcBalance(account.address);
  const open = useSheets((s) => s.open);
  return (
    <header className="pt-safe sticky top-0 z-30 border-b border-line bg-[color-mix(in_srgb,var(--bg)_86%,transparent)] backdrop-blur-xl" style={{ viewTransitionName: "site-header" }}>
      <div className="mx-auto flex h-14 max-w-[1240px] items-center gap-3 px-4 sm:px-6 lg:h-16 lg:px-8">
        <Link href="/" className="text-text lg:hidden" aria-label="Tredio home">
          <Mark className="h-6 w-auto" />
        </Link>
        <MobileStatus />
        <TrendSearch />
        <div className="ml-auto flex items-center gap-2">
          {account.status === "loading" ? (
            <>
              {/* Restoring the session: the shell this browser last had, without a spinner. */}
              <div className="when-account flex items-center gap-2" aria-hidden>
                <span className="skeleton h-9 w-[130px] rounded-xl" />
                <span className="skeleton h-9 w-11 rounded-xl sm:w-[150px]" />
              </div>
              <Button className="when-no-account" size="sm" icon={<Fingerprint className="size-4" aria-hidden />} onClick={account.login}>
                Sign in
              </Button>
            </>
          ) : account.authenticated ? (
            <>
              <button
                type="button"
                onClick={() => open("deposit")}
                className="flex h-9 items-center gap-2 rounded-xl border border-line bg-surface px-3 transition-colors hover:border-line-strong"
                aria-label={`USDC balance ${balance.data ? tokenAmount(balance.data.raw, USDC_DECIMALS) : "loading"}. Add funds`}
              >
                <Num value={balance.data ? tokenNumber(balance.data.raw, USDC_DECIMALS) : null} placeholder="..." className="num font-strong text-[13.5px] text-text" />
                <span className="text-[12px] text-text-3">USDC</span>
                <span className="flex size-5 items-center justify-center rounded-md bg-primary text-on-primary">
                  <Plus className="size-3.5" aria-hidden />
                </span>
              </button>
              <AccountButton />
            </>
          ) : (
            <AccountButton />
          )}
        </div>
      </div>
    </header>
  );
}

/** Phones: the system's health as a small pill beside the logo (the sidebar holds it on desktop). */
function MobileStatus() {
  const status = useSystemStatus();
  const ok = status.data?.ok;
  return (
    <Link href="/status" className="flex h-7 items-center gap-1.5 rounded-full border border-line px-2.5 text-[11.5px] text-text-3 lg:hidden" aria-label={ok ? "All systems live" : "System status"}>
      <span className={cn("size-1.5 rounded-full", ok ? "live-dot bg-up" : status.isLoading ? "bg-text-3" : "bg-warn")} aria-hidden />
      {ok ? "Live" : status.isLoading ? "..." : "Status"}
    </Link>
  );
}

function AccountButton() {
  const { status, session, login } = useAccount();
  if (status === "active" && session) {
    return (
      <button type="button" onClick={login} className="flex h-9 min-w-0 items-center gap-2 rounded-xl border border-line bg-surface pl-1.5 pr-3 transition-colors hover:border-line-strong" data-testid="account-button">
        <Avatar address={session.address} />
        <span className="num hidden font-mono text-[12.5px] text-text-2 sm:inline">{shortAddress(session.address)}</span>
        <span className="sr-only sm:hidden">{shortAddress(session.address)}</span>
      </button>
    );
  }
  if (status === "session-expired") {
    return (
      <Button tone="secondary" size="sm" onClick={login}>
        Renew session
      </Button>
    );
  }
  return (
    <Button size="sm" icon={<Fingerprint className="size-4" aria-hidden />} onClick={login} loading={status === "working"}>
      Sign in
    </Button>
  );
}

/** A deterministic gradient from the account id, so each account is recognizable at a glance. */
export function Avatar({ address, size = 24 }: { address: string; size?: number }) {
  let n = 0;
  for (const ch of address.toLowerCase()) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  const h = n % 360;
  const h2 = (h + 60) % 360;
  return <span aria-hidden className="shrink-0 rounded-full" style={{ width: size, height: size, background: `linear-gradient(135deg, hsl(${h} 70% 62%), hsl(${h2} 72% 48%))` }} />;
}

function TrendSearch() {
  const router = useRouter();
  const { data } = useTrends();
  const [q, setQ] = useState("");
  const [focus, setFocus] = useState(false);
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s || !data) return [];
    return data.trends.filter((t) => t.identifier.includes(s) || (t.displayName ?? "").toLowerCase().includes(s) || t.keywords.some((k) => k.toLowerCase().includes(s))).slice(0, 6);
  }, [q, data]);
  const go = (identifier: string) => {
    setQ("");
    input.current?.blur();
    router.push(`/t/${identifier}`);
  };
  return (
    <div className="relative hidden w-full max-w-[380px] md:block">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-3" aria-hidden />
      <input
        ref={input}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setCursor(0);
        }}
        onFocus={() => setFocus(true)}
        onBlur={() => setTimeout(() => setFocus(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setCursor((c) => Math.min(c + 1, matches.length - 1));
          if (e.key === "ArrowUp") setCursor((c) => Math.max(c - 1, 0));
          if (e.key === "Enter" && matches[cursor]) go(matches[cursor].identifier);
          if (e.key === "Escape") input.current?.blur();
        }}
        placeholder="Search trends"
        aria-label="Search trends"
        role="combobox"
        aria-expanded={focus && matches.length > 0}
        aria-controls="trend-search-list"
        className="h-10 w-full rounded-xl border border-line bg-surface pl-9 pr-3 text-[14px] text-text outline-none transition-colors placeholder:text-text-3 focus:border-primary"
      />
      {focus && matches.length > 0 ? (
        <ul
          id="trend-search-list"
          role="listbox"
          className="absolute left-0 right-0 top-12 z-50 overflow-hidden rounded-2xl border border-line bg-surface p-1 shadow-card transition-[opacity,translate] duration-150 ease-out starting:-translate-y-1 starting:opacity-0"
        >
          {matches.map((t, i) => (
            <li key={t.id} role="option" aria-selected={i === cursor}>
              <button type="button" onMouseDown={() => go(t.identifier)} className={cn("flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left", i === cursor ? "bg-surface-2" : "")}>
                <span className="min-w-0">
                  <span className="block truncate font-strong text-[13.5px] text-text">
                    <Highlight text={trendName(t)} query={q} />
                  </span>
                  <span className="block truncate font-mono text-[11.5px] text-text-3">
                    <Highlight text={baseIdentifier(t.identifier)} query={q} />
                  </span>
                </span>
                <span className="num font-strong text-[13px] text-text-2">{t.index.toFixed(1)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The part of `text` that matches the search, in the primary color. */
function Highlight({ text, query }: { text: string; query: string }) {
  return matchParts(text, query).map((p, i) =>
    p.hit ? (
      <mark key={i} className="bg-transparent text-primary">
        {p.text}
      </mark>
    ) : (
      p.text
    ),
  );
}

function BottomNav({ pathname }: { pathname: string }) {
  return (
    <nav aria-label="Main" className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-line bg-[color-mix(in_srgb,var(--bg)_92%,transparent)] backdrop-blur-xl lg:hidden" style={{ viewTransitionName: "site-nav" }}>
      <div className="mx-auto grid h-16 max-w-md grid-cols-5">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <Link key={href} href={href} aria-current={active ? "page" : undefined} className={cn("flex flex-col items-center justify-center gap-1 text-[11px] font-strong transition-colors", active ? "text-text" : "text-text-3")}>
              <Icon className={cn("size-[20px]", active ? "text-primary" : "")} aria-hidden />
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
