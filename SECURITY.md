# Security

Tredio's contracts hold people's USDC, so they get the checks any serious smart-contract codebase gets: a line-by-line audit, static analysis, dependency scanning, and a check that the code running on chain is exactly the code in this repository.
This page records each of those, what it found and how to run it again.
The contract audit itself, finding by finding, is in [contracts/AUDIT.md](contracts/AUDIT.md).

## At a glance

Results from 2026-11-07, on the code deployed on NEAR testnet under `tredio.testnet`.

| Check | Tool | Result |
| --- | --- | --- |
| Line-by-line audit | `near-contract-audit` checklist and manual review ([AUDIT.md](contracts/AUDIT.md)) | 11 findings (1 high, 7 medium, 3 low): 10 fixed with a test each, 1 accepted by design and bounded on chain (M-4) |
| Deployed code is this source | Reproducible builds in SourceScan's Docker image (NEP-330), `near contract verify`, `pnpm verify` | 10 of 10 match byte for byte: the 8 contracts are reproducible builds of commit `d976aea`, ready for NearBlocks verification once it is public; the newest account code (v3) is the reproducible build of commit `18dd319`, and the global coin code matches the local build |
| NEAR rules | `pnpm security` | 6 of 6 hold: overflow checks, no `unsafe`, 30 of 30 callbacks private, 6 of 6 token receivers check their token, `signer_account_id` only to require a direct call (1 use), no joint promise returned |
| Static analysis | Clippy's security lints on the wasm32 build | 0 panics; every truncating cast, unwrap and slice index reviewed (below) |
| Static analysis built for NEAR | BlockSec's Rustle, every detector, adapted to LLVM 22 ([contracts/RUSTLE.md](contracts/RUSTLE.md)) | 0 high, 0 medium; 2 low findings, both fixed and gone on a second run; the rest triaged as false positives or by design |
| Dependencies of the deployed wasm | `cargo deny` with [contracts/deny.toml](contracts/deny.toml) | advisories ok, bans ok, sources ok |
| Every dependency, tests included | `cargo audit` (RustSec, 1,422 advisories) | 436 crates: 3 advisories, none in a way that touches the deployed contracts (below) |
| Oracle enclave dependencies | `cargo audit` on `apps/oracle/tee` | 87 crates, no advisories |
| Unit tests | `cargo test --workspace` | 176 pass |
| Test coverage | `pnpm coverage:contracts` (`cargo llvm-cov`, unit tests) | 84.4% of lines, 74.4% of functions, 82.0% of regions (below) |
| Integration tests on a real NEAR node | `cargo test -p tredio-sandbox-tests` (near-workspaces, nearcore sandbox) | 17 flows pass |
| Mainnet rehearsal | the same sandbox, with Circle's USDC and Rhea imported from mainnet ([MAINNET.md](MAINNET.md)) | the mainnet plan deploys and trades through to a graduation into Rhea |
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
On NEAR an account's `code_hash` is the SHA-256 of the wasm it runs, and global code is addressed by that hash, so the proof is a build that hashes the same.

- **Reproducible builds.**
  The eight contract accounts run wasm that `contracts/scripts/build.sh --reproducible` built in SourceScan's pinned Docker image (`sourcescan/cargo-near:0.22.0-rust-1.98.1`, by digest) from commit `d976aea` of this repository, redeployed on 2026-11-07 with no change to their state.
  Each records the repository, the commit and the build command (NEP-330 `contract_source_metadata`), so NearBlocks' contract tab can rebuild it from the public source and mark it verified, and anyone can rebuild it with Docker alone.
- **Checked here before it is public.**
  `near contract verify --use-contract-source-code-path <checkout of d976aea> deployed-at <contract> network-config testnet now` rebuilt `registry` and `perps` the way SourceScan does and answered, for each, that the code on chain and the code built from the repository are the same.
  Without `--use-contract-source-code-path` it fetches the source from GitHub, which works once the commit is pushed.
- **Global code.**
  The coin code and account code v1 and v2 were published from the local build (rustc 1.98.1, cargo-near 0.22.0) before reproducible builds existed here; account code v3 is a reproducible build of commit `18dd319`, published on 2026-11-10.
  Republishing burns ten times the storage price (31.55 NEAR for the account code), so testnet keeps the older ones, and `pnpm verify` compares the newest account code with its reproducible build and the coin code with `pnpm build:contracts`.
  On mainnet every artifact, global code included, is a reproducible build ([MAINNET.md](MAINNET.md)).
- **`pnpm verify`** checks each: the commit a contract names is in this repository and its contract source is unchanged since, and its code hashes like that commit's reproducible build (`--rebuild` makes the builds it is missing).

| Contract | Account | Build | Size | Code hash (base58 SHA-256) |
| --- | --- | --- | --- | --- |
| `usdc` (testnet only) | `usdc.tredio.testnet` | reproducible | 182 KB | `6y7XtXeX5aNjH9nG6XDUFEJTiyxkewLkXdaQNuBq8yut` |
| `registry` | `registry.tredio.testnet` | reproducible | 250 KB | `6cqSBbzyv6GvSpQPyNKfUqgeysMALQzT8v9xGsAHAENt` |
| `outcomes` | `outcomes.tredio.testnet` | reproducible | 294 KB | `3WpvWnioDU9HN42HxkVu82J4UuuASoz95F4emHDzV8AZ` |
| `book` | `book.tredio.testnet` | reproducible | 303 KB | `3ogUcNJ7GojTRrdvDd7MqS1Wf291vVzo4ndd7rkbxSCc` |
| `perps` | `perps.tredio.testnet` | reproducible | 277 KB | `8VSJFGfyX1CN12tkwNp82s4ZQpgPHyK8ko1MAHeZi1Fd` |
| `curation` | `curation.tredio.testnet` | reproducible | 172 KB | `A3BdN2Rcu7T36J7YNfUKXkoXtFRkQR1yVcmfxd8VdMBX` |
| `coins` | `coins.tredio.testnet` | reproducible | 275 KB | `9s3Ex87Wh1v1hCh6xmrzdYrB51jGHkpdZHtsWqtUfd2p` |
| `accounts` | `accounts.tredio.testnet` | reproducible | 190 KB | `3K45nWx35rU2ap27ASJWu3QT4KUW5Q4aPxDdZhAzvw7P` |
| `coin` (global code, every trend coin) | by hash | local | 157 KB | `DsgtQXqNL8Jat89BX27i8S34fGu7L2MHxcLTL7BcYV8s` |
| `account` v3 (global code, every new passkey account) | by hash | reproducible (`18dd319`) | 316 KB | `AiQw6Q2mS4cdSQUiRAADX36n4574JePScJSDXXDDyLhx` |
| `account` v2 (global code) | by hash | local | 315 KB | `BsFqhAcYESJ5Fyn55Xa6HwPyJaYy3VyEu4ZGh2iTdBMf` |

- Accounts keep the code they run until their passkey upgrades them in Settings: v1 (`J1GvtY5x...`, kept as `contracts/tests/fixtures/account_v1.wasm`) or v2 (kept as `contracts/tests/fixtures/account_v2.wasm`); the sandbox tests upgrade both to the current code.

## Static analysis

`pnpm security` ([scripts/security.ts](scripts/security.ts)) runs the checks below and fails when a rule breaks.

### NEAR rules

These are the mistakes NEAR contracts most often get wrong, checked on every deployed source line (test modules excluded).

| Rule | Why it matters | Result |
| --- | --- | --- |
| `overflow-checks = true` in the release profile | Without it, `u128` arithmetic silently wraps in wasm; with it, an overflow reverts the call | holds |
| No `unsafe` | Memory safety comes from the compiler alone | 0 in 7,508 lines |
| Every callback is `#[private]` | A public callback lets anyone fake the result of a cross-contract call | 30 of 30 |
| Token receivers check the calling token | `ft_on_transfer` from a fake token would credit fake USDC | 6 of 6 (`book` twice, `outcomes`, `perps`, `coins`, `curation`) |
| `signer_account_id` only to require a direct call | The signer is not the caller in a chain of calls; access checks use `predecessor_account_id` | 1 use: account code v3 requires `predecessor == signer` for a policy wallet's `session_call`, so no contract can relay one |
| No joint promise returned | Returning `a.and(b)` from a method is refused by the runtime | every `.and()` ends in a `.then()` |

The audit adds the checks a script cannot make: one-yocto deposits on owner calls (owner setters gained theirs from the Rustle run below), state written before a transfer and restored in its callback, storage paid by whoever uses it, and the gas each callback reserves ([AUDIT.md](contracts/AUDIT.md), "What was judged fine").

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

## Rustle

[BlockSec's Rustle](https://github.com/blocksecteam/rustle) is the static analyzer built for NEAR contracts: about thirty detectors for unhandled promises, missing `#[private]`, reentrancy, unchecked math, missing one-yocto deposits, rounding, storage and NEP interfaces.
Its last release targets Rust 1.67 and LLVM 15, which cannot build near-sdk 5, so it was adapted to LLVM 22 (the LLVM of rustc 1.98.1) and to near-sdk 5's code shapes, and checked against its own 30 examples before it ran here.
It found nothing at high or medium severity.
Its two true findings, both low, are fixed: owner-only setters now require one attached yoctoNEAR (so only a full-access key can call them), and the liquidation index multiplies before it divides.
[contracts/RUSTLE.md](contracts/RUSTLE.md) has the port, the counts per detector and contract, and a triage of every finding with file and line.

## Test coverage

`pnpm coverage:contracts` runs the contracts' unit tests under `cargo llvm-cov` (2026-11-10).
Integration flows on the sandbox run the compiled wasm inside a NEAR node, which line coverage cannot see, so these numbers count unit tests only.

| Contract | Lines | Functions | Regions |
| --- | --- | --- | --- |
| `curation` | 95.4% | 94.1% | 95.4% |
| `common` (math, pricing, storage ledger) | 92.4% | 93.5% | 89.3% |
| `registry` | 88.1% | 68.0% | 85.9% |
| `book` | 86.7% | 74.3% | 82.7% |
| `coins` | 86.6% | 73.2% | 84.5% |
| `accounts` | 84.1% | 89.2% | 84.5% |
| `perps` | 84.0% | 69.2% | 80.8% |
| `account` | 84.0% | 81.8% | 78.3% |
| `outcomes` | 80.0% | 65.8% | 78.0% |
| `coin` | 66.4% | 50.0% | 72.8% |
| `usdc` (testnet only) | 63.3% | 57.7% | 70.0% |
| All | 84.4% | 74.4% | 82.0% |

Most of what the unit tests leave out is views, owner setters and the NEP-141, NEP-145 and NEP-245 plumbing, plus entry points such as `liquidate`, `settle_retired` and `create_account` that only schedule a registry read or a cross-contract call.
The callbacks that hold their logic (`on_liquidate`, `on_settle_retired`, `on_created`) are unit tested, and the entry points run in the sandbox flows.
The first coverage run found five payout paths with no unit test, and each has one now: a claimable perps payout, a failed coin delivery claimed back from the coin factory, both fee sweeps (anyone may sweep, only the treasury is paid), and curation restoring a claim whose transfer failed.

## Audit summary

[contracts/AUDIT.md](contracts/AUDIT.md) is a self-audit: done by the Tredio team with an AI engineering agent, not an independent firm.
Each finding got a failing test first, then the fix.

| Id | Severity | Finding | Status |
| --- | --- | --- | --- |
| H-1 | High | The Hyperliquid guard checked a mark not bound to the asset it signs | Fixed; carried by account code v2 and v3 (new accounts start on v3, older ones upgrade in Settings) |
| M-1 | Medium | Concurrent `graduate` calls repeated graduation steps | Fixed |
| M-2 | Medium | A failed account creation kept the caller's deposit | Fixed |
| M-3, M-6 | Medium | `set_account_code` and `set_protocol` moved every passkey to a new address | Fixed |
| M-4 | Medium | Trades price against an index whose next value can be known first | Accepted by design: the registry's 50% move clamp and the anchored band bound each trade; the tighter options (fill at the next observation, a spread that grows with the expected move, pausing new risk during an oracle run) are trading-design choices for the pre-mainnet review |
| M-5 | Medium | A buy quote ignored the floor ratchet the buy applies | Fixed |
| M-7 | Medium | The coin factory never registered on its coins, so no coin could be sold back | Fixed |
| L-1 | Low | A failed payout could lose redeemed tokens | Fixed |
| L-2 | Low | A failed delivery skewed the owner's storage accounting | Fixed |
| L-3 | Low | A session whose key could not be added stayed recorded | Fixed; carried by account code v2 and v3 |

## Trust model

- Only the oracle key moves an index: the registry verifies an ed25519 signature on every report, and that key is bound to the enclave build on OutLayer.
- Only a passkey owns an account: the account contract verifies the WebAuthn P-256 assertion on chain with `p256_verify`, so the relayer that pays for a request cannot fake one.
- A session key trades within limits the contract enforces: typed actions only, a daily USDC cap, prices anchored to the index, and for Hyperliquid at most 2% from a fresh mark and 10x leverage.
- The full picture is in [README.md](README.md) and [AGENTS.md](AGENTS.md).

## Not covered yet

- No independent audit firm has reviewed the contracts; the audit above is a self-audit.
- The off-chain services (relayer, keeper, market maker, oracle runner, indexer, API, app) are outside the contract audit; their tests run in CI and `pnpm verify`.
- The testnet contract accounts keep full-access keys so the team can redeploy; before mainnet they are removed or moved behind a timelocked multisig ([AUDIT.md](contracts/AUDIT.md), "Trust assumptions").
- NearBlocks shows the "verified" badge only after SourceScan rebuilds from the public repository, which waits for the code to be pushed.

## Reporting a vulnerability

Please do not open a public issue.
Report it privately through GitHub's "Report a vulnerability" on this repository's Security tab, with the contract, the steps and what an attacker gains.
Testnet funds are test funds, but a report is welcome either way, and we will credit it.
