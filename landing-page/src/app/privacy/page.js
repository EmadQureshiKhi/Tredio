import Link from "next/link";
import LegalPage, { Company, Contact, Jurisdiction, Table } from "@/components/legal/LegalPage";
import { legalMetadata } from "@/config/legal";

export const metadata = legalMetadata({
  path: "/privacy",
  title: "Privacy policy",
  description:
    "What the Tredio website, app and backend store, the Mainnet waitlist, what stays on your device, and which services receive data.",
});

const sections = [
  {
    id: "controller",
    title: "Who is responsible",
    body: (
      <p>
        <Company />, registered in <Jurisdiction />, operates the website at tredio.bid and the app at
        app.tredio.bid and is responsible for the personal data described here. Contact us about privacy at{" "}
        <Contact />.
      </p>
    ),
  },
  {
    id: "summary",
    title: "The short version",
    body: (
      <ul>
        <li>
          You do not give us a name, email address or phone number to use Tredio. We only have your email if you
          join the <a href="#waitlist">Mainnet waitlist</a>, and we use it for nothing else.
        </li>
        <li>Your account is a passkey on your device. The passkey never reaches us.</li>
        <li>
          We identify you by your account address, which is public, like every transaction your account makes.
        </li>
        <li>Notes and strategies in your vault are encrypted on your device. We only store ciphertext.</li>
        <li>
          This website uses no cookies, analytics or advertising trackers. See the{" "}
          <Link href="/cookies">cookie policy</Link>.
        </li>
      </ul>
    ),
  },
  {
    id: "website",
    title: "This website",
    body: (
      <p>
        tredio.bid is a static marketing site. It sets no cookies, runs no analytics and loads no third-party
        trackers. Like any website, its hosting provider receives technical request data (IP address, browser type,
        page requested and time) to deliver pages and protect the service from abuse, and keeps it in short-lived
        server logs. Its only form is the <a href="#waitlist">Mainnet waitlist</a>, which sends what you enter to the
        Tredio backend.
      </p>
    ),
  },
  {
    id: "backend",
    title: "What the app and backend store",
    body: (
      <>
        <p>When you use the app at app.tredio.bid, the Tredio backend stores the following:</p>
        <Table
          head={["Data", "Why", "Kept"]}
          rows={[
            [
              <><strong>Account addresses</strong>: your account address and the keys it has authorised (trading session keys, Autopilot grant keys).</>,
              "To sign you in, attach your rules, follows and posts to your account, and check its permissions.",
              "While your account uses Tredio.",
            ],
            [
              <><strong>Sign-in tokens</strong>: short-lived tokens issued after your account key or session key signs a request.</>,
              "To keep you signed in. Each request is re-checked against your account. Revoked tokens are recorded by their hash so they stop working.",
              "Until they expire.",
            ],
            [
              <><strong>Follows and rules</strong>: accounts you copy-trade and their settings; Autopilot rules, backtests, grants, positions, orders and an audit log of what they did.</>,
              "To run copy-trading and Autopilot for you and show you their history.",
              "While your account uses Tredio. You can stop rules and follows at any time.",
            ],
            [
              <><strong>Push subscriptions</strong>: the push endpoint and keys your browser creates, and the topics you choose.</>,
              "To send the notifications you turned on.",
              "Until you turn notifications off or the endpoint stops working.",
            ],
            [
              <><strong>Vault</strong>: strategies and notes, sealed on your device with AES-GCM before upload.</>,
              "To sync them across your devices. We store only ciphertext and cannot read it.",
              "Until you delete them.",
            ],
            [
              <><strong>Social content</strong>: posts and calls you publish, with their signatures.</>,
              "To show them in the feed. They are public to other users.",
              "Until removed.",
            ],
            [
              <><strong>Links you submit</strong> for the radar to consider.</>,
              "To review them as possible trends.",
              "As long as the radar needs them.",
            ],
            [
              <><strong>Faucet and activation records</strong>: account, amount and transaction of test-token drips; the IP address that asked to activate an account.</>,
              "To share test tokens fairly and stop abuse of sponsored network fees.",
              "Activation records expire; faucet records are kept to enforce limits.",
            ],
          ]}
        />
        <p>
          The relayer that pays your network fees also keeps per-account and per-IP limits in memory. They reset when it
          restarts.
        </p>
      </>
    ),
  },
  {
    id: "waitlist",
    title: "The Mainnet waitlist",
    body: (
      <>
        <p>
          Tredio runs on Testnet today. If you join the waitlist on this website or in the app, the Tredio
          backend stores:
        </p>
        <ul>
          <li>your email address;</li>
          <li>
            the Tredio account address you chose to link, if you joined in the app while signed in and left
            &ldquo;Link my Tredio account&rdquo; on;
          </li>
          <li>when you joined (and when you last joined again), and whether you joined on the website or in the app;</li>
          <li>that you agreed to the launch email, and whether you were invited or unsubscribed;</li>
          <li>
            a keyed hash of the network address you joined from, used only to stop abuse of the form. The address
            itself is not stored.
          </li>
        </ul>
        <p>
          <strong>Purpose.</strong> To email you when Tredio launches on Mainnet and to invite you to its beta.
          We send nothing before then, we do not add you to other lists, and we never sell or share your email for
          marketing.
        </p>
        <p>
          <strong>Legal basis.</strong> Your consent, given by ticking the box when you join. You can withdraw it at
          any time.
        </p>
        <p>
          <strong>Retention.</strong> Until the Mainnet launch and its beta invitations are done, and at most 12 months
          after the launch. We delete your entry sooner if you unsubscribe or ask us to.
        </p>
        <p>
          <strong>Unsubscribe or delete.</strong> Every email we send has an unsubscribe link. To leave the list or
          have your entry deleted at any time, write to <Contact /> from the address on the list.
        </p>
        <p>
          The list is kept in the backend&apos;s database, run by our hosting provider. When we send the launch
          email, an email delivery service receives your address only to deliver it.
        </p>
      </>
    ),
  },
  {
    id: "device",
    title: "What stays on your device",
    body: (
      <>
        <p>
          Some data never leaves your browser. It is listed in the <Link href="/cookies">cookie policy</Link>, and
          includes:
        </p>
        <ul>
          <li>your passkey, held by your device or password manager;</li>
          <li>
            your trading session key and the keys that open your vault, encrypted under non-extractable browser keys
            in IndexedDB;
          </li>
          <li>your sign-in token (session storage, cleared when you close the tab);</li>
          <li>
            your theme, notification topics, a local record of series you traded, and the email you joined the
            Mainnet waitlist with, if you did (local storage).
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "public-data",
    title: "Public transaction data",
    body: (
      <p>
        Your trades, balances and account settings are recorded on a public ledger and are permanent. Anyone can read
        them, and Tredio indexes them to build portfolios, track records, volumes and leaderboards. We cannot change
        or delete data on that ledger.
      </p>
    ),
  },
  {
    id: "sharing",
    title: "Services that receive data",
    body: (
      <>
        <p>We do not sell personal data. Data reaches these services only as needed to run Tredio:</p>
        <ul>
          <li>
            <strong>The network</strong> Tredio runs on and its infrastructure providers receive the transactions your
            account sends.
          </li>
          <li>
            <strong>The provider of asset perps</strong> receives your account address and orders when you trade asset
            perps.
          </li>
          <li>
            <strong>Push services</strong> run by your browser&apos;s maker deliver notifications you turned on.
          </li>
          <li>
            <strong>Hosting providers</strong> run our website, app and backend services and process the data above
            on our behalf.
          </li>
          <li>
            An <strong>email delivery service</strong> receives the waitlist&apos;s email addresses only when we send
            the Mainnet launch email.
          </li>
        </ul>
        <p>
          <strong>Elfa</strong>, <strong>Bluesky</strong>, <strong>Wikimedia</strong> (Wikipedia pageviews),{" "}
          <strong>GDELT</strong>, <strong>Hacker News</strong> (through Algolia), <strong>CoinGecko</strong>,{" "}
          <strong>GeckoTerminal</strong> and <strong>Nansen</strong> supply public attention data, and the oracle
          records the index made from it. The <strong>AI providers</strong>{" "}
          (OpenAI and Google Gemini) review proposed trends and links submitted to the radar. None of them receive
          your account data from us. <strong>The order book</strong> and <strong>the indexer</strong>{" "}
          work with public transaction data only.
        </p>
      </>
    ),
  },
  {
    id: "legal-basis",
    title: "Legal bases",
    body: (
      <p>
        Where data protection law such as the GDPR applies, we process data to provide the service you ask for
        (contract), to keep Tredio secure and prevent abuse (legitimate interests), to send notifications you
        turned on (consent, which you can withdraw at any time by turning them off), and to email you about the
        Mainnet launch if you joined the waitlist (consent, which you can withdraw at any time by unsubscribing).
      </p>
    ),
  },
  {
    id: "rights",
    title: "Your rights",
    body: (
      <>
        <p>
          Depending on where you live, you may have the right to access, correct, delete or export your personal
          data, to object to or restrict its use, and to complain to your data protection authority. To use them,
          write to <Contact /> from, or with a signature by, the account concerned (for the waitlist, from the email
          address on it).
        </p>
        <p>
          In the app you can delete vault items, turn off notifications, and stop Autopilot rules and follows at
          any time. Data on the public ledger cannot be deleted by anyone.
        </p>
      </>
    ),
  },
  {
    id: "transfers",
    title: "Security and transfers",
    body: (
      <p>
        We encrypt data in transit, keep what we store to a minimum and seal private content on your device. Our
        providers may process data outside your country; where the law requires, we use appropriate safeguards for
        those transfers.
      </p>
    ),
  },
  {
    id: "children",
    title: "Children",
    body: <p>Tredio is not meant for children, and we do not knowingly collect data from them.</p>,
  },
  {
    id: "changes",
    title: "Changes",
    body: (
      <p>
        We will update this policy when Tredio changes what it stores, for example before a Mainnet launch. The date
        at the top shows the latest version.
      </p>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <LegalPage
      path="/privacy"
      title="Privacy policy"
      intro="What Tredio stores, what stays on your device, and who else sees it."
      sections={sections}
    />
  );
}
