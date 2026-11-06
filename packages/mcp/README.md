# @tredio/mcp

An MCP server that lets AI agents read Tredio's attention markets on NEAR.
It answers from Tredio's public API and, where the truth is on chain, from NEAR RPC views of the Tredio contracts.
Every tool returns structured JSON.
It runs on stdio with Bun and is private to this workspace (it is not published to npm).

## Tools

| Tool | What it answers |
| --- | --- |
| `get_status` | Services, oracle freshness, chain head, service wallets and contract ids |
| `list_trends` | Listed trends with index, peak, 24h change, status and review hash |
| `get_trend` | One trend: registry index and freshness, latest source readings, its series, perp and coin |
| `get_index_history` | Index over time: 7 days from the API mirror, or the registry's last 96 checkpoints |
| `get_market` | An Up/Down series with fair value, last prices and book depth per side |
| `get_perp_market` | Attention perp open interest, funding, mark, open interest cap and pool |
| `get_coin` | Trend coin curve, spot price and an optional buy quote |
| `get_review` | NEAR AI Cloud review evidence, with the hash and the TEE signature re-checked |
| `verify_index` | The newest checkpoint's oracle report, its ed25519 signature checked as the registry does |
| `get_account` | USDC, perp positions, sessions, curation fees, outcome holdings and open orders |
| `get_leaders` | Trader, caller or Hyperliquid leaderboards |
| `list_candidates` | Approved topics waiting for a live slot |
| `get_paid_api` | The x402 paid resources and their prices |
| `buy_trend_history` | Only with a payer key: pays the x402 price for a trend's full history |

All tools are read-only except `buy_trend_history`, which spends USDC and appears only when a payer key is set.

## Configuration

All settings come from env.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TREDIO_API_URL` | `http://localhost:4000` | The Tredio API |
| `NEAR_NETWORK` | `testnet` | `testnet` (Tredio has no mainnet deployment yet) |
| `NEAR_RPC_URLS` | FastNEAR, Intear, NEAR | Comma-separated RPC endpoints, tried in order |
| `NEAR_TX_API_URL` | `https://tx.test.fastnear.com` | Transaction index used to find oracle reports |
| `TREDIO_X402_ACCOUNT` | unset | Payer account for `buy_trend_history` |
| `TREDIO_X402_PRIVATE_KEY` | unset | Its full-access key (`ed25519:...`) |
| `TREDIO_X402_MAX_USDC` | `0.05` | The most one call may pay |

Use a dedicated payer account that holds little USDC, and keep its key in your MCP client's env, never in a file you commit.

## Claude Desktop

Add this to `claude_desktop_config.json` (Settings, Developer, Edit Config), with the absolute path of your checkout:

```json
{
  "mcpServers": {
    "tredio": {
      "command": "bun",
      "args": ["/absolute/path/to/Tredio/packages/mcp/src/bin.ts"],
      "env": { "TREDIO_API_URL": "http://localhost:4000", "NEAR_NETWORK": "testnet" }
    }
  }
}
```

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

## Development

```sh
bun test                                   # tools over the SDK's in-memory transport, stubbed API and chain
TREDIO_LIVE=1 bun test test/live.test.ts   # the stdio binary against TREDIO_API_URL and NEAR testnet
bun run typecheck
```
