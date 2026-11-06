# Rustle static analysis

This records a run of BlockSec's Rustle, the static analyzer for NEAR contracts, over every crate in this workspace, and the triage of everything it reported.
Rustle targets Rust 1.67 and LLVM 15, so it was first ported to LLVM 22 (the LLVM of rustc 1.98.1); the ported copy lives outside this repository.
Analysed revision: `cb5226a` (2026-11-07), all detectors (`-d all`), one run per crate: `common`, `registry`, `usdc`, `curation`, `outcomes`, `book`, `perps`, `coin`, `coins`, `account`, `accounts` (the test crates are skipped).
Result: no high or medium issue.
Two items were true but low: owner-only setters did not require a one-yocto deposit, and one view rounded a quotient before multiplying (negligible).
Both are fixed, and a second run on the changed crates no longer reports them ("After the fixes", below).
Everything else is a false positive or by design, as triaged below, in line with [AUDIT.md](AUDIT.md).

## Tool and port

- Rustle `fdd3087` (BlockSec, July 2023), run in an ubuntu 24.04 container with apt.llvm.org's LLVM 22.1.8 and rustc 1.98.1 (LLVM 22.1.8).
- The 25 C++ detectors keep their legacy pass classes; a shared header wraps each in a new pass manager module pass and exports `llvmGetPassPluginInfo`, so each runs as `opt -load-pass-plugin=detectors/X.so -passes=X` under its old name (the loop pass is driven from `LoopAnalysis`).
- LLVM API changes since 15 were fixed: `startswith`, the removed `PassManagerBuilder`, `PassPlugin.h` moved to `llvm/Plugins`, and constants that keep no use list since LLVM 21.
- The analysed IR is built the way Rustle expects, from today's rustc: debug info on (this workspace sets `debug = 0`), one codegen unit, legacy symbol mangling (`-C symbol-mangling-version=legacy` needs `-Z unstable-options`, so `RUSTC_BOOTSTRAP=1` for this analysis build only) and `-Z share-generics=no`, in a separate target directory.
- Detectors were adapted to current rustc IR: debug paths are relative to the crate root now, pointers are opaque (a `Promise`, an `Option<u64>` or an `AccountId` comparison is recognised by its uses and callee names instead of by struct type), and checked `+`, `-` and negation compile to `add` or `sub` with a branch to `panic_const_*_overflow`, which `unsafe-math` now accepts as checked.
- And to near-sdk 5: `promise_result_checked`, `near_account_id::AccountId`, `near_sdk::store` collections (`storage-gas`) and `#[near]` impl blocks (the Python helpers).
- Upstream bugs that hid findings or crashed were fixed: `yocto-attach` stopped at the first callback, `ext-call-trait` kept one function per module, `unhandled-promise` took the call that made a promise for its handler, free functions in `lib.rs` never reached the report, `lock-callback` ignored near-sdk's callback wrappers, and `reentrancy` and `unclaimed-storage-fee` read past calls without arguments or callee (the first aborted `opt` on two crates here).

## How to reproduce

The image (Dockerfile next to the ported Rustle):

```dockerfile
FROM ubuntu:24.04
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg git build-essential figlet python3 python3-venv \
 && curl -fsSL https://apt.llvm.org/llvm-snapshot.gpg.key | gpg --dearmor -o /usr/share/keyrings/apt.llvm.org.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/apt.llvm.org.gpg] http://apt.llvm.org/noble/ llvm-toolchain-noble-22 main" > /etc/apt/sources.list.d/llvm.list \
 && apt-get update && apt-get install -y --no-install-recommends llvm-22 llvm-22-dev clang-22
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install pytablewriter tqdm toml
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo RUSTUP_TOOLCHAIN=1.98.1
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain 1.98.1 --target wasm32-unknown-unknown \
 && /opt/cargo/bin/cargo install rustfilt --locked
ENV PATH=/opt/venv/bin:/opt/cargo/bin:/usr/lib/llvm-22/bin:$PATH
```

The run, from `contracts/` (the sources are mounted read-only; `RUSTLE` is the ported copy, `OUT` and `TARGET` are scratch directories):

```bash
docker build --platform linux/arm64 -t rustle-llvm22 <directory with the Dockerfile>
docker run --rm --platform linux/arm64 -e CARGO_TARGET_DIR=/target \
  -v "$PWD":/src:ro -v "$RUSTLE":/rustle -v "$OUT":/out -v "$TARGET":/target -v rustle-cargo-registry:/opt/cargo/registry \
  rustle-llvm22 bash -c 'cd /rustle && make clean_pass pass && mkdir -p /work && cd /work &&
    for c in common registry usdc curation outcomes book perps coin coins account accounts; do /rustle/rustle -t /target /src/$c -o /out/$c; done'
```

Each crate's report is `$OUT/<crate>/summary.csv` (one CSV per source file next to it), and the detectors' raw output is in `$OUT/<crate>/raw`.
The counts below are taken from the `summary.csv` files.

## Sanity checks

- Rustle's own 30 examples, each run with its detector against its `expected.csv`: 27 match exactly.
  `transfer`, `unhandled-promise` and `unsaved-changes` report the same finding one to three lines lower, because rustc now attributes a call in a method chain to the method's line rather than the chain's first line.
- Two variants with the opposite expectation: the `self-transfer` example with its sender check restored reports nothing, and the `unsafe-math` example built with `overflow-checks = true` reports nothing while the original still reports all three operations.
- A small near-sdk 5 contract: a dropped promise, an owner method without `assert_one_yocto`, `block_timestamp`, a cross-contract call with a callback, a callback without `#[private]` and a `u64` view are each reported; a detached or returned promise, an owner method with `assert_one_yocto` and a `#[private]` callback are not.

## Detector status

- Working and exercised by this code: `incorrect-json-type`, `div-before-mul`, `lock-callback`, `yocto-attach`, `unregistered-receiver`, `prepaid-gas`, `non-callback-private`, `non-private-callback`, `unused-ret`, `upgrade-func`, `storage-gas`, `unclaimed-storage-fee`, `inconsistency`, `timestamp`, `ext-call`, `promise-result`, `transfer`, `complex-loop`, `public-interface`.
- Working, nothing to report here: `unhandled-promise`, `unsafe-math` (every operation is overflow-checked), `self-transfer` (both tokens delegate to near-contract-standards), `round` (no floats), `tautology`, `dup-collection-id` (every collection has its own `BorshStorageKey` variant).
- Runs but cannot fire on near-sdk 5 code: `reentrancy` matches near-sdk 4's `PromiseResult::Successful` switch with the state write in the same function, while near-sdk 5 callbacks get a `Result` from `promise_result_checked` in the generated wrapper; `unsaved-changes` matches legacy `near_sdk::collections`, whose `get` returns a copy, while this code uses `near_sdk::store`, whose `get_mut` writes back.
- Not applicable: `nft-approval-check` and `nft-owner-check` (no NEP-171 code).
- Not part of `all`: `nep-interface` (ported and working) and `struct-member` (ported, but it matches typed struct pointers, which LLVM 22 IR no longer has).

## Findings per detector and contract

Severity is Rustle's.
A location-style note (`div-before-mul at <L83 L89>`) counts each location; other notes count once per function.

| Detector | Severity | common | registry | usdc | curation | outcomes | book | perps | coin | coins | account | accounts | Total |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| unhandled-promise | high |  |  |  |  |  |  |  |  |  |  |  | 0 |
| non-private-callback | high | 1 |  |  |  |  |  |  |  | 1 |  |  | 2 |
| reentrancy | high |  |  |  |  |  |  |  |  |  |  |  | 0 |
| unsafe-math | high |  |  |  |  |  |  |  |  |  |  |  | 0 |
| self-transfer | high |  |  |  |  |  |  |  |  |  |  |  | 0 |
| incorrect-json-type | high |  | 11 | 2 |  | 13 | 13 | 11 |  | 3 | 1 | 1 | 55 |
| unsaved-changes | high |  |  |  |  |  |  |  |  |  |  |  | 0 |
| nft-approval-check | high |  |  |  |  |  |  |  |  |  |  |  | 0 |
| nft-owner-check | high |  |  |  |  |  |  |  |  |  |  |  | 0 |
| div-before-mul | medium | 14 |  |  |  |  | 2 | 2 |  |  |  |  | 18 |
| round | medium |  |  |  |  |  |  |  |  |  |  |  | 0 |
| lock-callback | medium |  |  |  |  | 1 | 1 | 3 |  |  | 1 |  | 6 |
| yocto-attach | medium |  | 4 | 2 | 2 | 1 | 3 | 2 | 2 | 3 | 1 | 2 | 22 |
| dup-collection-id | medium |  |  |  |  |  |  |  |  |  |  |  | 0 |
| unregistered-receiver | medium |  |  | 2 |  |  |  |  | 2 |  |  |  | 4 |
| prepaid-gas | low |  |  | 1 |  |  |  |  | 1 |  |  |  | 2 |
| non-callback-private | low |  |  | 1 | 1 | 1 | 1 | 1 | 1 | 4 | 1 | 1 | 12 |
| unused-ret | low | 1 |  |  |  |  | 3 | 3 |  | 1 |  |  | 8 |
| upgrade-func | low | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 11 |
| tautology | low |  |  |  |  |  |  |  |  |  |  |  | 0 |
| storage-gas | low | 1 | 7 | 2 | 3 | 11 | 8 | 6 |  | 11 | 2 |  | 51 |
| unclaimed-storage-fee | low |  |  | 1 |  | 1 | 1 | 1 | 1 |  |  |  | 5 |
| inconsistency | info | 41 |  |  |  | 2 |  |  |  |  | 2 |  | 45 |
| timestamp | info | 1 |  |  |  |  |  |  |  |  |  |  | 1 |
| ext-call | info |  |  |  | 1 | 6 | 8 | 18 |  | 32 | 19 | 1 | 85 |
| promise-result | info | 1 |  |  |  | 1 |  | 1 |  | 4 |  |  | 7 |
| transfer | info | 1 |  | 2 |  |  |  |  | 3 | 1 | 2 | 3 | 12 |
| complex-loop | info |  | 4 |  |  | 1 | 4 |  |  |  | 2 |  | 11 |
| public-interface | info |  | 21 | 7 | 7 | 12 | 16 | 18 | 5 | 17 | 16 | 9 | 128 |

The raw output also lists loops in code that serde, borsh and near-sdk generate or ship (for example `Deserialize` visitors at a struct's line), which Rustle's report leaves out; they are not triaged.

## Triage

Paths are relative to `contracts/`.

### non-private-callback (2): false positive

- `common/src/lib.rs:33` `promise_succeeded` and `coins/src/graduation.rs:31` `all_succeeded` read promise results, but they are plain helper functions, not contract methods, so no one can call them.
  Every method that calls them is `#[private]` (see non-callback-private below).

### incorrect-json-type (55 notes in 46 functions): by design

- 34 notes are plain `u64` arguments or return values (index values of at most 1e9, unix seconds, series, order and position ids, nonces), all below 2^53 as AUDIT.md states.
- 21 notes name structs (`Params`, `TrendView`, `Checkpoint`, `MarkView`, `Series`, `OrderSpec`, `Placement`, `Market`, `Depth`, `Order`, `Position`, `PositionState`, `Curve`) that Rustle flags for a `u64` field or for a `u128` or `i128` field.
  Every `u128` and `i128` in a JSON type is serialized as a string (`outcomes/src/lib.rs:68` `u128_string`, `perps/src/lib.rs:73` `i128_string`, `coins/src/curve.rs:33` `u128s`) and amounts are `U128`.

### div-before-mul (18 locations in 7 functions)

- `common/src/math.rs:83` and `:89` (`exp_wad`), `:117`, `:118`, `:123`, `:125` (`ln_wad`), `:151` to `:157` (`norm_cdf`) and `common/src/pricing.rs:46` (`diffuse`): by design.
  This is WAD fixed-point arithmetic (range reduction, Taylor and atanh series, a Horner polynomial), where each step rounds once at 1e-18; the tests at `common/src/math.rs:199` and `common/src/pricing.rs:86` hold it to the float model.
- `book/src/book.rs:37` `cost` (`size / LOT * tick`): false positive, the division is exact.
  Order sizes must be multiples of `LOT` (`book/src/book.rs:262`) and fills are cut to whole lots (`book/src/book.rs:108`); `cost_of` (`book/src/receivers.rs:189`) is a view.
- `book/src/book.rs:102` `take`: by design, it counts whole lots a budget affords, and the loop at `book/src/book.rs:103` steps down until the cost with fee fits.
- `perps/src/lib.rs:419` and `:421` `liquidation_index`: true but negligible, fixed.
  `q / bps * (bps - mm)` truncated `qty` (1e18 per contract) to a multiple of 1e4, a relative error below 1e-14, in a value only the `position_state` view returns (`perps/src/lib.rs:291`); it now multiplies first, with a unit test that holds it to the exact quotient.

### lock-callback (6): by design

- `outcomes/src/lib.rs:325` `on_settlement`, `book/src/receivers.rs:158` `on_anchor`, `perps/src/ops.rs:277` `on_close`, `perps/src/ops.rs:310` `on_settle_retired` and `perps/src/ops.rs:334` `on_liquidate` panic when the registry's answer does not allow the action.
  The calls that schedule them (`outcomes/src/lib.rs:306`, `book/src/receivers.rs:132`, `perps/src/ops.rs:266`, `:299`, `:324`) change no state first, so a failed callback leaves the contract as it was; `on_anchor`'s input comes back through the token's resolve step.
- `account/src/lib.rs:510` `on_signed` holds no state at all.
- The `require!` Rustle quotes for `on_settlement` belongs to another method (its Python helper assigns macros by line).

### yocto-attach (22)

- True, low (hardening), fixed: owner-only setters did not call `assert_one_yocto`, so a function-call access key of the owner account could call them.
  `registry/src/lib.rs:291` `set_oracle`, `:298` `add_consumer`, `:303` `remove_consumer`; `usdc/src/lib.rs:77` `add_minter`, `:82` `remove_minter`; `curation/src/lib.rs:76` `add_source`; `coins/src/lib.rs:226` `set_coin_code`; `coins/src/graduation.rs:74` `prepare_exchange`; `accounts/src/lib.rs:72` `set_account_code` and `:81` `set_protocol`.
  Using it needs a leaked function-call key of the owner account for that contract; the two `accounts` setters are inert once an account exists, and each `prepare_exchange` call moves about 0.1 NEAR of the factory's balance into storage deposits.
  Each setter is now `#[payable]` with `assert_one_yocto()`, and `prepare_exchange` requires the 0.10125 NEAR of storage deposits it spends, which a function-call key cannot attach either.
- False positive: `registry/src/lib.rs:308` `assert_owner` is the helper those methods call, not a method itself.
- By design: the NEP-141 and NEP-245 receivers `curation/src/lib.rs:142`, `outcomes/src/lib.rs:556`, `book/src/receivers.rs:196` and `:205`, `perps/src/ops.rs:121` and `coins/src/lib.rs:552` compare the predecessor with the token contract, and token calls carry no deposit.
- By design: `coin/src/lib.rs:51` `mint` and `:68` `burn` are called by the coins factory contract, not by a person's key.
- By design: `book/src/lib.rs:346` `cancel_order` and `perps/src/ops.rs:266` `close` act for the order's or position's owner and only pay the caller.
- By design: `account/src/lib.rs:422` `session_call` is called by the account's own session keys, which cannot attach a deposit; scope, expiry and the daily limit bound it.

### unregistered-receiver (4): false positive

- `usdc/src/lib.rs:108` and `:113`, `coin/src/lib.rs:87` and `:92` delegate to near-contract-standards' `FungibleToken`, whose `internal_unwrap_balance_of` panics for an unregistered receiver.
  Rustle reports any delegation to the standard implementation as accepting unregistered receivers (the check in its `unregistered_receiver.cpp` is inverted for that case).

### prepaid-gas (2): false positive

- `usdc/src/lib.rs:113` and `coin/src/lib.rs:92` delegate `ft_transfer_call` to near-contract-standards 5, which reserves 5 Tgas of static gas for `ft_resolve_transfer` and gives the rest to `ft_on_transfer` by weight.
  A call with too little gas fails in the same receipt, before any state change persists.

### non-callback-private (12): false positive

- All twelve are callbacks scheduled with `.then`: `usdc/src/lib.rs:135` and `coin/src/lib.rs:114` `ft_resolve_transfer`, `curation/src/lib.rs:104` `after_claim`, `outcomes/src/lib.rs:424` `after_payout`, `book/src/lib.rs:502` `after_delivery`, `perps/src/lib.rs:527` `after_send`, `coins/src/graduation.rs:223` `on_liquidity_added`, `coins/src/lib.rs:307` `on_coin_created`, `:632` `after_mint`, `:640` `after_pay`, `account/src/lib.rs:497` `on_session_key` and `accounts/src/lib.rs:148` `on_created`.
  They read the result through `tredio_common::promise_succeeded` or near-contract-standards' `internal_ft_resolve_transfer`, in another crate, so Rustle does not see them as callbacks; `#[private]` is correct on each.

### unused-ret (8)

- False positive, test code: `common/src/math.rs:186` (a `should_panic` test) and `coins/src/tests.rs:281`.
- By design: `book/src/book.rs:93` and `book/src/lib.rs:340` ignore `cancel`'s refunded amount, which `cancel` has already credited; `book/src/receivers.rs:110` ignores the `Placement` of an order placed from a transfer; `perps/src/ops.rs:292`, `:318` and `:389` ignore the `Market` that `accrue` has already stored.

### upgrade-func (11): by design

- No contract has an upgrade method: contracts are redeployed with their full-access key (AUDIT.md, "Trust assumptions"), and a universal account moves to new code only through its passkey's `upgrade` action (`use_global_contract`, `account/src/lib.rs:840`).

### storage-gas (51): by design

Rustle flags every function that inserts into a collection without measuring `env::storage_usage`; this code prices storage per entry instead.
- Entries a person owns are charged to their NEP-145 deposit through `StorageLedger::add_entry` (`common/src/storage.rs:91`), which fails before writing when the deposit is short: `common/src/storage.rs:51` (registration takes at least the minimum), `outcomes/src/lib.rs:490` and `book/src/lib.rs:431` `credit`, `book/src/book.rs:212` `rest`, `perps/src/lib.rs:427` `add_owner_position` and their callers (`perps/src/ops.rs:172` `on_open`, `outcomes/src/lib.rs:540` `mint_sets`).
- Most flagged functions rewrite an entry that already exists or restore one removed earlier: `debit` (`outcomes/src/lib.rs:502`, `book/src/lib.rs:445`), `book/src/book.rs:57`, `:149`, `:166`, `perps/src/lib.rs:446` `accrue`, `perps/src/ops.rs:53`, `:121`, `registry/src/lib.rs:340`, `:544`, `outcomes/src/lib.rs:325`, `:361`, `:376`, `outcomes/src/mt.rs:223`, `coins/src/lib.rs:341`, `:514`, `:585`, `coins/src/graduation.rs:156`, `:184`, `:198`, `:223`, `curation/src/lib.rs:104`, and the records of a failed transfer (`outcomes/src/lib.rs:424` and `:521`, `book/src/lib.rs:502`, `perps/src/lib.rs:527`, `coins/src/lib.rs:632` and `:640`; AUDIT.md L-1 and L-2 describe two of them).
- Protocol data the contract pays for, bounded by who may write it: oracle-signed reports in the registry (`registry/src/lib.rs:442`, `:495`, `:587`, history capped at 96 and pending expiries at 64), consumers (`:318`), owner lists (`registry/src/lib.rs:298`, `usdc/src/lib.rs:77`, `curation/src/lib.rs:76`), fees from allow-listed sources (`curation/src/lib.rs:142`), one series per trend and window at a time (`outcomes/src/lib.rs:232`, `:260`), one market pair per listed series (`book/src/lib.rs:292`) and one curve and coin per registry trend (`coins/src/lib.rs:248`, `:307`).
- `usdc/src/lib.rs:59` `faucet` registers callers from the contract's balance: the testnet mock's accepted risk in AUDIT.md.
- `account/src/lib.rs:422` and `:700` write the account's own state, paid from its own balance.

### unclaimed-storage-fee (5): false positive

- `outcomes/src/lib.rs:637`, `book/src/lib.rs:550` and `perps/src/lib.rs:591` refuse `force` and unregister only an account that owns no entries (`common/src/storage.rs:85`), so nothing is left behind.
- `usdc/src/lib.rs:158` and `coin/src/lib.rs:137` call near-contract-standards' `internal_storage_unregister`, which panics on a positive balance without `force` and burns it with `force`, as NEP-145 specifies.

### Informational detectors: by design

- `timestamp` (1): `common/src/lib.rs:29` `now_secs` is the block time every contract uses for expiries, windows and staleness, never for randomness.
- `promise-result` (7), `ext-call` (85), `transfer` (12) and `public-interface` (128) mark promise reads, cross-contract calls, NEAR and token transfers and public methods; each is part of a reviewed flow (AUDIT.md, "Reviewed and found fine").
- `complex-loop` (11): every loop is bounded: `registry/src/lib.rs:452`, `:459`, `:467` and `:593` by the signed report and 64 pending expiries, `book/src/book.rs:72` by 40 fills, `:328` by at most 60 sweeps, `book/src/lib.rs:301` by two sides, `:338` by a batch of 40, `outcomes/src/mt.rs:238` by a batch of 32, `account/src/lib.rs:380` by the passkey-signed actions and `account/src/hyperliquid.rs:166` by eight decimals.
- `inconsistency` (45): pairs of deliberately similar names (`WAD` and `UWAD`, `MIN_` and `MAX_` bounds, `MAX_SESSIONS` and `MAX_SESSION_SECS`); its line numbers are zero-based.

## After the fixes

The two true findings were fixed in the contracts, each with a unit test: an owner without the yoctoNEAR is refused, `prepare_exchange` without its deposit is refused, and the liquidation index matches the exact quotient.
Rustle then ran again on the six changed crates (`registry`, `usdc`, `curation`, `coins`, `accounts`, `perps`):
- `yocto-attach` no longer reports any owner setter.
  What remains is by design, as triaged above: the NEP-141 receivers, `perps` `close`, and `prepare_exchange`, which now requires a deposit larger than one yoctoNEAR, a check Rustle does not recognise.
- `div-before-mul` no longer reports `perps`.
