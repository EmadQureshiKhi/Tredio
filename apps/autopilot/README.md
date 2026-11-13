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

## Policy wallets

A grant can also run through a policy wallet, so the key that signs for Autopilot is never the executor's.
The account's session stays exactly as it is, the on-chain limit; the wallet adds a second, independent one that the account owns.

- **Testnet: OutLayer custody.** The app makes an OutLayer wallet in the browser, has its enclave encrypt Autopilot's policy and sign it for the account, and one passkey prompt stores the policy on `outlayer.testnet` (the account becomes its only controller), sends the wallet 0.2 NEAR for gas, and adds Autopilot's session for the wallet's own key (`gas_key: false`).
  The executor holds only the wallet's API key, sealed to it like a session key, and asks the enclave to sign each `session_call` (rules and copies alike).
- **Mainnet: the NEAR Intents Agent API.** The account gets one agent whose owner is its own passkey (the API's `passkey` owner type); the backend prepares the owner actions with the partner key (`AGENT_API_KEY`), the passkey signs them as WebAuthn assertions, and the executor holds a grant token and sends `session_call`s as the agent's native NEAR calls.
  Wired and tested offline only (`packages/custody/test/agent-api.test.ts`, `backend/test/policy-wallets.test.ts`); it goes live with a partner key and the owner's go-ahead.

| Checked by | What it enforces |
| --- | --- |
| The account contract (the session) | The session is live and unexpired, Hyperliquid scope only, the daily USDC cap, orders within 2% of a fresh oracle mark on the signed asset, at most 10x; the account's freeze; revoking ends it |
| The enclave (the wallet's policy) | The wallet is not frozen, contract calls only, to the account alone, no NEAR attached, no message signing; with usage counts OutLayer's coordinator supplies, at most 120 calls an hour |
| The executor (before it records an order) | The account controls the wallet's policy on chain, the decrypted policy is exactly Autopilot's, the wallet is not frozen and holds gas; otherwise rules and copies wait, or pause when the account must act |

What the enclave does not check: what a call asks the account to do.
It reads the receiver and the NEAR attached, not the arguments, so a `session_call` to the account passes it whatever the action; the session decides that.
The enclave also has no expiry of its own: the session's expiry (at most 30 days) is the end date, and the freeze is the off switch.
Freezing needs no wallet signature, so it works even if the API key leaks; the passkey sends `freeze_wallet` through an owner request.
A frozen wallet makes rules and copies wait; `/health` lists every policy wallet with its freeze, its gas and why it waits.

The account contract must accept the wallet's call.
OutLayer's keystore signs every NEAR transaction as the wallet's own implicit account, never as another account's access key, so the session cannot be signed for as the account itself.
Account code v1 and v2 take `session_call` only from the account (`session keys only`); account code v3 also takes it when sent directly by the implicit account of one of the account's session keys (`acceptsWalletSessions`), for a plain-key session only.
Until an account runs v3 the executor waits instead of sending, and the app points to the upgrade in Settings (one passkey prompt).

### On testnet

It runs live end to end ([`scripts/policy-wallet.ts`](../../scripts/policy-wallet.ts); the passkey is a software passkey, the wallet a free anonymous OutLayer wallet):

| Step | Transaction |
| --- | --- |
| A passkey account `0um1v5w8...` is created by the relayer | [`9reW6c3z...`](https://testnet.nearblocks.io/txns/9reW6c3zeaiVHxa2UvWJ9D3RVjGz9wjssEiFxRMTEGDb) |
| One owner request: the policy is stored on `outlayer.testnet` with the account as controller, the wallet `4348f62d...` gets 0.1 NEAR, Autopilot's session is added for the wallet's key | [`C3vFoA6K...`](https://testnet.nearblocks.io/txns/C3vFoA6KMx1tVeSGtTCq7Yj59Jni8euELWMGzC9XiSLi) |
| The account sends the wallet 0.12 NEAR more (a call needs its 0.15 NEAR of prepaid gas in the wallet) | [`5HJ2hrpC...`](https://testnet.nearblocks.io/txns/5HJ2hrpCR3vuAXNT7aKEAR5fVwjduUzhgNTps8joAj8A) |
| The enclave signs and sends `session_call({hl_leverage})` from the wallet to the account; v2 code refuses it: `session keys only` | [`GT3RLHyR...`](https://testnet.nearblocks.io/txns/GT3RLHyRq5B6nMRfa2qhJheeUNy72CTsWn37eNAos2zM), again in [`5ounSLWn...`](https://testnet.nearblocks.io/txns/5ounSLWnKr6aqHQVFjQ19Jjr8YyQbceapqvXCiTz9z8e) |
| The passkey moves the account to account code v3 | [`97TmqfGi...`](https://testnet.nearblocks.io/txns/97TmqfGiSzj8ws9WmMNEW1yX7bCG1XvKCcazY3ZY5bLA) |
| The enclave signs and sends the same kind of `session_call`; v3 takes it as Autopilot's session, the guard passes and Chain Signatures signs the Hyperliquid action | [`ENCLocW8...`](https://testnet.nearblocks.io/txns/ENCLocW8Mk6KikN2nLgH56UQu8JoxFr2U56wPVn1ejKG) |
| Outside the policy, refused before signing (no transaction): a call to `usdc.tredio.testnet` (`Address 'usdc.tredio.testnet' is not in whitelist`) and a call attaching one yoctoNEAR (`Per-transaction limit exceeded for native: 1 > 0`) | none |
| The passkey freezes the wallet: the executor's venue waits (`the account froze Autopilot's policy wallet`) and the enclave refuses (`wallet_frozen`) | [`HbcVYSJT...`](https://testnet.nearblocks.io/txns/HbcVYSJTRRZ7ES6PCKt9t94z2dFU6TiDZQGnt4BXDaKF) |
| The passkey unfreezes it; the executor's gate passes again | [`3rLBDand...`](https://testnet.nearblocks.io/txns/3rLBDandCdTQAT2aS7kt1CFoP8CjzF34YTkwJ7QEZd9K) |

`pnpm verify` checks the record in `deployments/testnet-proofs.json` (`policyWallet`).

### Turning on the mainnet path

1. A partner key from partners.near-intents.org in the backend's and the executor's `AGENT_API_KEY`, with `NEAR_NETWORK=mainnet` (and the owner's go-ahead).
2. Account code that accepts the wallet's calls (version 3) published and named in `deployments/mainnet.json`.
3. In the app: Autopilot, Grant access, then Policy wallet under "Who signs Autopilot's orders"; three passkey prompts create the agent, grant the executor, and add the session with the agent's gas.

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
  A funded account passes USDC on with `usdSend`, which lands on the receiver's perps balance; USDC that arrives in spot moves to perps with `usdClassTransfer`. `scripts/hyperliquid-demo.ts fund` does both for the demo traders.
- The bot trades through its own session, which lasts 30 days at most; `/health` warns three days before it ends and fails once it has. Renewing is one owner request (`add_session` with the same key, account code v2 or later): `bun scripts/hyperliquid-demo.ts renew-bot`.
- A policy wallet pays its own gas, and OutLayer sends a call only while the wallet holds the gas it attaches (0.15 NEAR for 150 Tgas); below `POLICY_WALLET_GAS_MIN_NEAR` (0.16) Autopilot waits for the account to fund it.
  Its policy allows no transfers, so the NEAR in a wallet stays there after the grant ends.
