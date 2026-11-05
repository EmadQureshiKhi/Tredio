import Link from "next/link";
import Navbar from "@/components/header/Navbar";
import Footer from "@/components/footer/Footer";
import MobileFooter from "@/components/footer/MobileFooter";
import { APP_URL, CONTACT_EMAIL } from "@/config/links";

const TOPICS = [
  { title: "Help with the app", body: "Something not working on NEAR testnet, a trade you want explained, or an idea for a market." },
  { title: "Partners and press", body: "Data sources, integrations, agents that want the index, and interviews." },
  { title: "Security", body: "Found a bug in a contract or a service? Write before you share it anywhere else." },
  { title: "Your data", body: "Access, correction or deletion requests, or leaving the Mainnet waitlist." },
];

// One address for everything, and what to write about.
export default function Contact() {
  return (
    <>
      <Navbar />
      <main className="min-h-screen bg-[#09090B] text-white pt-[clamp(112px,10vw,168px)] pb-24 max-sm:pb-16">
        <div className="mx-auto w-full max-w-[1180px] px-5 sm:px-8">
          <span className="inline-flex items-center gap-2 rounded-full border border-[#9C93E8]/30 bg-[#9C93E8]/10 px-3 py-1 font-body text-[11px] font-semibold uppercase tracking-[0.18em] text-[#C9C3F5]">
            Contact
          </span>
          <h1 className="mt-5 max-w-[860px] text-balance font-third text-[clamp(40px,5.5vw,84px)] leading-[1.04] tracking-[-0.02em]">
            Write to us. A person reads every email.
          </h1>
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="mt-8 inline-flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-6 py-5 font-body text-[clamp(20px,2vw,30px)] text-white transition-colors hover:border-[#9C93E8]/50 hover:bg-white/[0.06] max-sm:w-full max-sm:px-5 max-sm:py-4 [overflow-wrap:anywhere]"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="size-[0.9em] shrink-0 text-[#9C93E8]" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <rect x="3" y="5" width="18" height="14" rx="2.5" />
              <path d="m4 7 8 6 8-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {CONTACT_EMAIL}
          </a>

          <ul className="mt-16 grid gap-4 sm:grid-cols-2">
            {TOPICS.map((t) => (
              <li key={t.title} className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-6">
                <h2 className="font-display text-[22px] leading-tight">{t.title}</h2>
                <p className="mt-2 font-body text-[16px] leading-[1.6] text-white/70">{t.body}</p>
              </li>
            ))}
          </ul>

          <p className="mt-12 max-w-[760px] font-body text-[16px] leading-[1.7] text-white/65">
            For how we handle what you send, see the <Link href="/privacy" className="text-white underline decoration-white/30 underline-offset-4 hover:decoration-white">privacy policy</Link>.
            To try Tredio, open the{" "}
            <a href={APP_URL} target="_blank" rel="noopener noreferrer" className="text-white underline decoration-white/30 underline-offset-4 hover:decoration-white">
              app on NEAR testnet
            </a>
            .
          </p>
        </div>
      </main>
      <div className="max-[768px]:hidden">
        <Footer />
      </div>
      <div className="min-[769px]:hidden">
        <MobileFooter />
      </div>
    </>
  );
}
