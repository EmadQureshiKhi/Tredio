import React from "react";
import Link from "next/link";
import { LEGAL_LINKS, NAV_ITEMS } from "@/config/links";

export default function MobileFooter() {
  return (
    <footer className="bg-neutral-900 text-white px-6 py-12">
      {/* Hero Section */}
      <div className="mb-12">
        <div className="flex items-start mb-6">
          <div>
            <p className="text-4xl font-bold leading-tight mb-4">
              Trade the World&apos;s
              <br />
              Attention
            </p>
            <div className="space-y-1 text-sm text-gray-300">
              <p>Tredio</p>
              <p>Settled in USDC</p>
              <p>Live on Testnet</p>
            </div>
          </div>
        </div>
      </div>

      {/* Explore Section */}
      <div className="mb-12">
        <h2 className="text-xs font-bold uppercase tracking-wider mb-4">
          EXPLORE
        </h2>
        <nav aria-label="Explore" className="space-y-0 font-display ">
          {NAV_ITEMS.map((item) =>
            item.scrollTo ? (
              // Opens the home page section from any page; on the home page it just scrolls.
              <Link key={item.title} href={`/${item.scrollTo}`} className="block text-[6vw] ">
                {item.title}
              </Link>
            ) : (
              <a
                key={item.title}
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-[6vw] "
              >
                {item.title}
              </a>
            ),
          )}
        </nav>
      </div>

      <nav aria-label="Legal" className="flex flex-col gap-3 pt-8 text-xs uppercase tracking-wider">
        {LEGAL_LINKS.map((item) => (
          <Link key={item.href} href={item.href} className="block w-fit py-1 text-white/85 hover:text-white">
            {item.title}
          </Link>
        ))}
      </nav>
      <div className="mt-8 flex flex-col items-center">
        <div className="mb-4 w-full">
          <p
            aria-hidden="true"
            className="text-[17vw] font-black text-[#9C93E8] text-center tracking-widest leading-none"
            style={{ fontFamily: "Arial, Helvetica, sans-serif" }}
          >
            TREDIO
          </p>
        </div>

        <div className="flex items-center justify-center">
          <p className="text-xs text-gray-200">&copy; 2026 TREDIO</p>
        </div>
      </div>
    </footer>
  );
}
