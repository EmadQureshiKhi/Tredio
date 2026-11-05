use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_contract_standards::storage_management::StorageManagement;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken, PromiseError, PromiseOrValue};
use tredio_common::{IndexSnapshot, Status, ONE_USDC};

use super::*;
use crate::ops::FtMsg;

const T0: u64 = 1_800_000_000;
const P: u64 = INDEX_SCALE; // one index point

fn ctx(who: &str, secs: u64, deposit: u128) {
    testing_env!(VMContextBuilder::new()
        .predecessor_account_id(who.parse().unwrap())
        .current_account_id("perps.testnet".parse().unwrap())
        .block_timestamp(secs * 1_000_000_000)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .build());
}

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn snap(index: u64, status: Status, fresh: bool) -> Option<IndexSnapshot> {
    Some(IndexSnapshot {
        id: "topic:a".into(),
        status,
        index,
        peak_index: index,
        updated_at: T0,
        fresh,
        retired_at: None,
        surfacer: Some(acc("curator.testnet")),
    })
}

fn setup(pool: u128) -> Perps {
    ctx("owner.testnet", T0, 0);
    let mut c = Perps::new(
        acc("owner.testnet"),
        acc("usdc.testnet"),
        acc("registry.testnet"),
        acc("curation.testnet"),
        acc("treasury.testnet"),
        U128(1_000_000 * ONE_USDC),
    );
    for who in ["alice.testnet", "bob.testnet"] {
        ctx(who, T0, NearToken::from_millinear(50).as_yoctonear());
        c.storage_deposit(None, None);
    }
    if pool > 0 {
        ctx("usdc.testnet", T0, 0);
        let _ = c.ft_on_transfer(acc("lp.testnet"), U128(pool), r#""deposit_pool""#.into());
    }
    c
}

fn open(c: &mut Perps, who: &str, secs: u64, is_long: bool, margin: u128, lev: u32, index: u64) -> u128 {
    let msg = near_sdk::serde_json::to_string(&FtMsg::Open {
        trend: "topic:a".into(),
        is_long,
        leverage_bps: lev,
        acceptable_index: if is_long { u64::MAX } else { 0 },
        deadline: None,
        owner: None,
    })
    .unwrap();
    ctx("usdc.testnet", secs, 0);
    assert!(matches!(c.ft_on_transfer(acc(who), U128(margin), msg), PromiseOrValue::Promise(_)));
    ctx("perps.testnet", secs, 0);
    c.on_open(
        acc(who),
        acc(who),
        "topic:a".into(),
        is_long,
        U128(margin),
        lev,
        if is_long { u64::MAX } else { 0 },
        None,
        Ok(snap(index, Status::Active, true)),
    )
    .0
}

#[test]
fn opens_with_fee_and_qty() {
    let mut c = setup(100_000 * ONE_USDC);
    assert_eq!(open(&mut c, "alice.testnet", T0, true, 100 * ONE_USDC, 30_000, 50 * P), 0);
    let p = c.get_position(1).unwrap();
    // net = 100 / (1 + 3 x 0.001) = 99.700897; notional = 3 x net; qty = notional / 50.
    assert_eq!(p.margin.0, 99_700_897);
    assert_eq!(notional(p.qty.0, 50 * P), 299_102_691);
    assert_eq!(p.entry_index, 50 * P);
    let (pool, margin, fees) = c.totals();
    assert_eq!(margin.0, 99_700_897);
    let fee = 100 * ONE_USDC - 99_700_897;
    assert_eq!(pool.0, 100_000 * ONE_USDC + fee * 60 / 100);
    assert_eq!(fees.0, fee - fee * 60 / 100 - fee * 15 / 100);
    assert_eq!(c.positions_of(acc("alice.testnet")).len(), 1);
}

#[test]
fn refuses_and_refunds_bad_opens() {
    let mut c = setup(100_000 * ONE_USDC);
    ctx("perps.testnet", T0, 0);
    let try_open =
        |c: &mut Perps, s: Result<Option<IndexSnapshot>, PromiseError>, acceptable: u64, margin: u128| {
            c.on_open(
                acc("alice.testnet"),
                acc("alice.testnet"),
                "topic:a".into(),
                true,
                U128(margin),
                20_000,
                acceptable,
                None,
                s,
            )
            .0
        };
    assert_eq!(try_open(&mut c, Err(PromiseError::Failed), u64::MAX, 10 * ONE_USDC), 10 * ONE_USDC);
    assert_eq!(
        try_open(&mut c, Ok(snap(50 * P, Status::Cooling, true)), u64::MAX, 10 * ONE_USDC),
        10 * ONE_USDC
    );
    assert_eq!(
        try_open(&mut c, Ok(snap(50 * P, Status::Active, false)), u64::MAX, 10 * ONE_USDC),
        10 * ONE_USDC
    );
    assert_eq!(
        try_open(&mut c, Ok(snap(50 * P, Status::Active, true)), 49 * P, 10 * ONE_USDC),
        10 * ONE_USDC
    );
    assert_eq!(
        try_open(&mut c, Ok(snap(50 * P, Status::Active, true)), u64::MAX, ONE_USDC / 2),
        ONE_USDC / 2
    );
    let logs = get_logs().join("\n");
    for r in [
        "registry unavailable",
        "trend not active",
        "index stale",
        "price not acceptable",
        "margin too small",
    ] {
        assert!(logs.contains(r), "{r}");
    }
    assert_eq!(c.position_count(), 0);
}

#[test]
fn caps_open_interest_by_pool_and_attention() {
    let mut c = setup(1_000 * ONE_USDC);
    // Cap at a 50-point index: 5 x 1000 = 5000 USDC per side.
    assert_eq!(c.open_interest_cap(50 * P).0, 5_000 * ONE_USDC);
    // At 5 points attention scales it to 20%.
    assert_eq!(c.open_interest_cap(5 * P).0, 1_000 * ONE_USDC);
    assert_eq!(open(&mut c, "alice.testnet", T0, true, 2_000 * ONE_USDC, 30_000, 50 * P), 2_000 * ONE_USDC);
    assert!(get_logs().iter().any(|l| l.contains("open interest cap")));
}

#[test]
fn closes_with_profit_and_pays_from_the_pool() {
    let mut c = setup(10_000 * ONE_USDC);
    open(&mut c, "alice.testnet", T0, true, 100 * ONE_USDC, 10_000, 50 * P);
    let margin = c.get_position(1).unwrap().margin.0;
    // Closed in the same second it opened, so no funding accrues.
    ctx("alice.testnet", T0, 0);
    let _ = c.close(1, 0);
    ctx("perps.testnet", T0, 0);
    let payout = c.on_close(1, 0, Ok(snap(55 * P, Status::Active, true))).0;
    // +10% on 1x notional, minus the closing fee on the new notional.
    let gain = margin / 10;
    let fee = (margin + gain) * 10 / 10_000;
    assert!(payout.abs_diff(margin + gain - fee) <= 2, "payout {payout}");
    assert_eq!(c.position_count(), 0);
    assert_eq!(c.totals().1 .0, 0);
}

#[test]
#[should_panic(expected = "not your position")]
fn only_the_owner_closes() {
    let mut c = setup(10_000 * ONE_USDC);
    open(&mut c, "alice.testnet", T0, true, 100 * ONE_USDC, 10_000, 50 * P);
    ctx("bob.testnet", T0, 0);
    let _ = c.close(1, 0);
}

#[test]
#[should_panic(expected = "index stale")]
fn never_closes_on_a_stale_index() {
    let mut c = setup(10_000 * ONE_USDC);
    open(&mut c, "alice.testnet", T0, true, 100 * ONE_USDC, 10_000, 50 * P);
    ctx("perps.testnet", T0, 0);
    c.on_close(1, 0, Ok(snap(55 * P, Status::Active, false)));
}

#[test]
fn liquidates_underwater_positions_and_rewards_the_keeper() {
    let mut c = setup(10_000 * ONE_USDC);
    open(&mut c, "alice.testnet", T0, true, 100 * ONE_USDC, 30_000, 50 * P);
    let p = c.get_position(1).unwrap();
    let st = c.position_state(1, Some(50 * P));
    assert!(!st.liquidatable);
    // A 3x long loses its margin over a ~33% drop; maintenance is hit a little earlier.
    let li = st.liquidation_index;
    assert!(li > 35 * P && li < 40 * P, "liquidation index {li}");
    assert!(c.position_state(1, Some(li - P / 10)).liquidatable);
    assert!(!c.position_state(1, Some(li + P / 10)).liquidatable);
    ctx("perps.testnet", T0 + 10, 0);
    let reward = c.on_liquidate(1, acc("keeper.testnet"), Ok(snap(li - P / 10, Status::Active, true))).0;
    assert!(reward > 0 && reward <= notional(p.qty.0, li) / 100);
    assert_eq!(c.position_count(), 0);
}

#[test]
#[should_panic(expected = "not liquidatable")]
fn healthy_positions_are_not_liquidated() {
    let mut c = setup(10_000 * ONE_USDC);
    open(&mut c, "alice.testnet", T0, true, 100 * ONE_USDC, 30_000, 50 * P);
    ctx("perps.testnet", T0 + 10, 0);
    c.on_liquidate(1, acc("keeper.testnet"), Ok(snap(49 * P, Status::Active, true)));
}

#[test]
fn funding_flows_from_the_crowded_side() {
    let mut c = setup(100_000 * ONE_USDC);
    open(&mut c, "alice.testnet", T0, true, 300 * ONE_USDC, 10_000, 50 * P);
    open(&mut c, "bob.testnet", T0, false, 100 * ONE_USDC, 10_000, 50 * P);
    assert!(c.funding_rate("topic:a".into()).parse::<i128>().unwrap() > 0, "longs pay");
    ctx("perps.testnet", T0 + 86_400, 0);
    c.on_poke("topic:a".into(), Ok(snap(50 * P, Status::Active, true)));
    let long = c.position_state(1, Some(50 * P));
    let short = c.position_state(2, Some(50 * P));
    assert!(long.funding > 0 && short.funding < 0);
    // Receivers never get more than payers pay.
    assert!(-short.funding <= long.funding);
}

#[test]
fn retired_trends_settle_without_fee() {
    let mut c = setup(10_000 * ONE_USDC);
    open(&mut c, "alice.testnet", T0, false, 100 * ONE_USDC, 10_000, 50 * P);
    let margin = c.get_position(1).unwrap().margin.0;
    ctx("perps.testnet", T0 + 10, 0);
    let payout = c.on_settle_retired(1, Ok(snap(50 * P, Status::Retired, false))).0;
    assert_eq!(payout, margin);
}

#[test]
fn a_failed_payout_becomes_claimable() {
    let mut c = setup(10_000 * ONE_USDC);
    ctx("perps.testnet", T0, 0);
    assert_eq!(c.after_send(acc("alice.testnet"), U128(5)).0, 0);
    assert_eq!(c.claimable_of(acc("alice.testnet")).0, 5);
}

#[test]
fn socializes_a_shortfall_instead_of_failing() {
    let mut c = setup(1_000 * ONE_USDC);
    open(&mut c, "alice.testnet", T0, true, 1_000 * ONE_USDC, 30_000, 50 * P);
    // A huge move: the pool cannot pay in full.
    ctx("perps.testnet", T0 + 60, 0);
    let payout = c.on_close(1, 0, Ok(snap(200 * P, Status::Active, true))).0;
    assert!(get_logs().iter().any(|l| l.contains("socialized_loss")));
    assert_eq!(c.pool().0, 0);
    assert!(payout > 0);
}

#[test]
fn only_owners_add_margin() {
    let mut c = setup(10_000 * ONE_USDC);
    open(&mut c, "alice.testnet", T0, true, 100 * ONE_USDC, 10_000, 50 * P);
    ctx("usdc.testnet", T0, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.ft_on_transfer(acc("bob.testnet"), U128(5), r#"{"add_margin":{"id":1}}"#.into());
    }));
    assert!(r.is_err());
}
