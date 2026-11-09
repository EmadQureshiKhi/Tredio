# @tredio/mcp

An MCP server that lets AI agents read Tredio's attention markets on NEAR and, within limits the user sets, trade them.
It answers from Tredio's public API and, where the truth is on chain, from NEAR RPC views of the Tredio contracts.
Every tool returns structured JSON.
It runs on stdio with Bun and is private to this workspace (it is not published to npm).

## Read tools

| Tool | What it answers |
| --- | --- |
| `get_status` | Services, oracle freshness, chain head, service wallets and contract ids |
| `list_trends` | Listed trends with index, peak, 24h change, status and review hash |
| `get_trend` | One trend: registry index and freshness, latest source readings, its series, perp and coin |
| `get_index_history` | Index over time: 7 days from the API mirror, or the registry's last 96 checkpoints |
| `get_market` | An Up/Down series with fair value, last prices and book depth per side |
| `get_perp_market` | Attention perp open interest, funding, mark, open interest cap and pool |
| `get_coin` | Trend coin curve, spot price and an optional buy quote |
| `get_review` | NEAR AI Cloud review evidence and the exact request and response it signed, with the hash, the TEE signature and both body hashes re-checked |
| `verify_index` | The newest checkpoint's oracle report, its ed25519 signature checked as the registry does |
| `get_account` | USDC, perp positions, sessions, curation fees, outcome holdings and open orders |
| `get_leaders` | Trader, caller or Hyperliquid leaderboards |
| `list_candidates` | Approved topics waiting for a live slot |
| `get_paid_api` | The x402 paid resources and their prices |
| `buy_trend_history` | Only with a payer key: pays the x402 price for a trend's full history |

These tools send nothing, except `buy_trend_history`, which spends USDC and appears only when a payer key is set.

## Trade tools

The trade tools appear when a trading key is configured (see Signing).
Each one is a dry run unless it gets `confirm: true`: the dry run answers the quote, the exact contract calls it would send, and whether the policy allows them.
With `confirm: true` it quotes again, checks the policy, reserves the spend in the ledger, sends, and records the transaction.

| Tool | What it does | Spends | Session key | Own key |
| --- | --- | --- | --- | --- |
| `buy_outcome` | Buys Up or Down tokens of a series through an anchored swap on the book | `usdc` | yes (`swap`) | yes |
| `sell_outcome` | Sells Up or Down tokens through an anchored swap | nothing | yes (`swap`) | yes |
| `open_perp` | Opens an attention perp position, 1x to 3x | `margin` | yes (`perp_open`) | yes |
| `close_perp` | Closes one of the account's perp positions | nothing | yes (`perp_close`) | yes |
| `add_perp_margin` | Adds margin to one of the account's perp positions | `usdc` | no | yes |
| `buy_coin` | Buys a trend coin on its bonding curve | `usdc` | no | yes |
| `sell_coin` | Sells a trend coin back to its curve | nothing | no | yes |
| `post_call` | Posts a public call (up or down, 24h or 7d) on a live trend | nothing | caller key | caller key |
| `get_trading_policy` | The signer, the policy, today's spend and today's trades | | | |

Quotes come from the contracts themselves: the book's depth and the registry's attention-implied value (`fair_up`) for Up/Down, the registry's index and the perps market for perps (the same arithmetic as the contracts, in `src/quote.ts`), and the coins factory's own `quote_buy` and `quote_sell` for coins.
Every trade carries its bound: Up/Down swaps are anchored (they fill only within 0.10 USDC of the implied value, and only on a fresh index) with a `min_out` from the quote less `slippageBps`; perps carry an `acceptable_index`; coin trades a `min_out`.
A refusal the contracts log instead of failing (`open_refused`, `trade_refused`) is reported as a refusal, and the USDC it returned does not count against the day.

## Signing

Two signing paths work without a person present; configure one of them.

- **A passkey account's session key** (`TREDIO_SESSION_ACCOUNT`, `TREDIO_SESSION_KEY`).
  A session is a function-call key (usually a gas key) on the user's `0u...` account that may call only `session_call` with typed actions, within the session's expiry, scope and on-chain daily USDC limit, which the account contract enforces on top of this server's policy.
  It trades Up/Down (`swap`, always anchored) and opens and closes perps (`perp_open`, `perp_close`).
  Margin top-ups and coin trades are owner actions the passkey signs (`owner_execute`), so a session cannot send them; with a session key those tools still quote and say why they cannot send.
  The account's code version sets the gas (150 Tgas on v2, 300 on v1), and a gas key must hold what one call prepays (0.15 or 0.3 NEAR); with `TREDIO_RELAYER_URL` the relayer refills the gas key and the account's contract storage, as it does for the app.
  The owner adds the session for the server's public key with one passkey approval (owner action `add_session`, scope `outcomes` and `perps`, a small daily limit) and can revoke it at any time.
  The app does not yet have a screen that approves a session for an outside key (it adds sessions for the browser and for Autopilot), so today this path serves accounts whose owner request is signed elsewhere, such as the test accounts `scripts/e2e-testnet.ts` creates.
- **A NEAR account's own key** (`TREDIO_TRADER_ACCOUNT`, `TREDIO_TRADER_PRIVATE_KEY`, a full-access key, since token calls attach 1 yoctoNEAR).
  It calls the contracts itself: `ft_transfer_call` of USDC to the book, the perps contract or the coins factory with the matching `msg`, `mt_transfer_call` of outcome tokens to the book, `ft_transfer_call` of coins back to the factory, and `close` on the perps contract.
  It can do everything, coin trades and margin top-ups included.
  Before its first trade at a contract it registers storage there (`storage_deposit`: 0.02 NEAR at `outcomes`, 0.01 at `perps`, the USDC registration), shown in the dry run's calls; that NEAR is outside the USDC policy.
  It needs NEAR for gas: a call reserves up to 0.25 NEAR of prepaid gas while it runs and burns a few thousandths.

Calls (`post_call`) are signed by a caller identity, any ed25519 key: the caller id is its public key in hex, and the server signs the call text exactly as the API rebuilds it (`backend/src/social/routes.ts`).
It is `TREDIO_CALLER_KEY`, or the NEAR account's own key when that is the signer.
This is the agent's own identity, never the person's: a passkey account's caller identity is derived from the passkey's PRF output inside the app and never leaves the device, so an agent cannot post as the person.

## Policy

Without a policy nothing may send; the dry runs still work.
The policy is JSON in `TREDIO_POLICY`, or a file named by `TREDIO_POLICY_FILE`:

```json
{
  "dailyCapUsdc": "25",
  "tools": {
    "buy_outcome": { "maxUsdc": "5" },
    "sell_outcome": true,
    "open_perp": { "maxUsdc": "10" },
    "close_perp": true,
    "add_perp_margin": { "maxUsdc": "5" },
    "buy_coin": { "maxUsdc": "2" },
    "sell_coin": true,
    "post_call": true
  },
  "ledgerFile": "tredio-ledger.json"
}
```

- `tools` is the allowlist: a tool not named never sends.
- Each spending tool (`buy_outcome`, `open_perp`, `add_perp_margin`, `buy_coin`) needs `maxUsdc`, its cap per call; the others take `true` or `{}`.
- `dailyCapUsdc` caps what the spending tools send together per UTC day.
- Amounts are decimal USDC (strings or numbers); an unknown key, a spending tool without a cap or a cap on a tool that spends nothing is an error at start.
- `ledgerFile` (optional, relative to the policy file) or `TREDIO_LEDGER_FILE` names the ledger; the default is `~/.tredio-mcp/ledger-<network>.json`.

The ledger is a JSON file of every confirmed trade: tool, arguments, account, signer, USDC, status (`pending`, `sent`, `failed`, `refused`, `unknown`) and transaction hash (`call:<id>` for calls).
A confirmed trade is checked and reserved under a lock file before it is sent, so parallel calls, or two servers sharing the file, cannot pass the daily cap together, and a restart keeps the day's spend.
Spends that are pending, sent, or sent with no answer (`unknown`) count; a transaction the chain ran and failed, or a logged refusal, returned the USDC and does not.
A ledger that does not parse stops every trade rather than starting the day over.
The policy is read at start; restart the server after changing it.

## Configuration

All settings come from env.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TREDIO_API_URL` | `http://localhost:4000` | The Tredio API |
| `NEAR_NETWORK` | `testnet` | `testnet` (Tredio has no mainnet deployment yet) |
| `NEAR_RPC_URLS` | FastNEAR, Intear, dRPC | Comma-separated RPC endpoints, tried in order |
| `FASTNEAR_API_KEYS` | unset | FastNEAR API keys, taken in turn ahead of those |
| `NEAR_TX_API_URL` | `https://tx.test.fastnear.com` | Transaction index used to find oracle reports |
| `TREDIO_X402_ACCOUNT` | unset | Payer account for `buy_trend_history` |
| `TREDIO_X402_PRIVATE_KEY` | unset | Its full-access key (`ed25519:...`) |
| `TREDIO_X402_MAX_USDC` | `0.05` | The most one x402 call may pay |
| `TREDIO_TRADER_ACCOUNT` | unset | A NEAR account that trades with its own key |
| `TREDIO_TRADER_PRIVATE_KEY` | unset | Its full-access key (`ed25519:...`) |
| `TREDIO_SESSION_ACCOUNT` | unset | A passkey account (`0u...`) that trades through a session |
| `TREDIO_SESSION_KEY` | unset | The session's secret key (`ed25519:...`) |
| `TREDIO_CALLER_KEY` | the trader's key | An ed25519 key that signs calls |
| `TREDIO_POLICY` | unset | The trading policy as JSON |
| `TREDIO_POLICY_FILE` | unset | Or a file holding it |
| `TREDIO_LEDGER_FILE` | `~/.tredio-mcp/ledger-<network>.json` | The ledger |
| `TREDIO_RELAYER_URL` | unset | Tredio's relayer, to refill a session's gas key and storage |

Use a dedicated account or session that holds little USDC, keep its key in your MCP client's env, never in a file you commit, and keep the policy's caps small.

## Claude Desktop

Add this to `claude_desktop_config.json` (Settings, Developer, Edit Config), with the absolute path of your checkout:

```json
{
  "mcpServers": {
    "tredio": {
      "command": "bun",
      "args": ["/absolute/path/to/Tredio/packages/mcp/src/bin.ts"],
      "env": {
        "TREDIO_API_URL": "http://localhost:4000",
        "NEAR_NETWORK": "testnet",
        "TREDIO_TRADER_ACCOUNT": "my-agent.testnet",
        "TREDIO_TRADER_PRIVATE_KEY": "ed25519:...",
        "TREDIO_POLICY_FILE": "/absolute/path/to/tredio-policy.json"
      }
    }
  }
}
```

Leave out the trading variables for a read-only server.

## Claude Code

```sh
claude mcp add tredio --env TREDIO_API_URL=http://localhost:4000 -- bun /absolute/path/to/Tredio/packages/mcp/src/bin.ts
```

Or share it with the project in `.mcp.json` at the repository root:

```json
{
  "mcpServers": {
    "tredio": { "command": "bun", "args": ["packages/mcp/src/bin.ts"], "env": { "TREDIO_API_URL": "http://localhost:4000" } }
  }
}
```

Run `pnpm install` in the workspace first.

## Live check on testnet

`test/live-trade.test.ts` drives the stdio binary through each trade on NEAR testnet with a small policy of its own (10 USDC a day).
On 2026-11-09 it ran with both signing paths on `person:stephen-miller.2` (Up/Down series 39).

A plain testnet account, `mcp-agent-to8zd1.tredio-treasury.testnet`, funded with 1.5 NEAR from the treasury and 1,000 test USDC from the USDC faucet, with its own key:

| Tool | Transaction | Result |
| --- | --- | --- |
| `buy_outcome` | [`HEJWURxT...`](https://testnet.nearblocks.io/txns/HEJWURxTKkDptGvfEueuHJthdWCR1mVxT8uuEpFX2JD1) | 1.883 Up for 0.999985 USDC |
| `sell_outcome` | [`A5HRuPjQ...`](https://testnet.nearblocks.io/txns/A5HRuPjQWq1FnTQWDCWdVWjjntwK3PURxzPLLqrgdctP) | 0.941 Up for 0.441386 USDC |
| `open_perp` | [`2wB1ipj4...`](https://testnet.nearblocks.io/txns/2wB1ipj4PEY8sqRMjNCFdJPUcY2CaAT1gtU3agqzTozz) | position 23, long, 2 USDC margin at 1x |
| `close_perp` | [`BfoqJy1x...`](https://testnet.nearblocks.io/txns/BfoqJy1xbsvR7NJuLhChddxiK4EVcfmsttM29tZbsZcf) | paid out 1.995987 USDC |
| `buy_coin` | [`8HhVnbfm...`](https://testnet.nearblocks.io/txns/8HhVnbfm4cig4u3aKJQW4aWuvtoxo8QGxKhe5KxzJtKo) | 494,755.096 coins for 1 USDC |
| `sell_coin` | [`DfrzJZ5j...`](https://testnet.nearblocks.io/txns/DfrzJZ5jq7rhm2P89fMVqcKtpLjpTHRcMLw9vj7TV3Bm) | sold back for 0.980099 USDC |
| `post_call` | call 11 on the local API | caller `cd80b086...`, the account's key |

A passkey account, `0u6xynn4...` (from `scripts/e2e-testnet.ts`), through its session key:

| Tool | Transaction | Result |
| --- | --- | --- |
| `buy_outcome` | [`DTSDExn2...`](https://testnet.nearblocks.io/txns/DTSDExn2sEmA5wDzgkhG18V4jFaWcEAKqZZ2R1ky631g) | 1.883 Up for 0.999985 USDC |
| `sell_outcome` | [`EMtsRaLM...`](https://testnet.nearblocks.io/txns/EMtsRaLMrzhRQkp6wwzcTZ89YC9nuFZHripwCnTDf2VU) | 0.941 Up for 0.441386 USDC |
| `open_perp` | [`3QVfdnE3...`](https://testnet.nearblocks.io/txns/3QVfdnE3AEXCiL2bCcRnmTRuLJxMPBQx19LYRhB1Beyc) | position 24, long, 2 USDC margin at 1x |
| `close_perp` | [`HKdktBER...`](https://testnet.nearblocks.io/txns/HKdktBERSBAWy1rynVUfojK2de27qzeXyqgPMSKW3jxz) | paid out 1.995986 USDC |
| `buy_coin` | not sent | the dry run answers that a coin trade is an owner action |

## Development

```sh
bun test                                           # tools over the SDK's in-memory transport, stubbed API and chain
TREDIO_LIVE=1 bun test test/live.test.ts           # the read tools: the stdio binary against TREDIO_API_URL and NEAR testnet
TREDIO_LIVE_TRADE=1 TREDIO_TRADER_ACCOUNT=... TREDIO_TRADER_PRIVATE_KEY=... bun test test/live-trade.test.ts   # real testnet trades
bun run typecheck
```
