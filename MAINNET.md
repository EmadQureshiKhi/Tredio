# Mainnet

Tredio runs on NEAR testnet today.
The code is ready for NEAR mainnet: the launch is creating and funding the accounts, deploying the contracts and pointing the services at them.
This page says what changes on mainnet, how that was tested, and the steps in order.
Code that exists only for mainnet, or behaves differently there, carries a `#mainnet` comment, so `grep -rn "#mainnet"` lists it (in the app every such branch reads `IS_MAINNET`).
The contracts are the exception: they hold no network in code but take it as data at init (`network`, the USDC, Rhea and Chain Signatures ids), and their sources stay byte for byte as deployed, so the table below stands in for comments there.

## One switch

- Every service reads `NEAR_NETWORK` (`testnet` or `mainnet`); the app and the admin console read `NEXT_PUBLIC_NEAR_NETWORK`.
- Contract ids and parameters come from [`deployments/mainnet.json`](deployments/mainnet.json) through `@tredio/contracts`.
  Until the deploy script runs, that file is the plan (`"status": "planned"`): the ids and parameters the deploy will use.
  Anything started with `NEAR_NETWORK=mainnet` before then refuses to start, with a message that says so.
- [`contracts/scripts/deploy.sh mainnet`](contracts/scripts/deploy.sh) deploys from that plan and rewrites the file as the live deployment, with the block the indexer starts from.

## What changes on mainnet

| Piece | Testnet | Mainnet |
| --- | --- | --- |
| USDC | Tredio's test token `usdc.tredio.testnet`, with a faucet | Circle's native USDC `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`; no faucet, nothing minted |
| Contracts | `*.tredio.testnet` | `*.tredio.near` (registry, outcomes, book, perps, curation, coins, accounts) |
| Rhea (coin graduation) | `ref-finance-101.testnet` | `v2.ref-finance.near` |
| Chain Signatures | `v1.signer-prod.testnet` | `v1.signer` |
| OutLayer (oracle enclave) | `outlayer.testnet` | `outlayer.near` (same `request_execution` method, checked) |
| Enclave build | `apps/oracle/tee/build.sh` | `NEAR_NETWORK=mainnet apps/oracle/tee/build.sh`: mainnet RPC, registry and Hyperliquid compiled in, so a new hash and a new enclave key |
| Outcome series | 24 hours, 7 days and a 15-minute test window | 24 hours and 7 days (`test_window` 0) |
| Accounts | factory network `testnet` | factory network `mainnet`: requests name the network, the faucet action is refused, Hyperliquid orders sign with source `a` |
| Sign-ups | the relayer pays without a ticket if none is configured | the relayer requires an activation ticket, and the API refuses to start without `ACTIVATION_TICKET_KEY` |
| Relayed wallet calls | test USDC `faucet` allowed | no faucet; every relayed token transfer must go to a Tredio contract (on both networks) |
| Indexer | polls the test token like any Tredio contract | does not poll Circle's USDC, and keeps only its transfers that touch a Tredio account |
| Deposits and withdrawals (1Click) | dry quotes at mainnet prices | live quotes with deposit addresses |
| Hyperliquid | `api.hyperliquid-testnet.xyz`, leaders read from mainnet | `api.hyperliquid.xyz`; withdrawals sign `hyperliquidChain: "Mainnet"` |
| RPC | FastNEAR, Intear, dRPC (testnet hosts) | `rpc.mainnet.fastnear.com`, `rpc.intea.rs`, `near.drpc.org` |
| Contract builds | local build (global code) and reproducible builds | reproducible builds only, from a clean, committed tree |
| Autopilot policy wallets | an OutLayer custody wallet the app makes, its policy stored on `outlayer.testnet` by the account | a NEAR Intents Agent API agent owned by the account's passkey, through the partner key (`AGENT_API_KEY` on the API and the executor); built and tested offline, not live |

## How it was tested

- **Mainnet rehearsal on the NEAR sandbox.**
  `cd contracts && cargo test -p tredio-sandbox-tests --test mainnet` starts a local NEAR node (nearcore's sandbox) and imports the code mainnet runs today for Circle's USDC and for Rhea, under their mainnet ids.
  It recreates `tredio.near`, deploys every contract under it with the init arguments `deploy.sh mainnet` sends, and then runs, on that real USDC and Rhea code:
  - USDC minted the way Circle mints it, through its two-approver multisig;
  - sets minted and redeemed;
  - a perp opened and closed, which pays the curator;
  - a trend coin bought up to its 2,000 USDC graduation reserve and graduated by the keeper into a Rhea pool, where it then trades;
  - a passkey account on network `mainnet` that registers with native USDC, is refused the faucet and trades through its session.
  It takes about a minute and needs internet access to read mainnet.
- **Same protocol.**
  Mainnet and testnet both run protocol version 88 (nearcore 2.14, checked 2026-11-07), so gas keys (NEP-611), deterministic account ids, `p256_verify` and global contracts, which the account model needs, are all live on mainnet.
- **The external accounts exist** on mainnet with the methods Tredio calls: native USDC, `v2.ref-finance.near`, `v1.signer` and `outlayer.near`.
- **Unit tests** cover the mainnet branches: the plan's shape, the API refusing to start without a ticket key, the relayer's transfer checks, the indexer's USDC filter and 1Click's USDC asset.

Not rehearsed: Chain Signatures signing (it needs the MPC network), live 1Click swaps and Hyperliquid mainnet orders, which spend real funds.

## Steps

1. **Accounts.**
   Create `tredio.near` (the root) and `tredio-treasury.near` with a NEAR wallet, and service accounts for the relayer, keeper, market maker, oracle and Autopilot (for example `tredio-relayer.near`).
   Other names work: put them in `deployments/mainnet.json` before deploying.
2. **Oracle key.**
   Build the enclave for mainnet (`NEAR_NETWORK=mainnet apps/oracle/tee/build.sh`), upload it, and read its signing key from OutLayer (apps/oracle/docs/tee.md).
   A report's signature names no network, so the mainnet key must be a different key: the deploy script refuses the testnet one.
3. **Commit, push and build.**
   Mainnet deploys only the reproducible build of a clean HEAD (`contracts/scripts/build.sh --reproducible`), so push that commit to the public repository first: the code will name it.
4. **Deploy.**
   `ORACLE_PUBLIC_KEY=ed25519:... contracts/scripts/deploy.sh mainnet` prints what it will do and waits for you to type `deploy to mainnet`.
   Commit the `deployments/mainnet.json` it writes.
5. **Verify the source on NearBlocks.**
   Each contract's code names the repository and commit (NEP-330), so NearBlocks' verify page (`nearblocks.io/verify-contract?account=<contract>`, verifier SourceScan) fills itself in; submit it for each contract, as was done for the eight on testnet.
   `NEAR_NETWORK=mainnet pnpm verify --rebuild` does the same check locally.
6. **Services.**
   Set `NEAR_NETWORK=mainnet` in every service's `.env`, with the mainnet service accounts and keys, give them gas keys (`NEAR_NETWORK=mainnet bun scripts/gas-keys.ts <account>`), and set `ACTIVATION_TICKET_KEY` on the API and `ACTIVATION_TICKET_SIGNER` on the relayer.
   Give the indexer the relayer's account (`RELAYER_ACCOUNT_ID`), since only testnet's is built in.
   For Autopilot on policy wallets, put a partner key from partners.near-intents.org in `AGENT_API_KEY` on the API and the executor (with the owner's go-ahead); it needs account code that accepts the wallet's calls ("Policy wallets" in [apps/autopilot/README.md](apps/autopilot/README.md)).
   Build the app and the admin console with `NEXT_PUBLIC_NEAR_NETWORK=mainnet`, and update the public copy that names testnet ids (`frontend/public/llms.txt`, `skills/tredio/SKILL.md`, the website).
7. **Fund.**
   NEAR for the service accounts, and USDC for the market maker, the perps pool and the Autopilot bot (below).
8. **Harden before opening.**
   Remove the contract accounts' full-access keys or move them behind a timelocked multisig ([contracts/AUDIT.md](contracts/AUDIT.md), "Trust assumptions"), and point the registry at the enclave key.

## Budget

NEAR, measured on testnet with mainnet's prices (protocol 88, the same storage and gas prices):

| What | NEAR |
| --- | --- |
| Global code, burned: the coin (158 KB) and account (316 KB) code at 10 times storage | about 47.4 |
| Seven contract accounts' code and state, locked and recoverable | about 19.1 |
| Wiring (USDC registrations, the book's storage, Rhea registration) | about 1.2 |
| Each sign-up, paid by the relayer (account storage and session gas) | 0.4 to 0.55 |
| Oracle reports at one a minute | about 0.7 a day |
| OutLayer runs at one a minute (at most 0.007 NEAR each, the unused part refunded) | up to about 10 a day |

USDC, all of it the protocol's own working capital:

| What | USDC |
| --- | --- |
| Market maker: 1,500 margin plus 100 sets for each of 24 series | about 3,900 |
| Perps pool seed (`deposit_pool`), which backs traders' profits | 5,000 or more |
| Autopilot bot's Hyperliquid margin, funded through 1Click | 500 to 1,000 |
