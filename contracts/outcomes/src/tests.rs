use defuse_nep245::resolver::MultiTokenResolver;
use defuse_nep245::MultiTokenCore;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_contract_standards::storage_management::StorageManagement;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, NearToken, PromiseError, RuntimeFeesConfig};

use super::*;

const T0: u64 = 1_800_000_000;

fn ctx(who: &str, secs: u64, deposit: u128) {
    ctx_with(who, secs, deposit, vec![]);
}

fn ctx_with(who: &str, secs: u64, deposit: u128, results: Vec<near_sdk::PromiseResult>) {
    testing_env!(
        VMContextBuilder::new()
            .predecessor_account_id(who.parse().unwrap())
            .current_account_id("outcomes.testnet".parse().unwrap())
            .block_timestamp(secs * 1_000_000_000)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .prepaid_gas(Gas::from_tgas(300))
            .build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn snapshot(index: u64, status: Status) -> IndexSnapshot {
    IndexSnapshot {
        id: "topic:a".into(),
        status,
        index,
        peak_index: index,
        updated_at: T0,
        fresh: true,
        retired_at: None,
        surfacer: None,
    }
}

fn register(c: &mut Outcomes, who: &str) {
    ctx(who, T0, NearToken::from_millinear(50).as_yoctonear());
    c.storage_deposit(None, None);
}

/// A contract with one open 24h series (id 1, opening 50.0) and alice and bob registered.
fn setup() -> Outcomes {
    ctx("owner.testnet", T0, 0);
    let mut c = Outcomes::new(acc("owner.testnet"), acc("usdc.testnet"), acc("registry.testnet"), 900);
    let _ = c.open_series("topic:a".into(), WINDOW_24H);
    ctx("outcomes.testnet", T0, 0);
    assert_eq!(
        c.on_series_registered(
            "topic:a".into(),
            WINDOW_24H,
            T0,
            T0 + WINDOW_24H,
            Ok(snapshot(50_000_000, Status::Active))
        ),
        Some(1)
    );
    register(&mut c, "alice.testnet");
    register(&mut c, "bob.testnet");
    c
}

fn mint(c: &mut Outcomes, who: &str, amount: u128) {
    ctx("usdc.testnet", T0 + 10, 0);
    let r = c.ft_on_transfer(acc(who), U128(amount), r#"{"mint":{"series":1,"receiver":null}}"#.into());
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    ctx("outcomes.testnet", T0 + 10, 0);
    assert_eq!(
        c.on_mint_checked(
            1,
            acc(who),
            acc(who),
            U128(amount),
            Ok(Some(snapshot(50_000_000, Status::Active)))
        )
        .0,
        0
    );
}

fn bal(c: &Outcomes, who: &str, id: &str) -> u128 {
    c.mt_balance_of(acc(who), id.into()).0
}

#[test]
fn opens_series_with_the_registry_index() {
    let c = setup();
    let s = c.get_series(1).unwrap();
    assert_eq!(
        (s.opening_index, s.expiry, s.number, s.outcome),
        (50_000_000, T0 + WINDOW_24H, 1, Outcome::Open)
    );
    assert_eq!(c.latest_series("topic:a".into(), WINDOW_24H).unwrap().id, 1);
}

#[test]
fn logs_series_opened() {
    ctx("owner.testnet", T0, 0);
    let mut c = Outcomes::new(acc("owner.testnet"), acc("usdc.testnet"), acc("registry.testnet"), 0);
    let _ = c.open_series("topic:a".into(), WINDOW_24H);
    ctx("outcomes.testnet", T0, 0);
    c.on_series_registered(
        "topic:a".into(),
        WINDOW_24H,
        T0,
        T0 + WINDOW_24H,
        Ok(snapshot(50_000_000, Status::Active)),
    );
    assert!(get_logs().iter().any(|l| l.contains("tredio-outcomes") && l.contains("series_opened")));
}

#[test]
#[should_panic(expected = "series still open")]
fn one_open_series_per_window() {
    let mut c = setup();
    ctx("keeper.testnet", T0 + 100, 0);
    let _ = c.open_series("topic:a".into(), WINDOW_24H);
}

#[test]
#[should_panic(expected = "open in flight")]
fn concurrent_opens_are_refused() {
    ctx("owner.testnet", T0, 0);
    let mut c = Outcomes::new(acc("owner.testnet"), acc("usdc.testnet"), acc("registry.testnet"), 0);
    let _ = c.open_series("topic:a".into(), WINDOW_24H);
    let _ = c.open_series("topic:a".into(), WINDOW_24H);
}

#[test]
fn a_failed_registry_call_opens_nothing() {
    ctx("owner.testnet", T0, 0);
    let mut c = Outcomes::new(acc("owner.testnet"), acc("usdc.testnet"), acc("registry.testnet"), 0);
    let _ = c.open_series("topic:a".into(), WINDOW_7D);
    ctx("outcomes.testnet", T0, 0);
    assert_eq!(
        c.on_series_registered("topic:a".into(), WINDOW_7D, T0, T0 + WINDOW_7D, Err(PromiseError::Failed)),
        None
    );
    assert_eq!(c.series_count(), 0);
    // And the next attempt is not blocked.
    ctx("keeper.testnet", T0 + 1, 0);
    let _ = c.open_series("topic:a".into(), WINDOW_7D);
}

#[test]
#[should_panic(expected = "invalid window")]
fn rejects_unknown_windows() {
    ctx("owner.testnet", T0, 0);
    let mut c = Outcomes::new(acc("owner.testnet"), acc("usdc.testnet"), acc("registry.testnet"), 0);
    let _ = c.open_series("topic:a".into(), 900);
}

#[test]
fn mints_complete_sets_fully_backed() {
    let mut c = setup();
    mint(&mut c, "alice.testnet", 10_000_000);
    assert_eq!(bal(&c, "alice.testnet", "1:up"), 10_000_000);
    assert_eq!(bal(&c, "alice.testnet", "1:down"), 10_000_000);
    let s = c.get_series(1).unwrap();
    assert_eq!((s.up_supply, s.down_supply, s.backing), (10_000_000, 10_000_000, 10_000_000));
    assert_eq!(c.obligations(1).0, s.backing);
    assert!(get_logs().iter().any(|l| l.contains("nep245") && l.contains("mt_mint")));
}

#[test]
fn refuses_mints_for_inactive_trends() {
    let mut c = setup();
    ctx("outcomes.testnet", T0 + 10, 0);
    let unused = c.on_mint_checked(
        1,
        acc("alice.testnet"),
        acc("alice.testnet"),
        U128(5),
        Ok(Some(snapshot(1, Status::Cooling))),
    );
    assert_eq!(unused.0, 5);
    let unused =
        c.on_mint_checked(1, acc("alice.testnet"), acc("alice.testnet"), U128(5), Err(PromiseError::Failed));
    assert_eq!(unused.0, 5);
    assert_eq!(c.total_backing().0, 0);
}

#[test]
#[should_panic(expected = "only USDC")]
fn only_usdc_mints() {
    let mut c = setup();
    ctx("fake.testnet", T0, 0);
    let _ =
        c.ft_on_transfer(acc("alice.testnet"), U128(1), r#"{"mint":{"series":1,"receiver":null}}"#.into());
}

#[test]
fn redeems_sets_and_restores_on_a_failed_payout() {
    let mut c = setup();
    mint(&mut c, "alice.testnet", 10_000_000);
    ctx("alice.testnet", T0 + 20, 0);
    let _ = c.redeem_sets(1, U128(4_000_000));
    assert_eq!(bal(&c, "alice.testnet", "1:up"), 6_000_000);
    assert_eq!(c.total_backing().0, 6_000_000);
    // The USDC transfer failed: tokens and backing come back.
    ctx("outcomes.testnet", T0 + 20, 0);
    assert_eq!(
        c.after_payout(1, acc("alice.testnet"), U128(4_000_000), U128(4_000_000), U128(4_000_000)).0,
        0
    );
    assert_eq!(bal(&c, "alice.testnet", "1:down"), 10_000_000);
    assert_eq!(c.get_series(1).unwrap().backing, 10_000_000);
}

#[test]
fn settles_up_and_pays_winners() {
    let mut c = setup();
    mint(&mut c, "alice.testnet", 10_000_000);
    ctx("alice.testnet", T0 + 30, 1);
    c.mt_transfer(acc("bob.testnet"), "1:down".into(), U128(10_000_000), None, None);
    ctx("keeper.testnet", T0 + WINDOW_24H, 0);
    let _ = c.settle(1);
    ctx("outcomes.testnet", T0 + WINDOW_24H, 0);
    assert_eq!(c.on_settlement(1, Ok(Settlement { finalized: true, value: 50_000_001 })), Outcome::Up);
    ctx("alice.testnet", T0 + WINDOW_24H, 0);
    let r = c.redeem_winnings(1, U128(10_000_000), U128(0));
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    ctx("bob.testnet", T0 + WINDOW_24H, 0);
    let r = c.redeem_winnings(1, U128(0), U128(10_000_000));
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
    let s = c.get_series(1).unwrap();
    assert_eq!((s.backing, s.up_supply, s.down_supply), (0, 0, 0));
}

#[test]
fn ties_go_down() {
    let mut c = setup();
    ctx("outcomes.testnet", T0 + WINDOW_24H, 0);
    assert_eq!(c.on_settlement(1, Ok(Settlement { finalized: true, value: 50_000_000 })), Outcome::Down);
}

#[test]
fn voids_after_the_grace_period_and_pays_half() {
    let mut c = setup();
    mint(&mut c, "alice.testnet", 10_000_000);
    ctx("outcomes.testnet", T0 + WINDOW_24H + VOID_GRACE, 0);
    assert_eq!(c.on_settlement(1, Ok(Settlement { finalized: false, value: 0 })), Outcome::Void);
    assert_eq!(c.obligations(1).0, 10_000_000);
    ctx("alice.testnet", T0 + WINDOW_24H + VOID_GRACE, 0);
    let _ = c.redeem_winnings(1, U128(10_000_000), U128(10_000_000));
    assert_eq!(c.get_series(1).unwrap().backing, 0);
}

#[test]
#[should_panic(expected = "not settleable yet")]
fn waits_for_a_settlement_value_before_the_grace() {
    let mut c = setup();
    ctx("outcomes.testnet", T0 + WINDOW_24H + 10, 0);
    c.on_settlement(1, Ok(Settlement { finalized: false, value: 0 }));
}

#[test]
#[should_panic(expected = "series not expired")]
fn cannot_settle_early() {
    let mut c = setup();
    ctx("keeper.testnet", T0 + 100, 0);
    let _ = c.settle(1);
}

#[test]
#[should_panic(expected = "needs a larger storage deposit")]
fn holding_tokens_needs_storage() {
    let mut c = setup();
    ctx(
        "carol.testnet",
        T0,
        NearToken::from_yoctonear(c.storage_balance_bounds().min.as_yoctonear()).as_yoctonear(),
    );
    c.storage_deposit(None, Some(true));
    ctx("usdc.testnet", T0 + 10, 0);
    let _ =
        c.ft_on_transfer(acc("carol.testnet"), U128(1), r#"{"mint":{"series":1,"receiver":null}}"#.into());
    ctx("outcomes.testnet", T0 + 10, 0);
    c.on_mint_checked(
        1,
        acc("carol.testnet"),
        acc("carol.testnet"),
        U128(1),
        Ok(Some(snapshot(1, Status::Active))),
    );
}

#[test]
fn resolve_refunds_what_the_receiver_did_not_use() {
    let mut c = setup();
    mint(&mut c, "alice.testnet", 10_000_000);
    ctx("alice.testnet", T0 + 30, 1);
    let _ = c.mt_transfer_call(acc("bob.testnet"), "1:up".into(), U128(6_000_000), None, None, "x".into());
    assert_eq!(bal(&c, "bob.testnet", "1:up"), 6_000_000);
    // The receiver's mt_on_transfer failed, so everything is unused and goes back.
    ctx_with("outcomes.testnet", T0 + 31, 0, vec![near_sdk::PromiseResult::Failed]);
    let used = c.mt_resolve_transfer(
        vec![acc("alice.testnet")],
        acc("bob.testnet"),
        vec!["1:up".into()],
        vec![U128(6_000_000)],
        None,
    );
    assert_eq!(used, vec![U128(0)]);
    assert_eq!(bal(&c, "alice.testnet", "1:up"), 10_000_000);
    assert_eq!(bal(&c, "bob.testnet", "1:up"), 0);
}

#[test]
#[should_panic(expected = "insufficient balance")]
fn cannot_transfer_more_than_owned() {
    let mut c = setup();
    mint(&mut c, "alice.testnet", 1);
    ctx("alice.testnet", T0 + 30, 1);
    c.mt_transfer(acc("bob.testnet"), "1:up".into(), U128(2), None, None);
}

#[test]
fn storage_frees_with_zero_balances() {
    let mut c = setup();
    let before = c.storage_balance_of(acc("alice.testnet")).unwrap().available;
    mint(&mut c, "alice.testnet", 5);
    let during = c.storage_balance_of(acc("alice.testnet")).unwrap().available;
    assert!(during < before);
    ctx("alice.testnet", T0 + 20, 0);
    let _ = c.redeem_sets(1, U128(5));
    assert_eq!(c.storage_balance_of(acc("alice.testnet")).unwrap().available, before);
}

#[test]
fn resolve_keeps_what_the_receiver_used() {
    let mut c = setup();
    mint(&mut c, "alice.testnet", 10_000_000);
    ctx("alice.testnet", T0 + 30, 1);
    let _ = c.mt_transfer_call(acc("bob.testnet"), "1:up".into(), U128(6_000_000), None, None, "x".into());
    let answer = near_sdk::serde_json::to_vec(&vec![U128(2_000_000)]).unwrap();
    ctx_with("outcomes.testnet", T0 + 31, 0, vec![near_sdk::PromiseResult::Successful(answer)]);
    let used = c.mt_resolve_transfer(
        vec![acc("alice.testnet")],
        acc("bob.testnet"),
        vec!["1:up".into()],
        vec![U128(6_000_000)],
        None,
    );
    assert_eq!(used, vec![U128(4_000_000)]);
    assert_eq!(bal(&c, "alice.testnet", "1:up"), 6_000_000);
    assert_eq!(bal(&c, "bob.testnet", "1:up"), 4_000_000);
}
