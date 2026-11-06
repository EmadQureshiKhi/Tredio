use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::Base64VecU8;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId};

use super::*;

const T0: u64 = 1_800_000_000;

fn key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}

fn pk_string(k: &SigningKey) -> String {
    format!("ed25519:{}", bs58::encode(k.verifying_key().as_bytes()).into_string())
}

fn params() -> Params {
    Params {
        staleness_limit: 600,
        max_move_bps: 5_000,
        attention_floor: 5_000_000,
        cooling_window: 1_800,
        retire_window: 3_600,
        stale_retire_window: 7_200,
        settlement_tolerance: 600,
        max_report_age: 300,
        max_future_skew: 60,
    }
}

fn at(secs: u64, predecessor: &str) {
    testing_env!(VMContextBuilder::new()
        .block_timestamp(secs * 1_000_000_000)
        .predecessor_account_id(predecessor.parse().unwrap())
        .build());
}

/// The owner signing with a full-access key: owner setters require one attached yoctoNEAR.
fn as_owner(secs: u64) {
    testing_env!(VMContextBuilder::new()
        .block_timestamp(secs * 1_000_000_000)
        .predecessor_account_id("owner.testnet".parse().unwrap())
        .attached_deposit(near_sdk::NearToken::from_yoctonear(1))
        .build());
}

fn setup() -> Registry {
    at(T0, "owner.testnet");
    let mut r = Registry::new(
        "owner.testnet".parse().unwrap(),
        OracleConfig::TeeSigner { public_key: pk_string(&key()) },
        params(),
    );
    as_owner(T0);
    r.add_consumer("outcomes.testnet".parse().unwrap());
    r
}

fn submit(r: &mut Registry, json: &str) {
    let sig = key().sign(&near_sdk::env::sha256(json.as_bytes()));
    r.submit_report(json.to_string(), Base64VecU8(sig.to_bytes().to_vec()));
}

fn create(r: &mut Registry, run: u64, observed: u64, id: &str, index: u64) {
    submit(
        r,
        &format!(
            r#"{{"run_id":{run},"observed_at":{observed},"new_trends":[{{"identifier":"{id}","asset_class":"topic","index":{index},"surfacer":"alice.testnet","smart_money_confirmed":false,"review_hash":null,"asset":null}}]}}"#
        ),
    );
}

fn update(r: &mut Registry, run: u64, observed: u64, id: &str, index: u64) {
    submit(
        r,
        &format!(
            r#"{{"run_id":{run},"observed_at":{observed},"updates":[{{"id":"{id}","index":{index}}}]}}"#
        ),
    );
}

#[test]
fn creates_and_updates_with_a_valid_signature() {
    let mut r = setup();
    create(&mut r, 1, T0, "topic:openai", 40_000_000);
    let t = r.get_trend("topic:openai".into()).unwrap();
    assert_eq!(t.trend.index, 40_000_000);
    assert_eq!(t.trend.surfacer, Some("alice.testnet".parse::<AccountId>().unwrap()));
    assert!(t.fresh);
    assert!(get_logs().iter().any(|l| l.contains("\"trend_created\"") && l.contains("tredio-registry")));

    at(T0 + 60, "anyone.testnet");
    update(&mut r, 2, T0 + 60, "topic:openai", 45_000_000);
    let s = r.index_of("topic:openai".into()).unwrap();
    assert_eq!((s.index, s.peak_index, s.updated_at), (45_000_000, 45_000_000, T0 + 60));
    assert_eq!(r.history("topic:openai".into()).len(), 2);
}

#[test]
#[should_panic(expected = "signature does not verify")]
fn rejects_a_forged_report() {
    let mut r = setup();
    let json = r#"{"run_id":1,"observed_at":1800000000}"#;
    let other = SigningKey::from_bytes(&[9u8; 32]);
    let sig = other.sign(&near_sdk::env::sha256(json.as_bytes()));
    r.submit_report(json.to_string(), Base64VecU8(sig.to_bytes().to_vec()));
}

#[test]
#[should_panic(expected = "signature does not verify")]
fn rejects_a_tampered_report() {
    let mut r = setup();
    let json = r#"{"run_id":1,"observed_at":1800000000}"#;
    let sig = key().sign(&near_sdk::env::sha256(json.as_bytes()));
    r.submit_report(json.replace("1800000000", "1800000001"), Base64VecU8(sig.to_bytes().to_vec()));
}

#[test]
#[should_panic(expected = "stale run")]
fn rejects_a_replayed_run() {
    let mut r = setup();
    create(&mut r, 5, T0, "topic:a", 40_000_000);
    update(&mut r, 5, T0, "topic:a", 41_000_000);
}

#[test]
#[should_panic(expected = "bad observation time")]
fn rejects_an_old_report() {
    let mut r = setup();
    at(T0 + 1_000, "x.testnet");
    create(&mut r, 1, T0, "topic:a", 40_000_000);
}

#[test]
fn skips_bad_items_without_blocking_the_rest() {
    let mut r = setup();
    submit(
        &mut r,
        &format!(
            r#"{{"run_id":1,"observed_at":{T0},"new_trends":[
                {{"identifier":"Bad Id","asset_class":"topic","index":40000000,"surfacer":null,"smart_money_confirmed":false,"review_hash":null,"asset":null}},
                {{"identifier":"crypto:btc","asset_class":"crypto","index":40000000,"surfacer":null,"smart_money_confirmed":false,"review_hash":null,"asset":"BTC"}},
                {{"identifier":"crypto:eth","asset_class":"crypto","index":40000000,"surfacer":null,"smart_money_confirmed":true,"review_hash":"{}","asset":"ETH"}},
                {{"identifier":"topic:x","asset_class":"topic","index":1,"surfacer":null,"smart_money_confirmed":false,"review_hash":null,"asset":null}},
                {{"identifier":"topic:y","asset_class":"topic","index":40000000,"surfacer":null,"smart_money_confirmed":false,"review_hash":"zz","asset":null}}
            ],"updates":[{{"id":"topic:none","index":40000000}}],"marks":[{{"asset":"BTC","price":"10123400000000"}},{{"asset":"","price":"1"}}]}}"#,
            "ab".repeat(32)
        ),
    );
    assert!(r.get_trend("crypto:eth".into()).is_some());
    assert_eq!(r.trend_count(), 1);
    assert_eq!(r.mark_of("BTC".into()).unwrap().price, U128(10_123_400_000_000));
    let logs = get_logs().join("\n");
    for reason in [
        "bad_identifier",
        "no_smart_money_confirmation",
        "index_out_of_bounds",
        "bad_review_hash",
        "unknown_trend",
        "bad_mark",
    ] {
        assert!(logs.contains(reason), "missing {reason}");
    }
    assert!(logs.contains(r#""created":1"#) && logs.contains(r#""rejected":6"#), "{logs}");
}

#[test]
fn clamps_large_moves() {
    assert_eq!(clamp_move(40_000_000, 100_000_000, 5_000), 60_000_000);
    assert_eq!(clamp_move(40_000_000, 1_000_000, 5_000), 20_000_000);
    assert_eq!(clamp_move(15_000, 1, 9_000), MIN_INDEX);
    assert_eq!(clamp_move(40_000_000, 50_000_000, 5_000), 50_000_000);
    let mut r = setup();
    create(&mut r, 1, T0, "topic:a", 40_000_000);
    at(T0 + 30, "x.testnet");
    update(&mut r, 2, T0 + 30, "topic:a", 90_000_000);
    assert_eq!(r.index_of("topic:a".into()).unwrap().index, 60_000_000);
    assert!(get_logs().iter().any(|l| l.contains("index_clamped")));
}

#[test]
fn rejects_out_of_order_observations() {
    let mut r = setup();
    create(&mut r, 1, T0, "topic:a", 40_000_000);
    update(&mut r, 2, T0, "topic:a", 41_000_000);
    assert_eq!(r.index_of("topic:a".into()).unwrap().index, 40_000_000);
    assert!(get_logs().iter().any(|l| l.contains("not_newer")));
}

#[test]
fn settles_on_the_first_observation_after_expiry() {
    let mut r = setup();
    create(&mut r, 1, T0, "topic:a", 40_000_000);
    at(T0 + 10, "outcomes.testnet");
    let snap = r.register_expiry("topic:a".into(), T0 + 100);
    assert_eq!(snap.index, 40_000_000);
    assert_eq!(r.pending_expiries("topic:a".into()), vec![T0 + 100]);
    at(T0 + 90, "x.testnet");
    update(&mut r, 2, T0 + 90, "topic:a", 41_000_000);
    assert!(!r.settlement_of("topic:a".into(), T0 + 100).finalized);
    at(T0 + 150, "x.testnet");
    update(&mut r, 3, T0 + 150, "topic:a", 43_000_000);
    assert_eq!(
        r.settlement_of("topic:a".into(), T0 + 100),
        Settlement { finalized: true, value: 43_000_000 }
    );
    assert!(r.pending_expiries("topic:a".into()).is_empty());
    // Later observations never change it.
    at(T0 + 200, "x.testnet");
    update(&mut r, 4, T0 + 200, "topic:a", 20_000_000);
    assert_eq!(r.settlement_of("topic:a".into(), T0 + 100).value, 43_000_000);
}

#[test]
fn misses_a_settlement_after_an_outage() {
    let mut r = setup();
    create(&mut r, 1, T0, "topic:a", 40_000_000);
    at(T0 + 10, "outcomes.testnet");
    r.register_expiry("topic:a".into(), T0 + 100);
    at(T0 + 1_000, "x.testnet");
    update(&mut r, 2, T0 + 1_000, "topic:a", 41_000_000);
    assert!(!r.settlement_of("topic:a".into(), T0 + 100).finalized);
    assert!(get_logs().iter().any(|l| l.contains("settlement_missed")));
}

#[test]
#[should_panic(expected = "consumer only")]
fn only_consumers_register_expiries() {
    let mut r = setup();
    create(&mut r, 1, T0, "topic:a", 40_000_000);
    at(T0 + 10, "mallory.testnet");
    r.register_expiry("topic:a".into(), T0 + 100);
}

#[test]
fn cools_recovers_and_retires() {
    let mut r = setup();
    create(&mut r, 1, T0, "topic:a", 4_000_000);
    at(T0 + 1_800, "x.testnet");
    update(&mut r, 2, T0 + 1_800, "topic:a", 4_000_000);
    assert_eq!(r.index_of("topic:a".into()).unwrap().status, Status::Cooling);
    at(T0 + 1_900, "x.testnet");
    update(&mut r, 3, T0 + 1_900, "topic:a", 6_000_000);
    assert_eq!(r.index_of("topic:a".into()).unwrap().status, Status::Active);
    at(T0 + 2_000, "x.testnet");
    update(&mut r, 4, T0 + 2_000, "topic:a", 4_000_000);
    at(T0 + 3_800, "x.testnet");
    update(&mut r, 5, T0 + 3_800, "topic:a", 4_000_000);
    assert_eq!(r.index_of("topic:a".into()).unwrap().status, Status::Cooling);
    at(T0 + 7_400, "x.testnet");
    update(&mut r, 6, T0 + 7_400, "topic:a", 4_000_000);
    let s = r.index_of("topic:a".into()).unwrap();
    assert_eq!(s.status, Status::Retired);
    assert_eq!(s.retired_at, Some(T0 + 7_400));
    // A retired trend settles any later expiry at its final index.
    assert_eq!(
        r.settlement_of("topic:a".into(), T0 + 9_000),
        Settlement { finalized: true, value: 4_000_000 }
    );
}

#[test]
fn retires_a_stale_trend_on_poke() {
    let mut r = setup();
    create(&mut r, 1, T0, "topic:a", 40_000_000);
    at(T0 + 7_200, "keeper.testnet");
    r.poke_lifecycle("topic:a".into());
    assert_eq!(r.index_of("topic:a".into()).unwrap().status, Status::Retired);
}

#[test]
#[should_panic(expected = "nothing to poke")]
fn poke_needs_a_reason() {
    let mut r = setup();
    create(&mut r, 1, T0, "topic:a", 40_000_000);
    at(T0 + 100, "keeper.testnet");
    r.poke_lifecycle("topic:a".into());
}

#[test]
fn fair_up_reads_the_latest_index() {
    let mut r = setup();
    create(&mut r, 1, T0, "topic:a", 50_000_000);
    let p = r.fair_up("topic:a".into(), 50_000_000, T0 + 86_400).0;
    assert!((490_000..=510_000).contains(&p), "{p}");
    assert_eq!(r.fair_up("topic:a".into(), 40_000_000, T0).0, 980_000);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn rotating_the_oracle_needs_a_full_access_key() {
    let mut r = setup();
    // The owner account, but through a function-call key, which cannot attach the yoctoNEAR.
    at(T0, "owner.testnet");
    r.set_oracle(OracleConfig::TeeSigner { public_key: pk_string(&SigningKey::from_bytes(&[1u8; 32])) });
}

#[test]
#[should_panic(expected = "owner only")]
fn only_the_owner_rotates_the_oracle() {
    let mut r = setup();
    at(T0, "mallory.testnet");
    r.set_oracle(OracleConfig::TeeSigner { public_key: pk_string(&SigningKey::from_bytes(&[1u8; 32])) });
}

#[test]
fn keeps_a_bounded_history() {
    let mut r = setup();
    create(&mut r, 1, T0, "topic:a", 40_000_000);
    for i in 1..=(HISTORY_LEN as u64 + 10) {
        at(T0 + i, "x.testnet");
        update(&mut r, 1 + i, T0 + i, "topic:a", 40_000_000 + i);
    }
    let h = r.history("topic:a".into());
    assert_eq!(h.len(), HISTORY_LEN);
    assert_eq!(h.last().unwrap().at, T0 + HISTORY_LEN as u64 + 10);
}

#[test]
fn marks_carry_their_hyperliquid_asset_index() {
    let mut r = setup();
    submit(
        &mut r,
        &format!(
            r#"{{"run_id":1,"observed_at":{T0},"marks":[{{"asset":"BTC","price":"6500000000000","asset_index":0}},{{"asset":"ETH","price":"300000000000"}}]}}"#
        ),
    );
    let btc = r.mark_of("BTC".into()).unwrap();
    assert_eq!((btc.price, btc.at, btc.asset_index), (U128(6_500_000_000_000), T0, Some(0)));
    // A mark reported without an index has none, so account guards refuse orders against it.
    assert_eq!(r.mark_of("ETH".into()).unwrap().asset_index, None);
    // Later marks keep the index unless the oracle reports a new one.
    at(T0 + 1, "relayer.testnet");
    submit(
        &mut r,
        &format!(
            r#"{{"run_id":2,"observed_at":{},"marks":[{{"asset":"BTC","price":"6600000000000"}}]}}"#,
            T0 + 1
        ),
    );
    assert_eq!(r.mark_of("BTC".into()).unwrap().asset_index, Some(0));
    assert!(get_logs().iter().all(|l| !l.contains("asset_index_set")));
}
