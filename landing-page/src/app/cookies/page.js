import Link from "next/link";
import LegalPage, { Contact, Table } from "@/components/legal/LegalPage";
import { legalMetadata } from "@/config/legal";

export const metadata = legalMetadata({
  path: "/cookies",
  title: "Cookie policy",
  description:
    "Tredio sets no cookies and runs no analytics. This page lists the browser storage the app uses to work.",
});

const sections = [
  {
    id: "no-cookies",
    title: "No cookies, no trackers",
    body: (
      <>
        <p>
          The website at tredio.bid and the app at app.tredio.bid <strong>set no cookies</strong>. They run no
          analytics, advertising or social-media trackers, and they do not load third-party scripts that could set
          their own. That is why you will not see a cookie banner here.
        </p>
        <p>
          If we ever add analytics or anything else that is not strictly necessary, we will update this page first
          and ask for your consent where the law requires it.
        </p>
      </>
    ),
  },
  {
    id: "storage",
    title: "Browser storage the app uses",
    body: (
      <>
        <p>
          The app keeps a few items in your browser&apos;s own storage so that it works. They stay on your device,
          are only readable by app.tredio.bid, and are strictly necessary for the features you use:
        </p>
        <Table
          head={["Name", "Where", "What it is for", "How long"]}
          rows={[
            ["Session key store", "IndexedDB", "Your trading session key, encrypted under a key the browser cannot export, so you trade on NEAR testnet without a passkey prompt each time.", "Until the session expires or you clear site data"],
            ["Private key store", "IndexedDB", "The keys that open your vault and sign your posts, encrypted the same way.", "Until you clear site data"],
            ["Sign-in token", "Session storage", "Your sign-in token for the Tredio backend.", "Until you close the tab"],
            [<code key="e">tredio.theme</code>, "Local storage", "Light or dark theme, if you picked one.", "Until you change it or clear site data"],
            [<code key="f">tredio.push.topics</code>, "Local storage", "Which notification topics you turned on.", "Until you change them or clear site data"],
            [<code key="g">tredio.push.added</code>, "Local storage", "Notification topics added after you chose your list, so each is added once.", "Until you clear site data"],
            [<code key="i">tredio.faucet-claims</code>, "Local storage", "When each account last claimed test USDC from the faucet, so the button shows when the next claim opens.", "Until you clear site data"],
            [<code key="h">tredio.waitlist</code>, "Local storage", "The email you joined the Mainnet waitlist with, and whether you closed its banner, so the app shows that you joined.", "Until you clear site data"],
          ]}
        />
        <p>
          Your passkey itself is kept by your device or password manager, not by Tredio. The marketing website at
          tredio.bid stores nothing in your browser.
        </p>
      </>
    ),
  },
  {
    id: "control",
    title: "How to remove it",
    body: (
      <p>
        You can clear all of it at any time in your browser&apos;s settings (site data for app.tredio.bid). You will
        then need your passkey to sign in again, and nothing else is lost: your account and assets live on NEAR, not in your browser,
        and your vault is stored encrypted by the backend. More about what we store is in the{" "}
        <Link href="/privacy">privacy policy</Link>.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p>
        Questions about this policy: <Contact />.
      </p>
    ),
  },
];

export default function CookiesPage() {
  return (
    <LegalPage
      path="/cookies"
      title="Cookie policy"
      intro="Short, because there is not much to say: Tredio uses no cookies."
      sections={sections}
    />
  );
}
