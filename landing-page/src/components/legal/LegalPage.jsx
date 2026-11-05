import Link from "next/link";
import Navbar from "@/components/header/Navbar";
import Footer from "@/components/footer/Footer";
import MobileFooter from "@/components/footer/MobileFooter";
import { APP_URL, LEGAL_LINKS } from "@/config/links";
import { COMPANY, CONTACT_EMAIL, GOVERNING_LAW, JURISDICTION, LAST_UPDATED, LAST_UPDATED_ISO } from "@/config/legal";

export const Company = () => <>{COMPANY}</>;
export const Jurisdiction = () => <>{JURISDICTION}</>;
export const GoverningLaw = () => <>{GOVERNING_LAW}</>;
export const Contact = () => <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>;

export function ExternalLink({ href, children }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

// A table on wide screens; on phones each row becomes a stacked card so nothing scrolls sideways.
export function Table({ head, rows }) {
  return (
    <>
      <div className="max-sm:hidden mb-4">
        <table>
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="sm:hidden mb-4 space-y-3">
        {rows.map((row, i) => (
          <dl key={i} className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-[15px] leading-[1.55]">
            {row.map((cell, j) => (
              <div key={j} className={j ? "mt-2" : ""}>
                <dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/55">{head[j]}</dt>
                <dd className="m-0">{cell}</dd>
              </div>
            ))}
          </dl>
        ))}
      </div>
    </>
  );
}

/**
 * Shared layout of the legal pages: title, last-updated date, a testnet notice, a section index
 * (sticky beside the text on wide screens) and the sections themselves.
 * `sections` is a list of { id, title, body }.
 */
export default function LegalPage({ title, intro, path, sections }) {
  return (
    <>
      <Navbar />
      <main className="bg-[#09090B] text-white min-h-screen pt-[clamp(112px,10vw,168px)] pb-24 max-sm:pb-16">
        <div className="mx-auto w-full max-w-[1180px] px-5 sm:px-8">
          <header className="max-w-[760px] mb-12 max-sm:mb-10">
            <span className="inline-flex items-center gap-2 rounded-full border border-[#9C93E8]/30 bg-[#9C93E8]/10 px-3 py-1 font-body text-[11px] font-semibold uppercase tracking-[0.18em] text-[#C9C3F5]">
              Legal
            </span>
            <h1 className="mt-5 font-third leading-[1.05] text-[clamp(40px,5.5vw,84px)] tracking-[-0.01em]">
              {title}
            </h1>
            <p className="mt-4 font-body text-[14px] uppercase tracking-[0.12em] text-white/60">
              Last updated <time dateTime={LAST_UPDATED_ISO}>{LAST_UPDATED}</time>
            </p>
            {intro && (
              <p className="mt-6 font-body text-[18px] leading-[1.65] text-white/80 max-sm:text-[17px]">
                {intro}
              </p>
            )}
            <p className="mt-6 rounded-xl border border-[#9C93E8]/30 bg-[#9C93E8]/[0.08] px-5 py-4 font-body text-[15px] leading-[1.6] text-white/85">
              <strong className="text-white">Testnet product.</strong> Tredio runs on NEAR testnet.
              Every token, balance and position in it, testnet USDC included, is a test asset with no monetary value.
            </p>
          </header>

          <div className="grid gap-14 lg:grid-cols-[220px_minmax(0,760px)] lg:gap-16">
            <nav aria-label="On this page" className="lg:sticky lg:top-28 lg:self-start">
              <p className="mb-3 font-body text-[11px] font-semibold uppercase tracking-[0.18em] text-white/55">
                On this page
              </p>
              <ol className="space-y-2 font-body text-[14px] leading-[1.4]">
                {sections.map((s, i) => (
                  <li key={s.id} className="flex gap-2">
                    <span className="w-5 shrink-0 text-white/55 tabular-nums">{i + 1}.</span>
                    <a href={`#${s.id}`} className="text-white/70 hover:text-white transition-colors">
                      {s.title}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>

            <article className="legal-prose min-w-0">
              {sections.map((s, i) => (
                <section key={s.id} id={s.id} className="mb-12 last:mb-0 scroll-mt-28">
                  <h2>
                    <span className="text-[#9C93E8] mr-2">{String(i + 1).padStart(2, "0")}</span>
                    {s.title}
                  </h2>
                  {s.body}
                </section>
              ))}
            </article>
          </div>

          <nav
            aria-label="Other legal pages"
            className="mt-20 border-t border-white/10 pt-8 flex flex-wrap gap-x-8 gap-y-3 font-body text-[13px] uppercase tracking-[0.12em]"
          >
            {LEGAL_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                aria-current={l.href === path ? "page" : undefined}
                className={l.href === path ? "text-white" : "text-white/60 hover:text-white transition-colors"}
              >
                {l.title}
              </Link>
            ))}
            <a href={APP_URL} target="_blank" rel="noopener noreferrer" className="text-white/60 hover:text-white transition-colors">
              Launch app
            </a>
          </nav>
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
