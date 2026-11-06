# Security

Tredio's contracts hold people's USDC, so they get the checks any serious smart-contract codebase gets: a line-by-line audit, static analysis, dependency scanning, and a check that the code running on chain is exactly the code in this repository.
This page records each of those, what it found and how to run it again.
The contract audit itself, finding by finding, is in [contracts/AUDIT.md](contracts/AUDIT.md).

## At a glance

Results from 2026-11-06, on the code deployed on NEAR testnet under `tredio.testnet`.

| Check | Tool | Result |
| --- | --- | --- |
| Line-by-line audit | `near-contract-audit` checklist and manual review ([AUDIT.md](contracts/AUDIT.md)) | 11 findings (1 high, 7 medium, 3 low): 10 fixed with a test each, 1 open by design (M-4) |
| Deployed code is this source | `pnpm verify`: the on-chain code hash against the local build | 10 of 10 match byte for byte (8 contracts, the global coin code and account code v2) |
| NEAR rules | `pnpm security` | 6 of 6 hold: overflow checks, no `unsafe`, 30 of 30 callbacks private, 6 of 6 token receivers check their token, no `signer_account_id`, no joint promise returned |
| Static analysis | Clippy's security lints on the wasm32 build | 0 panics; every truncating cast, unwrap and slice index reviewed (below) |
| Dependencies of the deployed wasm | `cargo deny` with [contracts/deny.toml](contracts/deny.toml) | advisories ok, bans ok, sources ok |
| Every dependency, tests included | `cargo audit` (RustSec, 1,422 advisories) | 436 crates: 3 advisories, none in a way that touches the deployed contracts (below) |
| Oracle enclave dependencies | `cargo audit` on `apps/oracle/tee` | 87 crates, no advisories |
| Unit tests | `cargo test --workspace` | 159 pass |
| Integration tests on a real NEAR node | `cargo test -p tredio-sandbox-tests` (near-workspaces, nearcore sandbox) | 15 flows pass |
| End to end on testnet | `bun scripts/e2e-testnet.ts`, live browser specs | pass (see [JUDGES.md](JUDGES.md)) |

Run them yourself:

```bash
pnpm build:contracts
```

```bash
pnpm security
```

```bash
pnpm verify
```

```bash
cd contracts && cargo test --workspace && cargo test -p tredio-sandbox-tests
```

## The deployed code is this source

On an EVM chain a block explorer shows "verified source".
On NEAR the same proof is simpler: an account's `code_hash` is the SHA-256 of the wasm it runs, and a contract published as global code is addressed by that hash.
`pnpm verify` rebuilds nothing on chain: it hashes the wasm `pnpm build:contracts` made from this checkout and compares it with what testnet reports.

| Contract | Account | Size | Code hash (base58 SHA-256) |
| --- | --- | --- | --- |
| `usdc` (testnet mock) | `usdc.tredio.testnet` | 182 KB | `GJyBRzsUnYRE3DCCNeZ6nN7M7FoE1qt6GYq62grwP1q` |
| `registry` | `registry.tredio.testnet` | 250 KB | `S98QE75mEu9GrLR9KGaZd2pFiduJNtamJxsYof8fykJ` |
| `outcomes` | `outcomes.tredio.testnet` | 293 KB | `F8s7aDSSqkgUAQBxzyUzebBwJRwBbQWTqRBaTUkftVdb` |
| `book` | `book.tredio.testnet` | 302 KB | `Gb1KUYKQtJHqkTBhoapquPbSBfrgX2mGeyrX4Y9MGMsu` |
| `perps` | `perps.tredio.testnet` | 275 KB | `5Yvm9KUohekYKujDzohTP11YKtXH61poNFbF4cEdaKw9` |
| `curation` | `curation.tredio.testnet` | 170 KB | `GcHPRuj488ZSKhHUoZ25hoVBahTmczNLbHnuyK5JeYwy` |
| `coins` | `coins.tredio.testnet` | 274 KB | `9XXtTL4YLHwcjib6hcYJ6nLQ8aCgiXtCYS84dHmECJP8` |
| `accounts` | `accounts.tredio.testnet` | 189 KB | `9KBGZxjKAJapbmUfFV5cA3qozz9wd5tgTQYhCHcXUEs2` |
| `coin` (global code, every trend coin) | by hash | 157 KB | `DsgtQXqNL8Jat89BX27i8S34fGu7L2MHxcLTL7BcYV8s` |
| `account` v2 (global code, every passkey account) | by hash | 315 KB | `BsFqhAcYESJ5Fyn55Xa6HwPyJaYy3VyEu4ZGh2iTdBMf` |

- Built with rustc 1.98.1 and cargo-near 0.22.0 (`cargo near build non-reproducible-wasm`); another toolchain produces different bytes, so a third party needs the same versions.
- `perps` was redeployed on 2026-11-06 so that all eight match: the only difference was a storage-ledger fix in the shared crate (a storage withdrawal that could underflow now clamps to zero), with no state change.
- Accounts made before account code v2 was published still run v1 (`J1GvtY5x...`, kept as `contracts/tests/fixtures/account_v1.wasm`) until their passkey upgrades them in Settings.
- Next step for mainnet: a containerized reproducible build (`cargo near build reproducible-wasm`) with NEP-330 source metadata, so NearBlocks' SourceScan can verify the code from the public repository without trusting our toolchain.

## Static analysis

`pnpm security` ([scripts/security.ts](scripts/security.ts)) runs the checks below and fails when a rule breaks.

### NEAR rules

These are the mistakes NEAR contracts most often get wrong, checked on every deployed source line (test modules excluded).

| Rule | Why it matters | Result |
| --- | --- | --- |
| `overflow-checks = true` in the release profile | Without it, `u128` arithmetic silently wraps in wasm; with it, an overflow reverts the call | holds |
| No `unsafe` | Memory safety comes from the compiler alone | 0 in 7,463 lines |
| Every callback is `#[private]` | A public callback lets anyone fake the result of a cross-contract call | 30 of 30 |
| Token receivers check the calling token | `ft_on_transfer` from a fake token would credit fake USDC | 6 of 6 (`book` twice, `outcomes`, `perps`, `coins`, `curation`) |
| No `signer_account_id` in contract logic | The signer is not the caller in a chain of calls; access checks use `predecessor_account_id` | 0 uses |
| No joint promise returned | Returning `a.and(b)` from a method is refused by the runtime | every `.and()` ends in a `.then()` |

The audit adds the checks a script cannot make: one-yocto deposits on owner calls, state written before a transfer and restored in its callback, storage paid by whoever uses it, and the gas each callback reserves ([AUDIT.md](contracts/AUDIT.md), "What was judged fine").

### Clippy's security lints

Clippy runs on the wasm32 target, the code the chain executes, with lints that flag every place a value can overflow, truncate, panic or index out of range.
They are counted, then each risky kind is reviewed by hand.

| Lint | Count | Review |
| --- | --- | --- |
| `panic` | 0 | |
| `arithmetic_side_effects` | 240 | Overflow checks are on, so each one reverts the call instead of wrapping; amounts are `u128` with 6 or 18 decimals, far from the limit |
| `integer_division` | 64 | Where rounding moves value, the code rounds against the trader: the curve rounds fees up and coins out down with `mul_div_ceil` and `mul_div_floor` |
| `as_conversions` | 93 | Widening casts and enum tags; the narrowing ones are the next row |
| `cast_possible_truncation` | 15 | All 15 reviewed: each is clamped first (`clamp`, `min(MAX_TICK)`), bounded by a constant (a session count under `MAX_SESSIONS`), or a view's page index |
| `indexing_slicing` | 15 | All bounded: a length checked on the line before, or a tick at most 999 indexing a 16-word bitmap (999 / 64 = 15) |
| `unwrap_used` | 14 | Invariants the contract itself keeps (an order or level the book wrote, a storage entry after a registration check); a failure reverts the call |
| `expect_used` | 2 | `mul_div` and `exp` overflow, which revert with a message |

One informational note from this review: the account contract's encoder for Hyperliquid actions writes a string's length in one byte when the string is 32 to 255 bytes long and would mis-encode a longer one.
No caller can reach that: every string it encodes is a constant (`"Gtc"`, `"order"`) or a decimal the guard caps at 30 characters (`parse_e8`).

### Dependencies

| Advisory | Crate | Where it is used | Effect on the contracts |
| --- | --- | --- | --- |
| RUSTSEC-2026-0387 (timing variability) | `crypto-bigint` 0.5.5 | near-sdk's native test runtime (`near-vm-runner` through `p256`) | None: not in the wasm, and timing leaks matter only where secrets are handled, which contracts never do |
| RUSTSEC-2024-0449 (unmaintained) | `unsafe-libyaml` 0.2.11 | the sandbox test tooling (`near-workspaces`) | None: test-only |
| RUSTSEC-2022-0054 (unmaintained) | `wee_alloc` 0.4.5 | near-sdk's default wasm allocator | Accepted in [deny.toml](contracts/deny.toml): no known vulnerability, and a contract's memory lives for one call, so the allocator's known leak cannot build up |

`cargo deny` also allows exactly one git source, NEAR's own `near/intents` repository at a pinned revision, for the NEP-245 multi-token types.

## Audit summary

[contracts/AUDIT.md](contracts/AUDIT.md) is a self-audit: done by the Tredio team with an AI engineering agent, not an independent firm.
Each finding got a failing test first, then the fix.

| Id | Severity | Finding | Status |
| --- | --- | --- | --- |
| H-1 | High | The Hyperliquid guard checked a mark not bound to the asset it signs | Fixed; carried by account code v2 (new accounts start on it, older ones upgrade in Settings) |
| M-1 | Medium | Concurrent `graduate` calls repeated graduation steps | Fixed |
| M-2 | Medium | A failed account creation kept the caller's deposit | Fixed |
| M-3, M-6 | Medium | `set_account_code` and `set_protocol` moved every passkey to a new address | Fixed |
| M-4 | Medium | Trades price against an index whose next value can be known first | Open by design: the registry's 50% move clamp and the anchored band bound each trade; the options (fill at the next observation, a spread that grows with the expected move, pausing new risk during an oracle run) change the trading design |
| M-5 | Medium | A buy quote ignored the floor ratchet the buy applies | Fixed |
| M-7 | Medium | The coin factory never registered on its coins, so no coin could be sold back | Fixed |
| L-1 | Low | A failed payout could lose redeemed tokens | Fixed |
| L-2 | Low | A failed delivery skewed the owner's storage accounting | Fixed |
| L-3 | Low | A session whose key could not be added stayed recorded | Fixed; carried by account code v2 |

## Trust model

- Only the oracle key moves an index: the registry verifies an ed25519 signature on every report, and that key is bound to the enclave build on OutLayer.
- Only a passkey owns an account: the account contract verifies the WebAuthn P-256 assertion on chain with `p256_verify`, so the relayer that pays for a request cannot fake one.
- A session key trades within limits the contract enforces: typed actions only, a daily USDC cap, prices anchored to the index, and for Hyperliquid at most 2% from a fresh mark and 10x leverage.
- The full picture is in [README.md](README.md) and [AGENTS.md](AGENTS.md).

## Not covered yet

- No independent audit firm has reviewed the contracts; the audit above is a self-audit.
- BlockSec's Rustle, a static analyzer built for NEAR contracts, has not been run yet: it needs its own toolchain installed, which waits on approval.
- Test coverage is not measured: `cargo-llvm-cov` is not installed yet.
- The off-chain services (relayer, keeper, market maker, oracle runner, indexer, API, app) are outside the contract audit; their tests run in CI and `pnpm verify`.
- The testnet contract accounts keep full-access keys so the team can redeploy; before mainnet they are removed or moved behind a timelocked multisig ([AUDIT.md](contracts/AUDIT.md), "Trust assumptions").

## Reporting a vulnerability

Please do not open a public issue.
Report it privately through GitHub's "Report a vulnerability" on this repository's Security tab, with the contract, the steps and what an attacker gains.
Testnet funds are test funds, but a report is welcome either way, and we will credit it.
