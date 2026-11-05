import React from "react";
import Link from "next/link";
import { CONTACT_EMAIL, LEGAL_LINKS, NAV_ITEMS } from "@/config/links";
import { LOCKUP_LENS, LOCKUP_STEM, LOCKUP_VIEWBOX, LOCKUP_WORD } from "@/components/brand/Logo";

export default function MobileFooter() {
  return (
    <footer className="bg-[#1E1E1E] text-white px-6 pt-14 pb-10">
      <div className="mb-12">
        <p className="font-third text-[clamp(36px,10vw,56px)] leading-[1.08] tracking-[-0.01em] mb-6">
          Trade the World&apos;s
          <br />
          Attention
        </p>
        <div className="space-y-1 text-[15px] text-gray-300">
          <p>Attention markets on NEAR</p>
          <p>Settled in USDC</p>
          <p>Live on NEAR testnet</p>
        </div>
        <a
          href={`mailto:${CONTACT_EMAIL}`}
          className="mt-4 inline-block text-[15px] text-white underline decoration-white/30 underline-offset-4"
        >
          {CONTACT_EMAIL}
        </a>
      </div>

      <div className="mb-12">
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.18em] text-white/60 mb-4">Explore</h2>
        <nav aria-label="Explore" className="font-display">
          {NAV_ITEMS.map((item) =>
            item.scrollTo ? (
              // Opens the home page section from any page; on the home page it just scrolls.
              <Link key={item.title} href={`/${item.scrollTo}`} className="block py-1 text-[clamp(24px,7vw,36px)] leading-[1.25]">
                {item.title}
              </Link>
            ) : (
              <a
                key={item.title}
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
                className="block py-1 text-[clamp(24px,7vw,36px)] leading-[1.25]"
              >
                {item.title}
              </a>
            ),
          )}
        </nav>
      </div>

      <nav aria-label="Legal" className="flex flex-col gap-2 border-t border-white/10 pt-8 text-[12px] font-semibold uppercase tracking-[0.12em]">
        {LEGAL_LINKS.map((item) => (
          <Link key={item.href} href={item.href} className="block w-fit py-1.5 text-white/80 hover:text-white">
            {item.title}
          </Link>
        ))}
      </nav>

      <div className="mt-12 flex flex-col items-center gap-6">
        <svg viewBox={LOCKUP_VIEWBOX} className="h-auto w-[clamp(200px,62vw,320px)] text-white" aria-hidden="true">
          <path d={LOCKUP_LENS} fill="#9C93E8" fillRule="evenodd" />
          <path d={LOCKUP_STEM} fill="#9C93E8" />
          <path d={LOCKUP_WORD} fill="currentColor" />
        </svg>
        <p className="text-[12px] uppercase tracking-[0.12em] text-white/60">&copy; 2026 Tredio</p>
      </div>
    </footer>
  );
}
