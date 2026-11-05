# Tredio backend

The Bun and Hono API on Postgres behind the Tredio app: the trend radar and its AI review, the attention collectors the oracle reads, sign-in, Autopilot rules and backtests, social calls, push, the faucet, activation tickets, the Mainnet waitlist and the public status view.
Each data source has one file in [`src/sources`](src/sources): Elfa, Bluesky, GDELT, Wikipedia, Hacker News, CoinGecko, GeckoTerminal and Nansen.
Nansen's smart-money flows feed the attention index of crypto trends, decide which crypto trends can list, and let Autopilot rules wait for smart money before they trade.
The [root README](../README.md) explains the project as a whole.

## Run

```bash
bun install
bun run dev        # port 4000, applies every migration on start
bun run test       # database tests need TEST_DATABASE_URL
bun run typecheck
```

Copy `.env.example` to `.env` and fill in the keys first.
