use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId, PromiseResult};
use tredio_common::{IndexSnapshot, Status, ONE_USDC};

use super::*;

const T0: u64 = 1_800_000_000;

fn ctx(who: &str, results: Vec<PromiseResult>) {
    testing_env!(
        VMContextBuilder::new()
            .predecessor_account_id(who.parse().unwrap())
            .current_account_id("coins.testnet".parse().unwrap())
            .account_balance(NearToken::from_near(100))
            .block_timestamp(T0 * 1_000_000_000)
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn snap(peak: u64, status: Status) -> Result<Option<IndexSnapshot>, PromiseError> {
    Ok(Some(IndexSnapshot {
        id: "topic:openai".into(),
        status,
        index: peak,
        peak_index: peak,
        updated_at: T0,
        fresh: true,
        retired_at: None,
        surfacer: Some(acc("curator.testnet")),
    }))
}

fn setup() -> Coins {
    ctx("owner.testnet", vec![]);
    let mut c = Coins::new(
        acc("owner.testnet"),
        acc("usdc.testnet"),
        acc("registry.testnet"),
        acc("curation.testnet"),
        acc("treasury.testnet"),
        acc("ref-finance-101.testnet"),
        30,
        Base58CryptoHash::from([7u8; 32]),
        U128(1_000 * ONE_USDC),
        U128(500 * ONE_USDC),
    );
    ctx("coins.testnet", vec![]);
    assert!(c.on_create_checked("topic:openai".into(), snap(40_000_000, Status::Active)).is_some());
    ctx("coins.testnet", vec![PromiseResult::Successful(vec![])]);
    assert!(c.on_coin_created("topic:openai".into()));
    c
}

fn buy(c: &mut Coins, usdc: u128, peak: u64) -> u128 {
    ctx("usdc.testnet", vec![]);
    let msg = r#"{"buy":{"trend":"topic:openai","min_out":"0","receiver":null}}"#;
    assert!(matches!(
        c.ft_on_transfer(acc("alice.testnet"), U128(usdc), msg.into()),
        PromiseOrValue::Promise(_)
    ));
    ctx("coins.testnet", vec![]);
    c.on_buy(
        acc("alice.testnet"),
        acc("alice.testnet"),
        "topic:openai".into(),
        U128(usdc),
        U128(0),
        snap(peak, Status::Active),
    )
    .0
}

#[test]
fn names_coins_from_trends() {
    assert_eq!(slug("topic:openai.2"), "topic-openai-2");
    assert_eq!(symbol("topic:openai.2"), "OPENAI");
    assert_eq!(symbol("crypto:btc"), "BTC");
    let c = setup();
    let curve = c.get_curve("topic:openai".into()).unwrap();
    assert_eq!(curve.coin, acc("topic-openai.coins.testnet"));
    assert_eq!(curve.stage, Stage::Open);
    assert_eq!(c.trend_of_coin(acc("topic-openai.coins.testnet")), Some("topic:openai".into()));
}

#[test]
fn a_failed_coin_account_frees_the_trend() {
    ctx("owner.testnet", vec![]);
    let mut c = setup();
    ctx("coins.testnet", vec![]);
    assert!(c.on_create_checked("topic:b".into(), snap(40_000_000, Status::Active)).is_some());
    ctx("coins.testnet", vec![PromiseResult::Failed]);
    assert!(!c.on_coin_created("topic:b".into()));
    assert!(c.get_curve("topic:b".into()).is_none());
}

#[test]
fn inactive_trends_get_no_curve() {
    let mut c = setup();
    ctx("coins.testnet", vec![]);
    assert!(c.on_create_checked("topic:c".into(), snap(40_000_000, Status::Cooling)).is_none());
}

#[test]
fn buys_mint_and_book_fees() {
    let mut c = setup();
    assert_eq!(buy(&mut c, 10 * ONE_USDC, 40_000_000), 0);
    let curve = c.get_curve("topic:openai".into()).unwrap();
    assert!(curve.math.sold > 0);
    assert_eq!(curve.math.floor_reserve, ONE_USDC / 10 * 3 / 10);
    assert_eq!(c.protocol_fees().0, ONE_USDC / 10 * 3 / 10);
    assert!(get_logs().iter().any(|l| l.contains("tredio-coins") && l.contains("\"is_buy\":true")));
}

#[test]
fn refuses_buys_when_the_trend_cools() {
    let mut c = setup();
    ctx("coins.testnet", vec![]);
    let unused = c
        .on_buy(
            acc("alice.testnet"),
            acc("alice.testnet"),
            "topic:openai".into(),
            U128(5),
            U128(0),
            snap(1, Status::Cooling),
        )
        .0;
    assert_eq!(unused, 5);
}

#[test]
fn peak_attention_ratchets_the_floor() {
    let mut c = setup();
    for _ in 0..10 {
        buy(&mut c, 40 * ONE_USDC, 40_000_000);
    }
    let before = c.get_curve("topic:openai".into()).unwrap().math.virtual_quote;
    buy(&mut c, ONE_USDC, 44_000_000);
    let after = c.get_curve("topic:openai".into()).unwrap().math;
    assert!(after.virtual_quote > before);
    assert!(after.is_solvent());
    assert!(get_logs().iter().any(|l| l.contains("floor_raised")));
}

#[test]
fn sells_burn_and_pay() {
    let mut c = setup();
    buy(&mut c, 10 * ONE_USDC, 40_000_000);
    let sold = c.get_curve("topic:openai".into()).unwrap().math.sold;
    ctx("topic-openai.coins.testnet", vec![]);
    let r = c.ft_on_transfer(
        acc("alice.testnet"),
        U128(sold),
        r#"{"sell":{"min_out":"1","receiver":null}}"#.into(),
    );
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
    assert_eq!(c.get_curve("topic:openai".into()).unwrap().math.sold, 0);
}

#[test]
#[should_panic(expected = "not a trend coin")]
fn rejects_unknown_tokens() {
    let mut c = setup();
    ctx("fake.testnet", vec![]);
    let _ =
        c.ft_on_transfer(acc("alice.testnet"), U128(1), r#"{"sell":{"min_out":"1","receiver":null}}"#.into());
}

#[test]
fn graduates_step_by_step() {
    let mut c = setup();
    while c.get_curve("topic:openai".into()).unwrap().stage == Stage::Open {
        buy(&mut c, 40 * ONE_USDC, 40_000_000);
    }
    let curve = c.get_curve("topic:openai".into()).unwrap();
    assert_eq!(curve.stage, Stage::Ready);
    // Buys are closed now.
    ctx("coins.testnet", vec![]);
    assert_eq!(
        c.on_buy(
            acc("bob.testnet"),
            acc("bob.testnet"),
            "topic:openai".into(),
            U128(5),
            U128(0),
            snap(1, Status::Active)
        )
        .0,
        5
    );
    // Pool created (id 4242): the curve's USDC is frozen for graduation.
    ctx("coins.testnet", vec![]);
    assert_eq!(c.on_pool_created("topic:openai".into(), Ok(4242)), Stage::Pooled);
    let curve = c.get_curve("topic:openai".into()).unwrap();
    assert_eq!(curve.pool_id, Some(4242));
    assert!(curve.grad_quote.0 >= 500 * ONE_USDC);
    assert_eq!(curve.math.reserve, 0);
    ctx("coins.testnet", vec![PromiseResult::Successful(vec![]), PromiseResult::Successful(vec![])]);
    assert!(c.on_grad_minted("topic:openai".into()));
    let coins = curve.grad_coins.0.to_string();
    ctx("coins.testnet", vec![PromiseResult::Successful(format!("\"{coins}\"").into_bytes())]);
    assert!(c.on_deposited("topic:openai".into(), true));
    // A failed USDC deposit (nothing used) is retried.
    ctx("coins.testnet", vec![PromiseResult::Successful(b"\"0\"".to_vec())]);
    assert!(!c.on_deposited("topic:openai".into(), false));
    let quote = curve.grad_quote.0.to_string();
    ctx("coins.testnet", vec![PromiseResult::Successful(format!("\"{quote}\"").into_bytes())]);
    assert!(c.on_deposited("topic:openai".into(), false));
    ctx("coins.testnet", vec![PromiseResult::Successful(vec![])]);
    assert_eq!(c.on_liquidity_added("topic:openai".into()), Stage::Graduated);
    assert!(get_logs().iter().any(|l| l.contains("\"graduated\"") && l.contains("4242")));
}

#[test]
fn a_failed_pool_keeps_the_curve_ready() {
    let mut c = setup();
    while c.get_curve("topic:openai".into()).unwrap().stage == Stage::Open {
        buy(&mut c, 40 * ONE_USDC, 40_000_000);
    }
    ctx("coins.testnet", vec![]);
    assert_eq!(c.on_pool_created("topic:openai".into(), Err(PromiseError::Failed)), Stage::Ready);
    assert!(c.get_curve("topic:openai".into()).unwrap().math.reserve > 0);
}
