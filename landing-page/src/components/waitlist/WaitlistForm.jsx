"use client";
import { useId, useState } from "react";
import { BACKEND_URL } from "@/config/links";

// The same consent line the app shows, and the backend's email check (backend/src/waitlist/routes.ts).
export const CONSENT_TEXT = "Email me about Tredio’s Mainnet launch. Unsubscribe anytime.";
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

function emailError(value) {
  const email = value.trim().toLowerCase();
  if (!email) return "Enter your email address.";
  if (email.length > 254) return "That email address is too long.";
  return EMAIL.test(email) ? null : "Enter a valid email address.";
}

function waitText(sec) {
  if (!(sec > 5)) return "a few seconds";
  if (sec < 90) return `${Math.round(sec)} seconds`;
  return `${Math.round(sec / 60)} minutes`;
}

// One POST to the backend. The answer is the same for a new email and a listed one.
async function joinWaitlist(body) {
  let res;
  try {
    res = await fetch(`${BACKEND_URL}/v1/waitlist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, source: "landing" }),
    });
  } catch {
    throw new Error("Tredio could not be reached. Check your connection and try again.");
  }
  if (res.ok) return;
  const reply = await res.json().catch(() => null);
  if (res.status === 429) {
    throw new Error(`Too many sign-ups from this network. Try again in ${waitText(Number(res.headers.get("retry-after")))}.`);
  }
  throw new Error(typeof reply?.error === "string" ? reply.error : "Joining failed. Try again.");
}

const TONES = {
  // On the dark modal.
  dark: {
    label: "text-white/70",
    input: "bg-white/[0.05] text-white placeholder:text-white/35 border-white/15 focus:border-[#9C93E8]",
    invalid: "border-[#FF8A8A] focus:border-[#FF8A8A]",
    consent: "text-white/70",
    check: "accent-[#9C93E8]",
    button: "bg-[#9C93E8] text-black hover:bg-[#B3ABF0]",
    error: "text-[#FF9C9C]",
    note: "text-white/45",
    link: "text-white/70 hover:text-white",
    success: "bg-white/[0.04] border-white/10 text-white",
    successSub: "text-white/65",
    tick: "bg-[#9C93E8] text-black",
  },
  // On the lavender section.
  light: {
    label: "text-black/70",
    input: "bg-[#0B0B0D] text-white placeholder:text-white/40 border-transparent focus:border-black",
    invalid: "border-[#7A0F0F] focus:border-[#7A0F0F]",
    consent: "text-black/75",
    check: "accent-black",
    button: "bg-black text-[#C9C3F5] hover:bg-[#1E1E1E]",
    error: "text-[#6B0A0A]",
    note: "text-black/55",
    link: "text-black/75 hover:text-black",
    success: "bg-[#0B0B0D] border-transparent text-white",
    successSub: "text-white/65",
    tick: "bg-[#9C93E8] text-black",
  },
};

/**
 * The Mainnet waitlist form: email, consent and a honeypot only bots fill. Joining shows
 * "You're on the list" in place of the form. The site keeps nothing in the browser.
 */
export default function WaitlistForm({ tone = "dark", autoFocus = false }) {
  const t = TONES[tone];
  const id = useId();
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState("");
  const [tried, setTried] = useState(false);
  const [state, setState] = useState({ kind: "idle" });

  const emailProblem = tried ? emailError(email) : null;
  const consentProblem = tried && !consent ? "Tick the box to get the launch email." : null;

  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (emailError(email) || !consent || state.kind === "sending") return;
    const clean = email.trim().toLowerCase();
    setState({ kind: "sending" });
    try {
      await joinWaitlist({ email: clean, consent: true, website });
      setState({ kind: "done", email: clean });
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : "Joining failed. Try again." });
    }
  };

  if (state.kind === "done") {
    return (
      <div role="status" className={`flex items-start gap-4 rounded-2xl border p-5 font-body ${t.success}`} data-testid="waitlist-success">
        <span className={`flex size-10 shrink-0 items-center justify-center rounded-full ${t.tick}`}>
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" pathLength={1} className="waitlist-check" />
          </svg>
        </span>
        <div className="min-w-0">
          <p className="font-third text-[22px] leading-tight">You&rsquo;re on the list</p>
          <p className="mt-1 text-[15px] leading-[1.45] text-white [overflow-wrap:anywhere]">{state.email}</p>
          <p className={`mt-1.5 text-pretty text-[14px] leading-[1.55] ${t.successSub}`}>We&rsquo;ll email you when Tredio opens on mainnet, with your beta access.</p>
        </div>
      </div>
    );
  }

  const sending = state.kind === "sending";
  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4 font-body" aria-busy={sending || undefined}>
      <div className="flex flex-col gap-2">
        <label htmlFor={`${id}-email`} className={`text-[12px] font-semibold uppercase tracking-[0.14em] ${t.label}`}>
          Email
        </label>
        <input
          id={`${id}-email`}
          type="email"
          name="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={254}
          placeholder="you@example.com"
          autoFocus={autoFocus}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={Boolean(emailProblem) || undefined}
          aria-describedby={emailProblem ? `${id}-email-note` : undefined}
          className={`h-12 w-full rounded-xl border px-4 text-[16px] outline-none transition-colors ${t.input} ${emailProblem ? t.invalid : ""}`}
          data-testid="waitlist-email"
        />
        {emailProblem && (
          <p id={`${id}-email-note`} className={`text-[13px] leading-5 ${t.error}`}>
            {emailProblem}
          </p>
        )}
      </div>

      {/* A field only bots fill: hidden from people, screen readers and autofill. */}
      <div aria-hidden="true" className="sr-only">
        <label>
          Website
          <input type="text" name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
        </label>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-consent`} className={`flex cursor-pointer items-start gap-3 text-[14px] leading-[1.5] ${t.consent}`}>
          <input
            id={`${id}-consent`}
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            aria-invalid={Boolean(consentProblem) || undefined}
            aria-describedby={consentProblem ? `${id}-consent-note` : undefined}
            className={`mt-[3px] size-4 shrink-0 cursor-pointer ${t.check}`}
            data-testid="waitlist-consent"
          />
          <span className="text-pretty">{CONSENT_TEXT}</span>
        </label>
        {consentProblem && (
          <p id={`${id}-consent-note`} className={`pl-7 text-[13px] leading-5 ${t.error}`}>
            {consentProblem}
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={sending}
        className={`relative flex h-12 w-full cursor-pointer items-center justify-center rounded-xl text-[12px] font-semibold uppercase tracking-[0.16em] transition-colors disabled:cursor-wait ${t.button}`}
        data-testid="waitlist-submit"
      >
        <span className={sending ? "invisible" : undefined}>Join the waitlist</span>
        {sending && <span aria-hidden="true" className="absolute size-4 animate-spin rounded-full border-2 border-current border-r-transparent" />}
        {sending && <span className="sr-only">Joining</span>}
      </button>

      {state.kind === "error" && (
        <p role="alert" className={`text-[13px] leading-5 ${t.error}`}>
          {state.message}
        </p>
      )}

      <p className={`text-pretty text-[12px] leading-[1.55] ${t.note}`}>
        We send nothing before mainnet opens. See the{" "}
        <a href="/privacy#waitlist" className={`underline underline-offset-2 ${t.link}`}>
          privacy policy
        </a>
        .
      </p>
    </form>
  );
}
