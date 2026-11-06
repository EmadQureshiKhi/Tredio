use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_contract_standards::storage_management::StorageManagement;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, NearToken, PromiseError, PromiseOrValue};
use tredio_common::{IndexSnapshot, Status};

use super::*;
use crate::book::cost;
use crate::receivers::TransferMsg;

const T0: u64 = 1_800_000_000;
const EXPIRY: u64 = T0 + 86_400;

fn ctx(who: &str, secs: u64, deposit: u128) {
    testing_env!(VMContextBuilder::new()
        .predecessor_account_id(who.parse().unwrap())
        .current_account_id("book.testnet".parse().unwrap())
        .block_timestamp(secs * 1_000_000_000)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .prepaid_gas(Gas::from_tgas(300))
        .build());
}

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn info() -> SeriesInfo {
    SeriesInfo { trend: "topic:a".into(), opening_index: 50_000_000, expiry: EXPIRY }
}

fn setup(fee_bps: u32) -> Book {
    ctx("owner.testnet", T0, 0);
    let mut b = Book::new(
        acc("owner.testnet"),
        acc("usdc.testnet"),
        acc("outcomes.testnet"),
        acc("registry.testnet"),
        acc("treasury.testnet"),
        fee_bps,
    );
    ctx("book.testnet", T0, 0);
    assert!(b.on_series_info(1, Ok(Some(info()))));
    for who in ["mm.testnet", "alice.testnet", "bob.testnet", "treasury.testnet"] {
        ctx(who, T0, NearToken::from_millinear(100).as_yoctonear());
        b.storage_deposit(None, None);
    }
    b
}

fn deposit_usdc(b: &mut Book, who: &str, amount: u128) {
    ctx("usdc.testnet", T0, 0);
    let r = b.ft_on_transfer(acc(who), U128(amount), String::new());
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
}

fn deposit_tokens(b: &mut Book, who: &str, side: Side, amount: u128) {
    ctx("outcomes.testnet", T0, 0);
    let id = format!("1:{}", side.as_str());
    let r = b.mt_on_transfer(acc(who), vec![acc(who)], vec![id], vec![U128(amount)], String::new());
    assert!(matches!(r, PromiseOrValue::Value(ref v) if v == &vec![U128(0)]));
}

fn spec(side: Side, dir: Dir, tick: u16, size: u128, tif: TimeInForce) -> OrderSpec {
    OrderSpec { series: 1, side, dir, tick, size: U128(size), tif }
}

fn place(b: &mut Book, who: &str, s: OrderSpec) -> Placement {
    ctx(who, T0 + 10, 0);
    b.place_order(s)
}

fn usdc(b: &Book, who: &str) -> u128 {
    b.balance_of(acc(who), Asset::Usdc).0
}

fn up(b: &Book, who: &str) -> u128 {
    b.balance_of(acc(who), Asset::Token { series: 1, side: Side::Up }).0
}

const ONE: u128 = 1_000_000;

#[test]
fn lists_both_sides_once() {
    let mut b = setup(0);
    assert!(b.get_market(1, Side::Up).is_some() && b.get_market(1, Side::Down).is_some());
    ctx("book.testnet", T0, 0);
    assert!(!b.on_series_info(1, Ok(Some(info()))));
    assert!(!b.on_series_info(2, Err(PromiseError::Failed)));
    let expired = SeriesInfo { expiry: T0 - 1, ..info() };
    assert!(!b.on_series_info(3, Ok(Some(expired))));
}

#[test]
fn rests_and_matches_in_price_time_order() {
    let mut b = setup(0);
    deposit_tokens(&mut b, "mm.testnet", Side::Up, 10 * ONE);
    deposit_tokens(&mut b, "bob.testnet", Side::Up, 10 * ONE);
    // Two asks at 0.60: mm first, then bob; one at 0.55 from bob.
    place(&mut b, "mm.testnet", spec(Side::Up, Dir::Sell, 600, 2 * ONE, TimeInForce::Gtc));
    place(&mut b, "bob.testnet", spec(Side::Up, Dir::Sell, 600, 2 * ONE, TimeInForce::Gtc));
    place(&mut b, "bob.testnet", spec(Side::Up, Dir::Sell, 550, ONE, TimeInForce::Gtc));
    let d = b.depth(1, Side::Up, None);
    assert_eq!(
        d.asks.iter().map(|l| (l.tick, l.size.0)).collect::<Vec<_>>(),
        vec![(550, ONE), (600, 4 * ONE)]
    );

    deposit_usdc(&mut b, "alice.testnet", 10 * ONE);
    let p = place(&mut b, "alice.testnet", spec(Side::Up, Dir::Buy, 600, 2 * ONE, TimeInForce::Gtc));
    // 1 at 0.55 (bob) then 1 at 0.60 (mm, first in time).
    assert_eq!(p.filled.0, 2 * ONE);
    assert_eq!(p.usdc.0, 1_150_000);
    assert_eq!(p.order_id, None);
    assert_eq!(up(&b, "alice.testnet"), 2 * ONE);
    assert_eq!(usdc(&b, "alice.testnet"), 10 * ONE - 1_150_000);
    assert_eq!(usdc(&b, "bob.testnet"), 550_000);
    assert_eq!(usdc(&b, "mm.testnet"), 600_000);
    let d = b.depth(1, Side::Up, None);
    assert_eq!(d.asks.iter().map(|l| (l.tick, l.size.0)).collect::<Vec<_>>(), vec![(600, 3 * ONE)]);
    assert_eq!(d.last_tick, Some(600));
}

#[test]
fn rests_the_remainder_and_cancel_returns_it() {
    let mut b = setup(0);
    deposit_usdc(&mut b, "alice.testnet", 10 * ONE);
    let p = place(&mut b, "alice.testnet", spec(Side::Up, Dir::Buy, 400, 5 * ONE, TimeInForce::Gtc));
    let id = p.order_id.unwrap();
    assert_eq!(usdc(&b, "alice.testnet"), 8 * ONE);
    assert_eq!(b.depth(1, Side::Up, None).bids[0].size.0, 5 * ONE);
    ctx("alice.testnet", T0 + 20, 0);
    assert_eq!(b.cancel_order(id).0, 5 * ONE);
    assert_eq!(usdc(&b, "alice.testnet"), 10 * ONE);
    assert!(b.depth(1, Side::Up, None).bids.is_empty());
}

#[test]
fn post_only_is_skipped_when_it_would_cross() {
    let mut b = setup(0);
    deposit_tokens(&mut b, "mm.testnet", Side::Up, ONE);
    place(&mut b, "mm.testnet", spec(Side::Up, Dir::Sell, 500, ONE, TimeInForce::Gtc));
    deposit_usdc(&mut b, "alice.testnet", ONE);
    let p = place(&mut b, "alice.testnet", spec(Side::Up, Dir::Buy, 500, ONE, TimeInForce::PostOnly));
    assert!(p.skipped);
    assert_eq!(usdc(&b, "alice.testnet"), ONE);
    assert!(get_logs().iter().any(|l| l.contains("order_skipped")));
}

#[test]
fn ioc_never_rests() {
    let mut b = setup(0);
    deposit_usdc(&mut b, "alice.testnet", ONE);
    let p = place(&mut b, "alice.testnet", spec(Side::Up, Dir::Buy, 500, ONE, TimeInForce::Ioc));
    assert_eq!((p.order_id, p.filled.0), (None, 0));
    assert_eq!(usdc(&b, "alice.testnet"), ONE);
}

#[test]
fn self_trades_cancel_the_resting_order() {
    let mut b = setup(0);
    deposit_tokens(&mut b, "alice.testnet", Side::Up, ONE);
    deposit_usdc(&mut b, "alice.testnet", ONE);
    place(&mut b, "alice.testnet", spec(Side::Up, Dir::Sell, 500, ONE, TimeInForce::Gtc));
    let p = place(&mut b, "alice.testnet", spec(Side::Up, Dir::Buy, 500, ONE, TimeInForce::Ioc));
    assert_eq!(p.filled.0, 0);
    assert_eq!(up(&b, "alice.testnet"), ONE);
    assert!(b.depth(1, Side::Up, None).asks.is_empty());
}

#[test]
fn takers_pay_the_fee_to_the_treasury() {
    let mut b = setup(20);
    deposit_tokens(&mut b, "mm.testnet", Side::Up, 10 * ONE);
    place(&mut b, "mm.testnet", spec(Side::Up, Dir::Sell, 500, 10 * ONE, TimeInForce::Gtc));
    deposit_usdc(&mut b, "alice.testnet", 10 * ONE);
    let p = place(&mut b, "alice.testnet", spec(Side::Up, Dir::Buy, 500, 10 * ONE, TimeInForce::Ioc));
    assert_eq!(p.usdc.0, 5 * ONE + 10_000);
    assert_eq!(b.accrued_fees().0, 10_000);
    ctx("anyone.testnet", T0, 0);
    b.sweep_fees();
    assert_eq!(usdc(&b, "treasury.testnet"), 10_000);
}

#[test]
#[should_panic(expected = "insufficient balance")]
fn cannot_buy_beyond_the_balance() {
    let mut b = setup(0);
    deposit_tokens(&mut b, "mm.testnet", Side::Up, 10 * ONE);
    place(&mut b, "mm.testnet", spec(Side::Up, Dir::Sell, 500, 10 * ONE, TimeInForce::Gtc));
    deposit_usdc(&mut b, "alice.testnet", ONE);
    place(&mut b, "alice.testnet", spec(Side::Up, Dir::Buy, 500, 4 * ONE, TimeInForce::Ioc));
}

#[test]
#[should_panic(expected = "size must be a positive multiple")]
fn rejects_dust_sizes() {
    let mut b = setup(0);
    deposit_usdc(&mut b, "alice.testnet", ONE);
    place(&mut b, "alice.testnet", spec(Side::Up, Dir::Buy, 500, 1_500, TimeInForce::Gtc));
}

#[test]
fn swaps_buy_within_a_usdc_budget_and_return_the_rest() {
    let mut b = setup(0);
    deposit_tokens(&mut b, "mm.testnet", Side::Up, 10 * ONE);
    place(&mut b, "mm.testnet", spec(Side::Up, Dir::Sell, 400, ONE, TimeInForce::Gtc));
    place(&mut b, "mm.testnet", spec(Side::Up, Dir::Sell, 450, 5 * ONE, TimeInForce::Gtc));
    ctx("usdc.testnet", T0 + 10, 0);
    let msg = near_sdk::serde_json::to_string(&TransferMsg::Swap {
        series: 1,
        side: Side::Up,
        limit_tick: Some(450),
        min_out: U128(ONE),
        anchored: false,
    })
    .unwrap();
    let r = b.ft_on_transfer(acc("alice.testnet"), U128(ONE), msg);
    // 0.40 for the first token, then 0.60 USDC buys 1.333 tokens at 0.45 (rounded to lots).
    let PromiseOrValue::Value(unused) = r else { panic!() };
    assert_eq!(unused.0, ONE - 400_000 - 1_333 * 450);
    assert!(get_logs().iter().any(|l| l.contains("\"swap\"") && l.contains("\"amount_out\":\"2333000\"")));
    // Swappers never need a trading balance.
    assert_eq!(usdc(&b, "alice.testnet"), 0);
}

#[test]
#[should_panic(expected = "swap output below the minimum")]
fn swaps_respect_min_out() {
    let mut b = setup(0);
    deposit_tokens(&mut b, "mm.testnet", Side::Up, ONE);
    place(&mut b, "mm.testnet", spec(Side::Up, Dir::Sell, 400, ONE, TimeInForce::Gtc));
    ctx("usdc.testnet", T0 + 10, 0);
    let msg = r#"{"swap":{"series":1,"side":"up","limit_tick":999,"min_out":"5000000","anchored":false}}"#;
    let _ = b.ft_on_transfer(acc("alice.testnet"), U128(5 * ONE), msg.into());
}

#[test]
fn anchored_swaps_stay_inside_the_band() {
    let mut b = setup(0);
    deposit_tokens(&mut b, "mm.testnet", Side::Up, 10 * ONE);
    // At the money with a day left, UP is worth about 0.50: asks at 0.55 and 0.70.
    place(&mut b, "mm.testnet", spec(Side::Up, Dir::Sell, 550, ONE, TimeInForce::Gtc));
    place(&mut b, "mm.testnet", spec(Side::Up, Dir::Sell, 700, ONE, TimeInForce::Gtc));
    ctx("book.testnet", T0 + 10, 0);
    let snap = IndexSnapshot {
        id: "topic:a".into(),
        status: Status::Active,
        index: 50_000_000,
        peak_index: 50_000_000,
        updated_at: T0,
        fresh: true,
        retired_at: None,
        surfacer: None,
    };
    let unused = b.on_anchor(
        acc("alice.testnet"),
        1,
        Side::Up,
        Dir::Buy,
        U128(2 * ONE),
        None,
        U128(1),
        Ok(Some(snap)),
    );
    // Only the 0.55 ask is within 0.10 of fair.
    assert_eq!(unused.0, 2 * ONE - 550_000);
    assert_eq!(b.depth(1, Side::Up, None).asks[0].tick, 700);
}

#[test]
#[should_panic(expected = "index stale")]
fn anchored_swaps_need_a_fresh_index() {
    let mut b = setup(0);
    ctx("book.testnet", T0 + 10, 0);
    let snap = IndexSnapshot {
        id: "topic:a".into(),
        status: Status::Active,
        index: 50_000_000,
        peak_index: 50_000_000,
        updated_at: T0,
        fresh: false,
        retired_at: None,
        surfacer: None,
    };
    b.on_anchor(acc("alice.testnet"), 1, Side::Up, Dir::Buy, U128(ONE), None, U128(1), Ok(Some(snap)));
}

#[test]
fn anchored_limits() {
    assert_eq!(Book::anchored_limit(Dir::Buy, 500_000, None), 600);
    assert_eq!(Book::anchored_limit(Dir::Buy, 500_000, Some(580)), 580);
    assert_eq!(Book::anchored_limit(Dir::Sell, 500_000, None), 400);
    assert_eq!(Book::anchored_limit(Dir::Sell, 500_500, None), 401);
    assert_eq!(Book::anchored_limit(Dir::Sell, 50_000, None), MIN_TICK);
    assert_eq!(Book::anchored_limit(Dir::Buy, 950_000, None), MAX_TICK);
}

#[test]
fn batch_update_requotes_without_failing_on_stale_ids() {
    let mut b = setup(0);
    deposit_usdc(&mut b, "mm.testnet", 10 * ONE);
    deposit_tokens(&mut b, "mm.testnet", Side::Up, 10 * ONE);
    ctx("mm.testnet", T0 + 10, 0);
    let r = b.batch_update(
        vec![],
        vec![
            spec(Side::Up, Dir::Buy, 480, ONE, TimeInForce::PostOnly),
            spec(Side::Up, Dir::Sell, 520, ONE, TimeInForce::PostOnly),
        ],
    );
    let ids: Vec<u64> = r.iter().map(|p| p.order_id.unwrap()).collect();
    let r = b.batch_update(
        vec![ids[0], ids[1], 999],
        vec![
            spec(Side::Up, Dir::Buy, 490, ONE, TimeInForce::PostOnly),
            spec(Side::Up, Dir::Sell, 490, ONE, TimeInForce::PostOnly),
        ],
    );
    assert!(r[0].order_id.is_some());
    assert!(r[1].skipped, "a crossing post-only ask is skipped");
    let d = b.depth(1, Side::Up, None);
    assert_eq!((d.bids.len(), d.asks.len()), (1, 0));
}

#[test]
fn expired_markets_return_resting_funds() {
    let mut b = setup(0);
    deposit_usdc(&mut b, "alice.testnet", 10 * ONE);
    place(&mut b, "alice.testnet", spec(Side::Up, Dir::Buy, 400, 5 * ONE, TimeInForce::Gtc));
    ctx("keeper.testnet", EXPIRY, 0);
    assert_eq!(b.cancel_expired(1, Side::Up, None), 1);
    assert_eq!(usdc(&b, "alice.testnet"), 10 * ONE);
}

#[test]
fn conserves_value_across_many_trades() {
    let mut b = setup(15);
    let (mut usdc_in, mut up_in) = (0u128, 0u128);
    for who in ["mm.testnet", "alice.testnet", "bob.testnet"] {
        deposit_usdc(&mut b, who, 50 * ONE);
        deposit_tokens(&mut b, who, Side::Up, 50 * ONE);
        usdc_in += 50 * ONE;
        up_in += 50 * ONE;
    }
    let mut seed = 7u64;
    let mut rnd = |n: u64| {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (seed >> 33) % n
    };
    let who = ["mm.testnet", "alice.testnet", "bob.testnet"];
    for _ in 0..300 {
        let w = who[rnd(3) as usize];
        let dir = if rnd(2) == 0 { Dir::Buy } else { Dir::Sell };
        let tick = 400 + rnd(200) as u16;
        let size = (1 + rnd(3_000)) as u128 * LOT;
        let tif = [TimeInForce::Gtc, TimeInForce::Ioc, TimeInForce::PostOnly][rnd(3) as usize];
        let have = match dir {
            Dir::Buy => usdc(&b, w) >= cost(size, tick) + cost(size, tick) * 15 / 10_000,
            Dir::Sell => up(&b, w) >= size,
        };
        if have {
            place(&mut b, w, spec(Side::Up, dir, tick, size, tif));
        }
        if rnd(5) == 0 {
            let d = b.depth(1, Side::Up, Some(50));
            let _ = d;
        }
    }
    // Everything deposited is in a balance, an open order, or the fee pot.
    let mut usdc_held: u128 = who.iter().map(|w| usdc(&b, w)).sum::<u128>() + b.accrued_fees().0;
    let mut up_held: u128 = who.iter().map(|w| up(&b, w)).sum();
    for id in 1..b.next_order {
        if let Some(o) = b.get_order(id) {
            match o.dir {
                Dir::Buy => usdc_held += cost(o.remaining.0, o.tick),
                Dir::Sell => up_held += o.remaining.0,
            }
        }
    }
    assert_eq!(usdc_held, usdc_in);
    assert_eq!(up_held, up_in);
}

fn ctx_results(who: &str, secs: u64, results: Vec<near_sdk::PromiseResult>) {
    testing_env!(
        VMContextBuilder::new()
            .predecessor_account_id(who.parse().unwrap())
            .current_account_id("book.testnet".parse().unwrap())
            .block_timestamp(secs * 1_000_000_000)
            .prepaid_gas(Gas::from_tgas(300))
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}

#[test]
fn a_failed_delivery_still_counts_toward_storage() {
    let mut b = setup(0);
    deposit_tokens(&mut b, "alice.testnet", Side::Up, 5 * ONE);
    deposit_usdc(&mut b, "alice.testnet", 10 * ONE);
    ctx("alice.testnet", T0, 0);
    let _ = b.withdraw(Asset::Usdc, U128(10 * ONE));
    // The transfer failed: the book keeps the USDC as alice's balance again.
    ctx_results("book.testnet", T0, vec![near_sdk::PromiseResult::Failed]);
    assert_eq!(b.after_delivery(acc("alice.testnet"), Asset::Usdc, U128(10 * ONE)).0, 0);
    assert_eq!(usdc(&b, "alice.testnet"), 10 * ONE);
    // Withdrawn again, this time delivered: alice still holds UP, and her storage still pays for it.
    ctx("alice.testnet", T0, 0);
    let _ = b.withdraw(Asset::Usdc, U128(10 * ONE));
    assert_eq!(up(&b, "alice.testnet"), 5 * ONE);
    let s = b.storage_balance_of(acc("alice.testnet")).unwrap();
    let charged = s.total.as_yoctonear() - s.available.as_yoctonear();
    let one_entry =
        (REGISTRATION_BYTES + ORDER_ENTRY_BYTES) as u128 * env::storage_byte_cost().as_yoctonear();
    assert_eq!(charged, one_entry);
    ctx("alice.testnet", T0, 1);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| b.storage_unregister(None))).is_err());
}
