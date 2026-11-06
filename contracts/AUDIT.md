# Tredio contracts: security self-audit

This is a self-audit, done by the Tredio team with an AI engineering agent, not an independent audit firm.
It records what was reviewed, how, every finding with its fix and test, what was judged fine, and what remains open.
Fixes are in the code in this repository; they reach testnet only when the contracts listed under "Deployment" are redeployed.

## Scope

- Every contract in the Cargo workspace under `contracts/` (near-sdk 5.30, Rust): `account`, `accounts`, `registry`, `outcomes`, `book`, `perps`, `coin`, `coins`, `curation`, `usdc` (testnet mock) and the shared `common` crate.
- The code as deployed on testnet on 2026-11-05 under `tredio.testnet`, with the account contract's global code hash `J1GvtY5xj7QuNwmdDFM56EYxmTvwp1wHqkPZjY7CNK9x` (v1) and the coin contract's `DsgtQXqNL8Jat89BX27i8S34fGu7L2MHxcLTL7BcYV8s`.
- Cross-contract flows between them: oracle reports, series and settlement, minting and redemption, the book's swaps, perps, trend coins and graduation to Rhea, universal account creation, passkey requests and gas-key sessions.
- Out of scope: the off-chain services (relayer, keeper, market maker, oracle runner, indexer, backend, app), the OutLayer enclave, Chain Signatures, Hyperliquid and Rhea themselves.
  Where a contract relies on one of them, the assumption is stated.

## Method

- The `near-contract-audit` checklist: non-private callbacks, state changed after cross-contract calls, JSON integer types, unsaved collection changes, owner checks, one-yocto deposits, storage prefix collisions, init macros, unbounded loops, randomness, gas reserved for callbacks, storage cost coverage, unchecked math and floats.
- No NEAR-specific static analyzer was available offline, so the checklist was applied by reading every source file, helped by searches (for example every `on_*`, `after_*` and resolver method, every `#[init]`, every storage key enum, every float).
- Manual review of business logic, access control, economic attacks and failure paths of every promise chain.
- Each finding got a test first, run against the audited code to see it fail, then the fix.
  Tests are unit tests (near-sdk mocked blockchain) or sandbox tests (`near-workspaces` on a local nearcore node), including real gas-key transactions sent over JSON-RPC.
- Verification: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`, the sandbox suite (`cargo test -p tredio-sandbox-tests`) and a release build with `contracts/scripts/build.sh`.
- Test counts: 126 unit tests and 7 sandbox tests before; 157 unit tests and 15 sandbox tests after (M-5 added one).

## Findings

Severity reflects impact and how easily it can be triggered on testnet as deployed.

| Id | Severity | Contract | Title | Status |
| --- | --- | --- | --- | --- |
| H-1 | High | account, registry | The Hyperliquid guard checks a mark that is not bound to the asset it signs | Fixed (account v2, registry) |
| M-1 | Medium | coins | Concurrent `graduate` calls repeat graduation steps | Fixed |
| M-2 | Medium | accounts | A failed account creation keeps the caller's deposit | Fixed |
| M-3 | Medium | accounts | `set_account_code` moves every passkey to a new address | Fixed |
| M-4 | Medium | perps, book, outcomes | Trades price against an index whose next value can be known first | Open (design) |
| L-1 | Low | outcomes | A failed payout can lose the redeemed tokens | Fixed |
| L-2 | Low | book | A failed delivery skews the owner's storage accounting | Fixed |
| L-3 | Low | account | A session whose key could not be added stays recorded | Fixed (account v2) |
| M-5 | Medium | coins | A buy quote ignores the floor ratchet the buy applies first | Fixed |

### H-1: the Hyperliquid guard checks a mark that is not bound to the asset it signs

- Location: `account/src/lib.rs`, `on_hl_mark`; `registry/src/lib.rs`, marks.
- A session's Hyperliquid order carries two fields: `asset`, the ticker the guard looks up with the registry's `mark_of`, and `asset_index`, the `a` field Hyperliquid executes and Chain Signatures signs.
  Nothing tied one to the other.
- A session key (a stolen browser key, or a compromised holder of an Autopilot grant) could sign an order on any asset at a price within 2% of another asset's mark, for example a buy of an illiquid asset at the price of BTC, filled against the attacker's own resting order.
  That removes the guard's whole protection for Hyperliquid funds.
- Fix: the oracle now reports each mark's Hyperliquid asset index (`marks[].asset_index`), the registry stores it per ticker (emitting `asset_index_set`) and returns it from `mark_of`, and account v2 refuses an order whose `asset_index` differs from the mark's, or any order when the mark has no index.
  The registry keeps the index under its own storage prefix outside the root state, so it needs no migration.
- Tests: `account` `the_hyperliquid_guard_binds_the_mark_to_the_signed_asset` and `the_hyperliquid_guard_needs_the_marks_asset_index` (both failed on v1); `registry` `marks_carry_their_hyperliquid_asset_index`; sandbox `the_hyperliquid_guard_reads_the_asset_index_from_the_registry` (registry and account v2 together, real gas-key transactions).
- Residual risk: accounts stay on v1 code until their owner upgrades, and the protection needs the oracle (runner and enclave) to report `asset_index`.
  Until then v2 accounts refuse every Hyperliquid order, which fails closed.

### M-1: concurrent `graduate` calls repeat graduation steps

- Location: `coins/src/graduation.rs`, `graduate` and its callbacks; `coins/src/lib.rs`, `sell`.
- `graduate` is permissionless and each step only checks flags its callback sets.
  Several calls in the same block all passed those checks before the first callback landed.
- Impact: each extra call in `ready` created another Rhea pool paid from the factory's NEAR; extra mint steps minted the graduation coins again; extra deposit steps sent the graduation USDC to Rhea again, taking it out of the factory's single USDC balance that backs every other curve, into a Rhea deposit the factory has no method to withdraw, so other curves could no longer buy back their coins.
  A sale during pool creation could also drop the reserve under the threshold and reopen the curve, orphaning the pool just paid for.
- Fix: one step at a time per curve: `graduate` records the step in flight under its own storage prefix and refuses while it is pending; every callback clears it; a step whose callback never ran can be retried after 600 seconds; sales are refused while the pool is being created.
- Tests: `coins` `graduation_steps_never_run_twice_at_once` (failed before the fix) and `a_lost_graduation_callback_expires`.

### M-2: a failed account creation keeps the caller's deposit

- Location: `accounts/src/lib.rs`, `create_account` and `on_created`.
- When the creation batch fails (a first request that does not verify, an expired request, or a top-up of an existing v1 account, whose second `bootstrap` panics), the runtime refunds its deposit to the batch's predecessor, the factory.
  The factory only logged the failure and had no way to send the deposit on, so the caller lost it.
- The sandbox measured the loss: a 2 NEAR creation with a bad proof cost the caller 2.0024 NEAR.
- Fix: `on_created` sends the deposit back to the account that paid it; if the factory cannot cover it yet (the runtime's refund may land after the callback), the deposit is recorded for `claim_refund` (view `refund_of`), stored under its own prefix so the factory needs no migration.
  The batch now ends with a plain view call (`bootstrapped`), so its result reflects only the batch.
  Without that, a first request returning a call that fails later would have looked like a failed creation while the account kept the deposit, and the refund would have paid it twice (this was caught while writing the fix and has its own test).
  Account v2 also makes a second `bootstrap` a no-op, so `create_account` really tops up an existing v2 account.
- Tests: sandbox `a_failed_account_creation_refunds_the_caller` (failed before the fix), `a_first_request_that_fails_later_is_not_refunded` and `creating_an_existing_account_again_loses_nothing`; unit `a_failed_creation_sends_the_deposit_back` and `a_refund_the_factory_cannot_cover_yet_becomes_claimable`.

### M-3: `set_account_code` moves every passkey to a new address

- Location: `accounts/src/lib.rs`, `set_account_code`.
- A universal account's address commits to its initial code hash, and the app finds a returning user's account with `account_id_of(passkey)`.
  Calling `set_account_code` (the obvious step after publishing new account code) would have changed every passkey's derived address, so signing in on a new device would land on a new, empty account while the funds stayed at the old one.
- Fix: the code hash accounts are born with can only be set before the first account exists.
  Accounts move to newer code with their passkey's `upgrade` action, and a new account can include it in its first request, so creating and upgrading take one prompt and every passkey keeps one address.
- Tests: `accounts` `the_birth_code_is_fixed_once_accounts_exist` (failed before the fix); sandbox `new_accounts_upgrade_in_their_first_request_and_trade_with_150_tgas`.

### M-4: trades price against an index whose next value can be known first (open)

- Location: `perps` (open, close, liquidation at the registry index), `book` (anchored swaps around the attention-implied value), `outcomes` (settlement at the first observation after expiry).
- The index is computed from public collector readings, and in the OutLayer mode the readings go into an on-chain request before the signed result lands.
  Anyone who computes the next value first can open a perp at the stale index and close after the update (the perps pool is the counterparty), or buy the side that is about to win from quotes made at the stale value.
  The registry's move clamp (50% per update) and the anchored band bound each trade, not the repeated edge.
- Not fixed: removing it changes the trading design.
  Options: fill perp opens and closes at the first index observed after the request, charge a spread that grows with the expected move, or pause new risk while an oracle run is pending; the market maker should widen quotes around report times.

### L-1: a failed payout can lose the redeemed tokens

- Location: `outcomes/src/lib.rs`, `after_payout`.
- Redemptions burn tokens first and restore them if the USDC transfer fails.
  The restore minted through the storage-checked path, so if the owner's storage filled up in between (anyone can mint dust sets to another account), the callback panicked: the tokens stayed burned and no USDC was paid.
- Fix: the restore records the balances without requiring storage room (the entry is still counted against the owner, who cannot withdraw storage until it is gone).
- Test: `outcomes` `a_failed_payout_is_restored_even_when_storage_filled_up_meanwhile` (failed before the fix).

### L-2: a failed delivery skews the owner's storage accounting

- Location: `book/src/lib.rs`, `after_delivery`; `common/src/storage.rs`.
- When a withdrawal or swap output failed to transfer, the book kept the amount as a balance without counting a storage entry, but the later debit that removed it released one.
  The owner's entry count then fell below what it held, so it could withdraw storage deposit, or unregister, while still holding other balances paid for by the book.
- Fix: the new balance is counted for a registered owner (`StorageLedger::force_add_entry`), and storage withdrawal saturates when entries exceed the deposit.
- Test: `book` `a_failed_delivery_still_counts_toward_storage` (failed before the fix).

### L-3: a session whose key could not be added stays recorded

- Location: `account/src/lib.rs`, `AddSession`.
- The session is recorded before the key is added in a separate receipt.
  If that receipt failed (for example the account could not cover the key's storage), the session stayed in the map without a key, so the app saw an active session nobody could use.
  With v2's renewal in place, a retry would also have trusted that record and never added the key.
- Fix: a callback (`on_session_key`) drops the session when its key batch failed.
- Tests: `account` `a_new_session_key_is_checked_by_a_callback` (fails on v1 by construction: v1 schedules no such callback) and `a_session_whose_key_was_not_added_is_dropped`.

### M-5: a buy quote ignores the floor ratchet the buy applies first

- Location: `coins/src/lib.rs`, `quote_buy` and `on_buy`.
- Found after the self-audit, by the live browser test of a coin buy on testnet.
- `on_buy` first raises the curve's floor to the trend's current peak attention, then prices the buy; `quote_buy` priced the stored curve.
  After the peak rose and before the next trade, every quote promised more coins than the buy could give, so the first buy failed its slippage check.
  On testnet the World Cup peak went from 52 to 84 points, and the quote promised 2.6 times the coins.
- Fix: `quote_buy` takes the registry's `peak_index` and applies the same ratchet before quoting; the app and the MCP server pass it.
- Test: `coins` `a_buy_quote_with_the_peak_matches_the_buy_after_the_peak_rose`.

## Accepted risks and observations

- Plain (non-gas) session keys have an unlimited allowance, so a leaked one sent directly could burn the account's liquid NEAR on failing calls.
  A cap was tried and reverted: an allowance is charged the attached gas at 1e9 yocto per gas (the sandbox charged 0.3009 NEAR of allowance for one 300 Tgas call), so any cap small enough to matter stops the key.
  The app uses gas keys only; plain keys are the fallback for meta transactions, where the relayer pays.
- A revoked gas key stays on the account (v2), as decided, because deleting it burns its balance.
  It can call nothing but `session_call`, which refuses it, so whoever holds its secret can at most burn what is left of its own balance on failing calls.
  `revoke_session` with `delete_key` removes it for good.
- Storage the protocol pays for new holders can be reclaimed by them: the coins factory attaches 0.00125 NEAR per new coin holder, and the testnet USDC faucet registers callers from its own balance; a holder can unregister to recover it.
  At current gas prices one cycle costs more gas than it returns.
- Receiver-side storage griefing, as in every NEP-145 token: anyone can mint sets to, transfer tokens to, or open a perp for another registered account, using up its storage entries until it redeems, transfers or closes them (the victim receives the value).
- Bootstrap deposits are small: 0.01 NEAR at perps covers two open positions and 0.02 NEAR at outcomes about ten balances, and sessions cannot add storage (the passkey can).
- The Hyperliquid mark limit is 300 seconds (v2, as decided) and the oracle reports every 300 seconds, so just before a report lands the mark can be a few seconds too old and orders are refused; reporting marks slightly more often avoids the gap.
- Two trends whose identifiers differ only in `:`, `.` or `_` map to the same coin account name; the second coin then fails to create and its curve is removed, which is safe.
- Tokens burned in `mt_resolve_transfer` because the sender unregistered leave their backing USDC in the outcomes contract.
- The factory's `created` counter also counts successful top-ups of existing accounts.
- Curation has no `remove_source`; a fee source can only be retired by redeploying.

## Reviewed and found fine

- Callbacks: every `on_*`, `after_*`, `wrap_unused` and resolver method is `#[private]`, and each reads its promise result defensively.
- Initialization: every contract has one `#[init]` constructor and `PanicOnDefault`.
- Access control: owner-only methods check the predecessor; the account's owner path verifies a WebAuthn P-256 signature over a domain-tagged hash bound to account, network, nonce and a time window; sessions require the account's own key and are checked for expiry, scope and a gross daily USDC limit; the registry accepts only reports signed by its oracle key, with strictly increasing run ids and age limits.
- State before calls: payouts, withdrawals, claims and redemptions update state before the transfer and restore it in the callback on failure (outcomes, book, perps, curation, coins).
- Refunds: `ft_on_transfer` and `mt_on_transfer` handlers return the unused amount on every refusal, and panics roll back through the token's resolve step.
- Session scope: no session action can send value to a third party; outputs return to the account, and swaps are anchored to the attention-implied value.
- JSON integers: amounts are `U128`; plain integers (index values, seconds, ids, nonces) stay below 2^53.
- Storage keys: every collection has its own prefix from a `BorshStorageKey` enum, appended only; the v2 additions use new prefixes outside the root state.
- Loops: bounded (40 fills per take, 64 pending expiries, 96 checkpoints, 32 positions per owner, 16 session keys, paginated views).
- Math: release builds keep `overflow-checks = true`; fixed-point math uses 256-bit intermediates with explicit rounding; floats appear only in tests.
- Randomness: none is used.
- One-yocto: transfers to other accounts (`ft_transfer`, `mt_transfer` and the call variants) require it; methods without it only pay the caller.

## Account code v2

Published as a new global contract; each account upgrades with its passkey.

- Adding a session for a key the account already has renews it in place without adding a key, so a gas key keeps its prepaid gas; today's spending carries over.
- Revoking a gas key's session keeps the key, dormant (`dormant_keys`), and only drops the session; adding a session for it again reactivates it with its remaining balance; `delete_key` removes a key for good.
- Token calls attach 20 Tgas of static gas plus all gas the transaction leaves unused, so a session transaction needs 150 Tgas instead of 300 (it refuses token calls under 120 Tgas before they count against the daily limit).
- `top_up_gas` moves NEAR from the account into the signing session's own gas key, up to 0.5 NEAR per session per UTC day, always leaving storage plus 0.05 NEAR.
- The Hyperliquid mark age limit is 300 seconds instead of 120, and the guard binds the mark to the signed asset (H-1).
- `bootstrap` is a no-op after the first run; `version` returns 2.
- State: `STATE` keeps the exact v1 layout (the factory writes it, v1 code reads it), and what v2 adds lives under its own key, read as empty when absent.
  An account upgraded from v1 needs no migration, and the sandbox test `a_v1_account_upgrades_to_v2_and_keeps_its_sessions_and_balances` upgrades an account running the exact deployed v1 bytes and checks its sessions, gas key, USDC, outcome tokens and NEAR.

## Deployment

`registry`, `book`, `outcomes`, `coins` and `accounts` were redeployed in place on testnet on 2026-11-06 with these fixes (M-5 included); their state read unchanged and the oracle's reports kept landing.
The account v2 global code is not published yet: publishing it burns about 31.6 NEAR, more than the testnet treasury holds, so accounts still run v1 and H-1 and L-3 stay open for them until they upgrade.

| Contract | Change | Redeploy | State migration |
| --- | --- | --- | --- |
| `account` (global code) | v2, H-1, L-3 | Publish the new global code, then each account upgrades with its passkey | None |
| `accounts` | M-2, M-3 | Yes (pause the relayer meanwhile: `on_created` takes new arguments) | None |
| `registry` | H-1 | Yes, before the oracle reports `asset_index` | None |
| `coins` | M-1 | Yes | None |
| `book` | L-2 | Yes | None |
| `outcomes` | L-1 | Yes | None |
| `perps` | Shared storage ledger only (no change in behavior) | Optional | None |
| `coin`, `curation`, `usdc` | Unchanged | No | None |
