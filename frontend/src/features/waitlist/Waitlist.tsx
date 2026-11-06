"use client";
import { useMutation } from "@tanstack/react-query";
import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { Check, ChevronRight, Rocket, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { AnimateHeight, Button, cn, DrawnCheck, ErrorNote, Field, Sheet, Switch } from "@/components/ui";
import { useAccount } from "@/lib/account/AccountProvider";
import { ApiError, waitlist } from "@/lib/api";
import { IS_MAINNET } from "@/lib/config";
import { shortAddress } from "@/lib/format";
import { useSheets } from "@/lib/sheets";
import { emailError } from "./email";
import { collapseCard, dismissRow, joinedFor, rememberJoin, useWaitlistMemory } from "./store";

/**
 * The Mainnet waitlist in the app: a card at the foot of the desktop sidebar, a row under the Home
 * hero and an entry in the account sheet on phones, all opening one sheet. Tredio stays on Testnet;
 * the list only collects emails for the launch and its beta.
 */

export const CONSENT_TEXT = "Email me about Tredio’s Mainnet launch. Unsubscribe anytime.";
const CONTACT_EMAIL = "contact@tredio.bid";
/** The website's privacy policy, at its waitlist section. */
const PRIVACY_URL = "https://tredio.bid/privacy#waitlist";
const EASE_OUT = [0.25, 1, 0.5, 1] as const;

/**
 * Desktop sidebar: the offer, which its X folds down to a "Join the waitlist" button, and a compact
 * "On the waitlist" once this browser joined (a join wins over a folded card). #mainnet: the list
 * is for Mainnet's launch, so an app built for Mainnet shows none of it.
 */
export function WaitlistCard() {
  return IS_MAINNET ? null : <SidebarCard />;
}

function SidebarCard() {
  const open = useSheets((s) => s.open);
  const account = useAccount();
  const memory = useWaitlistMemory();
  const joined = joinedFor(memory, account.address);
  // Before the store is read (server render, hydration) every state renders, and the pre-paint hint shows one.
  const unknown = memory === null;
  const collapsed = !joined && memory?.cardCollapsed === true;
  // Folding the card removes its X: keyboard focus moves on to the button that replaces it.
  const compact = useRef<HTMLButtonElement>(null);
  const [folded, setFolded] = useState(false);
  useEffect(() => {
    if (folded && collapsed) compact.current?.focus();
  }, [folded, collapsed]);
  return (
    <AnimateHeight>
      {unknown || (!joined && !collapsed) ? (
        <div className={cn("relative overflow-hidden rounded-2xl border border-line bg-surface p-3.5", unknown && "when-waitlist-open")} data-testid="waitlist-card">
          <div aria-hidden className="pointer-events-none absolute -right-10 -top-12 size-28 rounded-full bg-primary-soft blur-2xl" />
          <button
            type="button"
            onClick={() => {
              setFolded(true);
              collapseCard();
            }}
            aria-label="Hide the waitlist offer"
            title="Hide"
            className="absolute right-1.5 top-2.5 z-10 flex size-7 items-center justify-center rounded-lg text-text-3 transition-colors hover:text-text-2"
            data-testid="waitlist-card-hide"
          >
            <X className="size-4" aria-hidden />
          </button>
          <div className="relative flex items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-[9px] bg-primary-soft text-primary">
              <Rocket className="size-[15px]" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="font-strong text-[13.5px] leading-5 text-text">Mainnet is coming</p>
              <p className="text-[12px] leading-4 text-text-3">Get early access</p>
            </div>
          </div>
          <p className="relative mt-2.5 text-pretty text-[12.5px] leading-[18px] text-text-2">Be among the first to trade when Tredio opens on Mainnet.</p>
          <Button size="sm" block className="relative mt-3" onClick={() => open("waitlist")}>
            Join the waitlist
          </Button>
        </div>
      ) : null}
      {unknown || collapsed ? (
        <button
          ref={compact}
          type="button"
          onClick={() => open("waitlist")}
          className={cn(
            "flex h-10 w-full items-center gap-2.5 rounded-xl border border-line bg-surface px-3 text-left transition-[border-color,opacity] duration-200 hover:border-line-strong starting:opacity-0",
            unknown && "when-waitlist-collapsed",
          )}
          data-testid="waitlist-compact"
        >
          <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary">
            <Rocket className="size-3" aria-hidden />
          </span>
          <span className="min-w-0 flex-1 truncate font-strong text-[13px] text-text">Join the waitlist</span>
          <ChevronRight className="size-4 shrink-0 text-text-3" aria-hidden />
        </button>
      ) : null}
      {unknown || joined ? (
        <button
          type="button"
          onClick={() => open("waitlist")}
          className={cn(
            "flex h-11 w-full items-center gap-2.5 rounded-xl border border-line bg-surface px-3 text-left transition-[border-color,opacity] duration-200 hover:border-line-strong starting:opacity-0",
            unknown && "when-waitlist-joined",
          )}
          data-testid="waitlist-joined"
          title={joined ? `Joined as ${joined.email}` : undefined}
        >
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-up-soft text-up">
            {unknown ? <Check className="size-3" strokeWidth={2.5} aria-hidden /> : <DrawnCheck className="size-3 [stroke-width:2.5]" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-strong text-[13px] leading-4 text-text">On the waitlist</span>
            <span className="block truncate text-[11.5px] leading-4 text-text-3">Mainnet early access</span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-text-3" aria-hidden />
        </button>
      ) : null}
    </AnimateHeight>
  );
}

/**
 * Phones and tablets (no sidebar): a slim row under the Home hero, until this browser joins or
 * dismisses it. None on Mainnet.
 */
export function WaitlistRow() {
  return IS_MAINNET ? null : <HomeRow />;
}

function HomeRow() {
  const open = useSheets((s) => s.open);
  const memory = useWaitlistMemory();
  const reduced = useReducedMotion();
  const unknown = memory === null;
  const shown = unknown || (memory.joined.length === 0 && !memory.rowDismissed);
  return (
    <AnimatePresence initial={false}>
      {shown ? (
        <m.div
          key="waitlist-row"
          className={cn("overflow-hidden lg:hidden", unknown && "when-waitlist-row")}
          exit={{ height: 0, opacity: 0, transition: { duration: reduced ? 0 : 0.22, ease: EASE_OUT } }}
        >
          <div className="pt-3">
            <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface py-2.5 pl-3 pr-2" data-testid="waitlist-row">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary">
                <Rocket className="size-[18px]" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-strong text-[13.5px] leading-5 text-text">Mainnet is coming</p>
                <p className="truncate text-[12.5px] leading-[18px] text-text-2">Get early access to the beta</p>
              </div>
              <Button size="sm" onClick={() => open("waitlist")}>
                Join
              </Button>
              <button type="button" onClick={dismissRow} aria-label="Dismiss the waitlist offer" className="rounded-lg p-1.5 text-text-3 transition-colors hover:bg-surface-2 hover:text-text">
                <X className="size-4" aria-hidden />
              </button>
            </div>
          </div>
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}

export function WaitlistSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const account = useAccount();
  const memory = useWaitlistMemory();
  const joined = joinedFor(memory, account.address);
  const signedIn = account.authenticated && Boolean(account.address);
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [link, setLink] = useState(true);
  const [website, setWebsite] = useState("");
  const [tried, setTried] = useState(false);
  // Joined from this browser earlier: the sheet shows that, unless the person adds another email.
  const [another, setAnother] = useState(false);
  const [done, setDone] = useState<{ email: string; account: string | null } | null>(null);
  const consentId = useId();

  const linked = signedIn && link ? (account.address ?? null) : null;
  const join = useMutation({
    mutationFn: (v: { email: string; account: string | null }) => waitlist.join({ email: v.email, account: v.account, consent: true, website }),
    onSuccess: (_r, v) => {
      // A filled honeypot means a bot: it is told the same, and this browser remembers nothing.
      if (!website) rememberJoin(v.email, v.account);
      setDone(v);
    },
  });

  const emailProblem = tried ? emailError(email) : null;
  const consentProblem = tried && !consent ? "Tick the box to get the launch email." : null;
  const submit = () => {
    setTried(true);
    if (emailError(email) || !consent) return;
    join.mutate({ email: email.trim().toLowerCase(), account: linked });
  };
  const reset = () => {
    setEmail("");
    setConsent(false);
    setLink(true);
    setWebsite("");
    setTried(false);
    setAnother(false);
    setDone(null);
    join.reset();
  };

  const success = done ?? (!another && joined ? { email: joined.email, account: joined.account } : null);
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setTimeout(reset, 250);
      }}
      busy={join.isPending}
      title={success ? "You’re on the list" : "Join the Mainnet waitlist"}
      description={success ? "Tredio emails you the moment Mainnet opens." : "Tredio is live on Testnet. Mainnet is next: be among its first beta users."}
      testId="waitlist-sheet"
    >
      <AnimateHeight>
        {success ? (
          <div className="flex flex-col gap-4" data-testid="waitlist-success">
            <div role="status" className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-surface-2 px-4 py-6 text-center">
              <span className="flex size-12 items-center justify-center rounded-full bg-up-soft text-up">
                <DrawnCheck className="size-6" />
              </span>
              <div>
                <p className="break-all font-strong text-[15px] leading-[22px] text-text">{success.email}</p>
                <p className="mt-0.5 text-[13px] leading-5 text-text-2">Early access to the Mainnet beta</p>
              </div>
              {success.account ? (
                <p className="rounded-lg border border-line bg-surface px-2.5 py-1 text-[12px] text-text-2">
                  Linked to <span className="num font-mono text-text">{shortAddress(success.account)}</span>
                </p>
              ) : null}
            </div>
            <p className="text-pretty text-[12.5px] leading-[18px] text-text-3">
              Nothing changes on Testnet: keep trading here. To leave the list or have your email deleted, write to{" "}
              <a href={`mailto:${CONTACT_EMAIL}`} className="text-text-2 underline underline-offset-2 hover:text-text">
                {CONTACT_EMAIL}
              </a>
              .
            </p>
            <div className="flex flex-col gap-2">
              <Button size="lg" block onClick={() => onOpenChange(false)}>
                Done
              </Button>
              <Button
                tone="ghost"
                block
                onClick={() => {
                  reset();
                  setAnother(true);
                }}
              >
                Add another email
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <Field
              label="Email"
              type="email"
              name="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={emailProblem}
              maxLength={254}
              data-testid="waitlist-email"
            />
            {/* A field only bots fill: hidden from people, screen readers and autofill. */}
            <div aria-hidden className="sr-only">
              <label>
                Website
                <input type="text" name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
              </label>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={consentId} className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface-2 px-3 py-3 transition-colors hover:border-line-strong">
                <input
                  id={consentId}
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  aria-invalid={Boolean(consentProblem) || undefined}
                  aria-describedby={consentProblem ? `${consentId}-note` : undefined}
                  className="mt-0.5 size-4 shrink-0 cursor-pointer accent-[var(--primary)]"
                  data-testid="waitlist-consent"
                />
                <span className="text-pretty text-[13px] leading-5 text-text-2">{CONSENT_TEXT}</span>
              </label>
              {consentProblem ? (
                <p id={`${consentId}-note`} className="text-[12px] leading-4 text-down">
                  {consentProblem}
                </p>
              ) : null}
            </div>
            {signedIn && account.address ? (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-3">
                <div className="min-w-0">
                  <p className="font-strong text-[13px] leading-5 text-text">Link my Tredio account</p>
                  <p className="num truncate text-[12px] leading-4 text-text-3">
                    Beta access lands on <span className="font-mono">{shortAddress(account.address)}</span>
                  </p>
                </div>
                <Switch checked={link} onChange={setLink} label="Link my Tredio account" />
              </div>
            ) : null}
            <Button type="submit" size="lg" block loading={join.isPending} data-testid="waitlist-submit">
              Join the waitlist
            </Button>
            {join.error ? <ErrorNote message={join.error instanceof ApiError ? join.error.message : "Joining failed. Try again."} /> : null}
            <p className="text-pretty text-[12px] leading-[18px] text-text-3">
              Tredio keeps your email only for the launch and the beta, and never shares it. See the{" "}
              <a href={PRIVACY_URL} target="_blank" rel="noreferrer" className="text-text-2 underline underline-offset-2 hover:text-text">
                privacy policy
              </a>
              .
            </p>
          </form>
        )}
      </AnimateHeight>
    </Sheet>
  );
}
