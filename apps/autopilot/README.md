# Tredio Autopilot executor

The service that runs Autopilot rules and copy-trading on Hyperliquid perps.
An Autopilot rule reads like a sentence: when a trend's attention index moves enough, optionally with smart money agreeing, open a Hyperliquid position with a stop-loss, a take-profit, a maximum hold and loss limits.
Copy-trading mirrors a real Hyperliquid trader's positions onto followers within each follower's own caps.
The rule engine, backtester, copy sizing and sealed grants live in [`packages/autopilot`](../../packages/autopilot); the backend owns the API and the tables this service works through.

## How an order goes out

Every account trades from its own Hyperliquid address, the EVM address of its Chain Signatures key (path `hyperliquid`).
An account grants Autopilot a session of its own: label `autopilot`, Hyperliquid scope only, a gas key the account contract limits to `session_call`.
The app generates that key in the browser and seals it to this executor's public key, so the API server only ever stores the sealed box; the executor opens it, bound to the account and the key, and keeps it in memory.
The Tredio bot trades the same way from its own account, through its own Autopilot session key from the environment.

For each order the executor:

1. checks on chain that the session is still live and tops its gas key up through the relayer when it runs low;
2. sets isolated leverage first when the market is not at it already (a whole number, at most 10x, the contract's cap);
3. builds an immediate-or-cancel limit at the worst acceptable price, the mark plus or minus the slippage, rounded toward the mark with `formatPrice`, and sizes it with `formatSize`;
4. checks the account's order guard before paying for the transaction: Tredio's mark for the asset is fresh and the price is within 2% of it;
5. sends `session_call` with the session key as a gas key, takes the EVM signature from the transaction's result and checks it recovers to the account's Hyperliquid address;
6. posts exactly the action the contract hashed to Hyperliquid and records Hyperliquid's answer.

Every order is recorded as `pending` with a unique intent and its Hyperliquid nonce before anything is sent, then `sent` once the account has signed it, then `filled`, `unfilled` or `failed`.
A retry sends the same action with the same nonce, which Hyperliquid runs at most once; an order Hyperliquid has seen, or one in flight for more than two minutes, is settled from the account's fills.

## Each tick

1. Finish orders left in flight by an earlier tick.
2. Reconcile recorded positions with Hyperliquid's `clearinghouseState` of each account: a position Hyperliquid no longer holds was liquidated or closed by hand, and is closed with the reason and Hyperliquid's own fills when they show it.
3. Evaluate every enabled rule, and every paused or stopped rule that still holds a position, with the engine's `evaluate`: open, close or wait.
   Daily loss and cooldown come from the rule's recorded trades; a pause manages the position to its exit, the owner's stop closes it now.
4. Copy leaders: snapshot each followed leader's positions from Hyperliquid mainnet, diff them against `leader_holdings` with `diffHolding`, and mirror each change to every active follow with `mirror`.
   A follow whose open copies reach its loss cap is paused and closed out; a copy whose leader left the market is closed again each tick until it is gone.

The kill switch (the admin switch, or `KILL_SWITCH` in the environment) closes every position a rule holds (the engine's `kill` exit) and opens nothing: rule openings wait and copied openings are skipped, while copied reductions and loss-cap close-outs go on.
It closes nothing by itself.
Rules pause when the account has to act (no grant, a revoked session, three failed orders in a row) and wait when the executor does (a stale mark, too little margin, no seal key).
Every decision, order and failure is in `autopilot_audit`.

## Run

```bash
pnpm install
bun run seal-keys            # once: a key pair for sealed grants (the public half goes to the backend)
cp .env.example .env         # then fill it in
bun run start                # health on port 4400
bun run test                 # DB tests need TEST_DATABASE_URL (each run uses its own schema)
bun run typecheck
```

The executor logs its seal public key at start; the backend's `AUTOPILOT_SEAL_PUBLIC_KEY` must be that key.
`GET /health` reports the loop, the bot's account and session gas key, alerts, the last error, facts for the status page and the kill switch as a flag; `GET /live` answers as long as the process serves.

To check a deployment end to end, `bun run order` sends one order through a session exactly as the executor does and prints each step with Hyperliquid's answer (see the comment at the top of `scripts/order.ts`).

## Limits worth knowing

- The account guard needs a Tredio mark for the asset no older than two minutes (five on v2 account code), so Autopilot trades only assets the oracle reports marks for (BTC, ETH, SOL, NEAR, HYPE and live trends' assets).
  On v2 the mark must also name the asset index the order signs, so Autopilot waits while the oracle has not reported it.
- Leaders trade mainnet and followers copy into their testnet accounts; testnet marks drift from mainnet's by a few tenths of a percent, so a tight slippage setting skips copies that would chase the leader's fill.
- Fresh Hyperliquid testnet accounts hold no USDC (its faucet needs a mainnet history), so openings wait for margin until an account is funded.
