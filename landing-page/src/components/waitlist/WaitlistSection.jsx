"use client";
import WaitlistForm from "./WaitlistForm";

// Just before the footer: where the site stands today and the inline Mainnet waitlist form. The
// menu's "Waitlist" item scrolls here.
export default function WaitlistSection() {
  return (
    <section id="waitlist" aria-labelledby="waitlist-heading" className="relative z-[13] w-full bg-[#9C93E8] text-black">
      <div className="mx-auto grid w-full max-w-[1600px] items-start gap-12 px-[6vw] py-24 lg:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)] lg:gap-[6vw] lg:px-[4vw] lg:py-[9vw]">
        <div>
          <p className="font-body text-[12px] font-semibold uppercase tracking-[0.18em] text-black/65">Mainnet waitlist</p>
          <h2 id="waitlist-heading" className="mt-5 text-balance font-third text-[clamp(40px,5.2vw,96px)] leading-[1.02] tracking-[-0.01em]">
            Tredio is live on Testnet. <span className="text-black/45">Mainnet is next.</span>
          </h2>
          <p className="mt-6 max-w-[560px] text-pretty font-body text-[clamp(16px,1.2vw,20px)] leading-[1.55] text-black/75">
            Every market you can trade today runs on Testnet with test tokens. Leave your email and you will hear the moment real attention markets open on Mainnet, with early access to the beta.
          </p>
        </div>
        <div className="w-full lg:pt-[3.2vw]">
          <WaitlistForm tone="light" />
        </div>
      </div>
    </section>
  );
}
