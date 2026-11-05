import Link from "next/link";
import LegalPage, { Company, Contact, ExternalLink, GoverningLaw, Jurisdiction } from "@/components/legal/LegalPage";
import { legalMetadata } from "@/config/legal";

export const metadata = legalMetadata({
  path: "/terms",
  title: "Legal notice & terms of use",
  description:
    "Who operates Tredio at tredio.bid and the terms for using the Tredio website and the app on NEAR testnet at app.tredio.bid.",
});

const sections = [
  {
    id: "operator",
    title: "Legal notice",
    body: (
      <>
        <p>
          The website at <strong>tredio.bid</strong> and the Tredio app at <strong>app.tredio.bid</strong> (together,
          &ldquo;Tredio&rdquo;) are operated by <Company />, registered in <Jurisdiction />.
        </p>
        <p>
          Contact: <Contact />. &ldquo;We&rdquo;, &ldquo;us&rdquo; and &ldquo;our&rdquo; in these terms mean{" "}
          <Company />.
        </p>
      </>
    ),
  },
  {
    id: "acceptance",
    title: "Accepting these terms",
    body: (
      <p>
        By using Tredio you agree to these terms, our <Link href="/privacy">privacy policy</Link> and our{" "}
        <Link href="/cookies">cookie policy</Link>. If you do not agree, do not use Tredio. You must be old enough
        to enter a binding contract where you live, and you may not use Tredio where doing so would break the law
        that applies to you.
      </p>
    ),
  },
  {
    id: "service",
    title: "What Tredio is",
    body: (
      <>
        <p>
          Tredio turns social attention into markets on the NEAR network. A radar reads Elfa, Bluesky, Nansen,
          CoinGecko, GeckoTerminal, Wikipedia and other public sources and proposes trends. A model on{" "}
          <ExternalLink href="https://near.ai">NEAR AI Cloud</ExternalLink> reviews each one and signs its verdict.
          An oracle running in an OutLayer trusted execution environment (TEE) computes an attention index from 0 to
          100 for each listed trend and records it on NEAR. Passkey accounts can then trade:
        </p>
        <ul>
          <li>Up/Down outcome series on Tredio&apos;s own order book, settled in USDC;</li>
          <li>attention perps on a trend&apos;s index, at up to 3x leverage;</li>
          <li>trend coins on bonding curves, which can graduate into a Rhea Finance pool;</li>
          <li>Hyperliquid perps on the asset behind a trend, placed from your NEAR account through Chain Signatures.</li>
        </ul>
        <p>
          Tredio also offers Autopilot rules, copy-trading, public calls with a leaderboard, curation rewards, share
          cards, notifications, an MCP server and a pay-per-call API for software agents, and a portfolio built from
          public market data.
        </p>
      </>
    ),
  },
  {
    id: "testnet",
    title: "NEAR testnet only, tokens of no value",
    body: (
      <>
        <p>
          Tredio currently runs on <strong>NEAR testnet</strong> only. Nothing on Tredio is live on mainnet.
        </p>
        <ul>
          <li>
            Testnet USDC, outcome tokens, trend coins, perp positions, Hyperliquid testnet positions and every other
            balance on Tredio are <strong>test assets with no monetary value</strong>. They cannot be sold for money or
            exchanged for anything of value, and we will never buy them back.
          </li>
          <li>
            Test assets from faucets are free and limited. Do not buy, sell or accept anything of value for them.
          </li>
          <li>
            Testnet networks, contracts, markets and balances can be reset, redeployed, paused or wiped at any time,
            without notice.
          </li>
          <li>
            Deposits from other chains through NEAR Intents are planned for mainnet only; on testnet the app shows
            quotes at most. Never send real funds or mainnet assets to a Tredio address. They may be lost for good.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "accounts",
    title: "Non-custodial passkey accounts",
    body: (
      <>
        <p>
          A Tredio account is a NEAR account controlled by a passkey on your device, such as Face ID or a security
          key. Tredio is non-custodial:
        </p>
        <ul>
          <li>Your passkey never leaves your device or your password manager. We never see or hold it.</li>
          <li>We do not hold your assets and cannot move them without a signature from your account.</li>
          <li>
            We cannot recover a lost passkey, reverse a transaction or restore an account. Keep your passkey safe
            and backed up through your device or password manager.
          </li>
          <li>
            Trading sessions, Autopilot grants and policy wallets act only within the permissions and limits you
            approve with your passkey, until they expire or you revoke them.
          </li>
        </ul>
        <p>
          A relayer may pay network fees for your transactions within daily and hourly limits. We can change or stop
          that sponsorship at any time.
        </p>
      </>
    ),
  },
  {
    id: "no-advice",
    title: "No investment advice",
    body: (
      <>
        <p>
          Nothing on Tredio is financial, investment, legal or tax advice, a recommendation, or an offer or
          solicitation to buy or sell anything. Attention indexes, radar trends, prices, charts, leaderboards,
          track records, Autopilot rules, backtests and other users&apos; posts are information only.
        </p>
        <p>
          Past results, including backtests and leaderboard positions, say nothing reliable about the future. You
          alone decide what to do and are responsible for it. Talk to a licensed professional before making any
          financial decision.
        </p>
      </>
    ),
  },
  {
    id: "markets",
    title: "Markets, oracle and smart contracts",
    body: (
      <>
        <ul>
          <li>
            The attention index is computed from third-party data (social mentions, news coverage, Wikipedia
            pageviews, trending lists and smart-money flows), on trends an AI review helped choose. That data can be
            wrong, late, incomplete or unavailable, and the index may not match what you expect. An attested
            computation shows how a value was produced from its inputs; it does not make the inputs right.
          </li>
          <li>
            Markets settle by the rules in their smart contracts and the values the oracle records. Settled outcomes
            are final, even when an input later turns out to be wrong.
          </li>
          <li>
            Smart contracts, the relayer, keepers and market makers are experimental software and can have bugs, stop
            or behave unexpectedly. Positions can be liquidated, and trends can be retired.
          </li>
          <li>
            Transactions are public and cannot be undone. Check every transaction before you approve it.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "automation",
    title: "Autopilot and copy-trading",
    body: (
      <p>
        Autopilot rules and copy-trading place trades for you automatically, within the permissions you grant, and
        agents you connect through the MCP server or the API act on what you allow them to. They
        can fail, trigger late, fill at different prices or not at all, and a leader you follow can lose. You are
        responsible for every rule you enable and every account you follow. You can pause, stop or revoke them at
        any time in the app.
      </p>
    ),
  },
  {
    id: "third-parties",
    title: "Third-party services",
    body: (
      <>
        <p>
          Tredio relies on services run by others. We do not control them, and their own terms and policies apply
          when you use them through Tredio:
        </p>
        <ul>
          <li>
            <ExternalLink href="https://near.org">NEAR</ExternalLink>, the network Tredio&apos;s accounts and markets run
            on, its Chain Signatures service, and the RPC and data providers that connect to it;
          </li>
          <li>
            <ExternalLink href="https://near.ai">NEAR AI Cloud</ExternalLink>, which reviews proposed trends with
            verifiable models;
          </li>
          <li>
            <ExternalLink href="https://outlayer.ai">OutLayer</ExternalLink>, whose trusted execution environment runs
            the attention oracle;
          </li>
          <li>
            <ExternalLink href="https://hyperliquid.xyz">Hyperliquid</ExternalLink>, which runs the perps on underlying
            assets (its testnet while Tredio is on NEAR testnet);
          </li>
          <li>
            <ExternalLink href="https://rhea.finance">Rhea Finance</ExternalLink>, where trend coins graduate into
            liquidity pools;
          </li>
          <li>NEAR Intents, which will carry deposits and withdrawals from other chains on mainnet;</li>
          <li>the issuer of USDC, the settlement asset on mainnet (testnet USDC is a Tredio test token);</li>
          <li>
            <ExternalLink href="https://www.elfa.ai">Elfa</ExternalLink>,{" "}
            <ExternalLink href="https://bsky.app">Bluesky</ExternalLink>,{" "}
            <ExternalLink href="https://www.wikimedia.org">Wikimedia</ExternalLink> (Wikipedia pageviews),{" "}
            <ExternalLink href="https://www.gdeltproject.org">GDELT</ExternalLink> (news coverage),{" "}
            <ExternalLink href="https://news.ycombinator.com">Hacker News</ExternalLink> (searched through{" "}
            <ExternalLink href="https://hn.algolia.com">Algolia</ExternalLink>) and{" "}
            <ExternalLink href="https://www.nansen.ai">Nansen</ExternalLink>, the attention data sources;
          </li>
          <li>
            <ExternalLink href="https://www.coingecko.com">CoinGecko</ExternalLink> and{" "}
            <ExternalLink href="https://www.geckoterminal.com">GeckoTerminal</ExternalLink>, whose trending coins and
            pools the radar reads.
          </li>
        </ul>
        <p>
          Names and logos of these services belong to their owners. Tredio shows them to say which services it uses;
          that does not mean they endorse or sponsor Tredio. Wikipedia is a trademark of the Wikimedia Foundation, and
          Tredio is not endorsed by or affiliated with the Wikimedia Foundation. Smart-money flow data is provided by
          Nansen. Trending coin data is from <ExternalLink href="https://www.coingecko.com">CoinGecko</ExternalLink>{" "}
          and trending pool data from <ExternalLink href="https://www.geckoterminal.com">GeckoTerminal</ExternalLink>,
          and the app credits them next to the trends they surface.
        </p>
      </>
    ),
  },
  {
    id: "use",
    title: "Acceptable use",
    body: (
      <>
        <p>When you use Tredio you agree not to:</p>
        <ul>
          <li>break any law or rights of others, including sanctions and market-abuse rules;</li>
          <li>
            attack, overload, probe or reverse-engineer Tredio&apos;s services beyond normal use, or get around
            rate limits, faucet limits or fee budgets;
          </li>
          <li>create accounts or posts in bulk, impersonate others, or post unlawful, abusive or misleading content;</li>
          <li>try to manipulate an attention index, an oracle report or a market.</li>
        </ul>
        <p>
          We may limit, suspend or block access to Tredio&apos;s website, app, relayer, faucet or social features
          for anyone who breaks these terms. Your account and assets stay under your control.
        </p>
      </>
    ),
  },
  {
    id: "content",
    title: "Your content",
    body: (
      <p>
        Posts, calls and other content you publish on Tredio are signed by your account and visible to other users.
        You keep any rights you have in them and give us a worldwide, free licence to host, show and distribute them
        as part of Tredio. You are responsible for what you post. We may remove content that breaks these terms or
        the law.
      </p>
    ),
  },
  {
    id: "ip",
    title: "Intellectual property",
    body: (
      <p>
        The Tredio name, logo, website design and text belong to <Company /> or its licensors. You may not copy
        them to suggest that you are Tredio or that we endorse you. Open-source code we publish is covered by its
        own licence.
      </p>
    ),
  },
  {
    id: "disclaimer",
    title: "Disclaimers and liability",
    body: (
      <>
        <p>
          Tredio is experimental and provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;, without
          warranties of any kind, to the fullest extent the law allows. We do not promise that it will be accurate,
          available, secure or free of errors.
        </p>
        <p>
          To the fullest extent the law allows, we are not liable for indirect or consequential losses, lost profits,
          lost data, or losses caused by third-party services, networks, oracles, smart contracts or your own
          devices and keys. Nothing in these terms limits liability that cannot be limited by law.
        </p>
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes and governing law",
    body: (
      <>
        <p>
          We may update these terms, for example before Tredio launches on NEAR mainnet. The date at the top shows
          the latest version. If you keep using Tredio after a change, the new terms apply.
        </p>
        <p>
          These terms are governed by the laws of <GoverningLaw />, and the courts of <Jurisdiction /> have
          jurisdiction, unless the law where you live gives you the right to use your local courts and laws.
        </p>
      </>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p>
        Questions about these terms: <Contact />.
      </p>
    ),
  },
];

export default function TermsPage() {
  return (
    <LegalPage
      path="/terms"
      title="Legal notice & terms of use"
      intro="Who runs Tredio, and the rules for using the website and the app on NEAR testnet."
      sections={sections}
    />
  );
}
