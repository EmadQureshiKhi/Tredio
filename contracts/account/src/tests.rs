use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId, PublicKey};
use p256::ecdsa::signature::hazmat::PrehashSigner;
use p256::ecdsa::{Signature, SigningKey};
use sha2::{Digest, Sha256};
use tredio_common::account_state::{Protocol, Scope};

use super::*;

const T0: u64 = 1_800_000_000;
const ME: &str = "0u7f3a9c.testnet";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn passkey() -> SigningKey {
    SigningKey::from_bytes(&[42u8; 32].into()).unwrap()
}

fn owner_key_hex(k: &SigningKey) -> String {
    hex::encode(k.verifying_key().to_encoded_point(true).as_bytes())
}

fn session_pk() -> PublicKey {
    "ed25519:DcA2MzgpJbrUATQLLceocVckhhAqrkingax4oJ9kZ847".parse().unwrap()
}

fn protocol() -> Protocol {
    Protocol {
        usdc: acc("usdc.testnet"),
        registry: acc("registry.testnet"),
        outcomes: acc("outcomes.testnet"),
        book: acc("book.testnet"),
        perps: acc("perps.testnet"),
        coins: acc("coins.testnet"),
        curation: acc("curation.testnet"),
        signer: acc("v1.signer-prod.testnet"),
        factory: acc("accounts.testnet"),
    }
}

fn ctx(predecessor: &str, signer_pk: Option<PublicKey>, secs: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ME))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .block_timestamp(secs * 1_000_000_000)
        .account_balance(NearToken::from_near(5));
    if let Some(pk) = signer_pk {
        b.signer_account_pk(pk);
    }
    testing_env!(b.build());
}

fn setup() -> Account {
    ctx("accounts.testnet", None, T0);
    Account::new(owner_key_hex(&passkey()), "testnet".into(), protocol())
}

/// A WebAuthn assertion over `request`, as a browser would produce it.
fn prove(request: &str, key: &SigningKey) -> Proof {
    let challenge = URL_SAFE_NO_PAD.encode(request_hash(request));
    let client =
        format!(r#"{{"type":"webauthn.get","challenge":"{challenge}","origin":"https://app.tredio.bid"}}"#);
    let mut auth = Sha256::digest(b"tredio.bid").to_vec();
    auth.push(0x05);
    auth.extend_from_slice(&[0, 0, 0, 1]);
    let mut msg = auth.clone();
    msg.extend_from_slice(&Sha256::digest(client.as_bytes()));
    let sig: Signature = key.sign_prehash(&Sha256::digest(&msg)).unwrap();
    Proof {
        authenticator_data: URL_SAFE_NO_PAD.encode(&auth),
        client_data_json: client,
        signature: hex::encode(sig.to_bytes()),
    }
}

fn request(nonce: u64, created_at: u64, actions: &str) -> String {
    format!(
        r#"{{"account":"{ME}","network":"testnet","nonce":{nonce},"created_at":{created_at},"actions":{actions}}}"#
    )
}

fn add_session_action(expires_at: u64, limit: u128, scope: &str) -> String {
    format!(
        r#"[{{"add_session":{{"public_key":"{}","label":"web","scope":{scope},"expires_at":{expires_at},"daily_limit":"{limit}","gas_key":true,"gas_funding":"100000000000000000000000"}}}}]"#,
        String::from(&session_pk())
    )
}

fn with_session(limit: u128) -> Account {
    let mut a = setup();
    let r = request(
        1,
        T0,
        &add_session_action(T0 + 7 * 86_400, limit, r#"{"outcomes":true,"perps":true,"hyperliquid":true}"#),
    );
    ctx("relayer.testnet", None, T0);
    assert!(a.owner_execute(r.clone(), prove(&r, &passkey())).is_some());
    a
}

#[test]
fn the_passkey_adds_a_gas_key_session() {
    let a = with_session(500_000_000);
    let s = a.session(session_pk()).unwrap();
    assert_eq!(s.daily_limit.0, 500_000_000);
    assert!(s.gas_key);
    assert!(get_logs().iter().any(|l| l.contains("session_added")));
    assert!(a.nonce_used(1));
}

#[test]
#[should_panic(expected = "passkey signature does not verify")]
fn another_passkey_is_refused() {
    let mut a = setup();
    let r = request(1, T0, "[{\"freeze\":{\"frozen\":true}}]");
    let other = SigningKey::from_bytes(&[7u8; 32].into()).unwrap();
    ctx("relayer.testnet", None, T0);
    let _ = a.owner_execute(r.clone(), prove(&r, &other));
}

#[test]
#[should_panic(expected = "passkey signature does not verify")]
fn a_tampered_request_is_refused() {
    let mut a = setup();
    let r = request(1, T0, "[{\"freeze\":{\"frozen\":true}}]");
    let proof = prove(&r, &passkey());
    ctx("relayer.testnet", None, T0);
    let _ = a.owner_execute(r.replace("true", "false"), proof);
}

#[test]
#[should_panic(expected = "nonce already used")]
fn requests_do_not_replay() {
    let mut a = setup();
    let r = request(9, T0, "[{\"freeze\":{\"frozen\":true}}]");
    ctx("relayer.testnet", None, T0);
    let _ = a.owner_execute(r.clone(), prove(&r, &passkey()));
    let _ = a.owner_execute(r.clone(), prove(&r, &passkey()));
}

#[test]
#[should_panic(expected = "request expired or from the future")]
fn old_requests_expire() {
    let mut a = setup();
    let r = request(9, T0, "[{\"freeze\":{\"frozen\":true}}]");
    ctx("relayer.testnet", None, T0 + 3_600);
    let _ = a.owner_execute(r.clone(), prove(&r, &passkey()));
}

#[test]
#[should_panic(expected = "request is for another network")]
fn requests_are_bound_to_the_network() {
    let mut a = setup();
    let r = request(9, T0, "[{\"freeze\":{\"frozen\":true}}]").replace("\"testnet\"", "\"mainnet\"");
    ctx("relayer.testnet", None, T0);
    let _ = a.owner_execute(r.clone(), prove(&r, &passkey()));
}

#[test]
#[should_panic(expected = "request is for another account")]
fn requests_are_bound_to_the_account() {
    let mut a = setup();
    let r = request(9, T0, "[{\"freeze\":{\"frozen\":true}}]").replace(ME, "0uother.testnet");
    ctx("relayer.testnet", None, T0);
    let _ = a.owner_execute(r.clone(), prove(&r, &passkey()));
}

#[test]
fn sessions_trade_within_scope_and_limit() {
    let mut a = with_session(100_000_000);
    ctx(ME, Some(session_pk()), T0 + 60);
    let _ = a.session_call(SessionAction::Swap {
        series: 1,
        side: Side::Up,
        buy: true,
        amount: U128(60_000_000),
        min_out: U128(1),
    });
    let _ = a.session_call(SessionAction::Swap {
        series: 1,
        side: Side::Up,
        buy: false,
        amount: U128(10_000_000),
        min_out: U128(1),
    });
    assert_eq!(a.session(session_pk()).unwrap().spent.0, 60_000_000);
    // Inflows never offset: a sale does not free room.
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = a.session_call(SessionAction::PerpOpen {
            trend: "topic:a".into(),
            is_long: true,
            margin: U128(50_000_000),
            leverage_bps: 20_000,
            acceptable_index: u64::MAX,
        });
    }));
    assert!(r.is_err(), "over the daily limit");
}

#[test]
fn the_limit_resets_each_utc_day() {
    let mut a = with_session(100_000_000);
    ctx(ME, Some(session_pk()), T0 + 60);
    let _ = a.session_call(SessionAction::MintSets { series: 1, amount: U128(90_000_000) });
    ctx(ME, Some(session_pk()), T0 + 86_400);
    let _ = a.session_call(SessionAction::MintSets { series: 1, amount: U128(90_000_000) });
    assert_eq!(a.session(session_pk()).unwrap().spent.0, 90_000_000);
}

#[test]
#[should_panic(expected = "session keys only")]
fn sessions_must_be_signed_by_the_account() {
    let mut a = with_session(100);
    ctx("mallory.testnet", Some(session_pk()), T0);
    let _ = a.session_call(SessionAction::Faucet);
}

#[test]
#[should_panic(expected = "not a session key")]
fn unknown_keys_are_refused() {
    let mut a = with_session(100);
    let other: PublicKey = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap();
    ctx(ME, Some(other), T0);
    let _ = a.session_call(SessionAction::Faucet);
}

#[test]
#[should_panic(expected = "session expired")]
fn sessions_expire() {
    let mut a = with_session(100);
    ctx(ME, Some(session_pk()), T0 + 8 * 86_400);
    let _ = a.session_call(SessionAction::Faucet);
}

#[test]
#[should_panic(expected = "action outside the session scope")]
fn scope_is_enforced() {
    let mut a = setup();
    let r = request(
        1,
        T0,
        &add_session_action(T0 + 86_400, 100, r#"{"outcomes":true,"perps":false,"hyperliquid":false}"#),
    );
    ctx("relayer.testnet", None, T0);
    let _ = a.owner_execute(r.clone(), prove(&r, &passkey()));
    ctx(ME, Some(session_pk()), T0 + 1);
    let _ = a.session_call(SessionAction::PerpClose { id: 1, acceptable_index: 0 });
}

#[test]
#[should_panic(expected = "sessions are frozen")]
fn freezing_stops_sessions() {
    let mut a = with_session(100);
    let r = request(2, T0, "[{\"freeze\":{\"frozen\":true}}]");
    ctx("relayer.testnet", None, T0);
    let _ = a.owner_execute(r.clone(), prove(&r, &passkey()));
    ctx(ME, Some(session_pk()), T0 + 1);
    let _ = a.session_call(SessionAction::Faucet);
}

#[test]
fn the_hyperliquid_guard_accepts_orders_near_the_mark() {
    let mut a = with_session(100);
    let order = hyperliquid::HlOrder {
        asset: "BTC".into(),
        asset_index: 0,
        is_buy: true,
        price: "65500".into(),
        size: "0.01".into(),
        reduce_only: false,
        tif: "Ioc".into(),
    };
    ctx(ME, None, T0 + 30);
    let _ = a.on_hl_mark(order, 1, Ok(Some(Mark { price: U128(6_500_000_000_000), at: T0 })));
    assert!(get_logs().iter().any(|l| l.contains("hyperliquid_signed")));
}

#[test]
#[should_panic(expected = "price outside 2% of the mark")]
fn the_hyperliquid_guard_rejects_far_prices() {
    let mut a = with_session(100);
    let order = hyperliquid::HlOrder {
        asset: "BTC".into(),
        asset_index: 0,
        is_buy: false,
        price: "60000".into(),
        size: "0.01".into(),
        reduce_only: false,
        tif: "Ioc".into(),
    };
    ctx(ME, None, T0 + 30);
    let _ = a.on_hl_mark(order, 1, Ok(Some(Mark { price: U128(6_500_000_000_000), at: T0 })));
}

#[test]
#[should_panic(expected = "stale mark")]
fn the_hyperliquid_guard_needs_a_fresh_mark() {
    let mut a = with_session(100);
    let order = hyperliquid::HlOrder {
        asset: "BTC".into(),
        asset_index: 0,
        is_buy: true,
        price: "65000".into(),
        size: "0.01".into(),
        reduce_only: false,
        tif: "Ioc".into(),
    };
    ctx(ME, None, T0 + 600);
    let _ = a.on_hl_mark(order, 1, Ok(Some(Mark { price: U128(6_500_000_000_000), at: T0 })));
}

#[test]
#[should_panic(expected = "leverage above 10x")]
fn sessions_cannot_raise_leverage_past_10x() {
    let mut a = with_session(100);
    ctx(ME, Some(session_pk()), T0 + 1);
    let _ =
        a.session_call(SessionAction::HlLeverage { asset_index: 0, is_cross: false, leverage: 20, nonce: 1 });
}

#[test]
fn signatures_become_evm_signatures() {
    let sig = Account::on_signed(Ok(SignatureResponse {
        scheme: "Secp256k1".into(),
        big_r: AffinePoint { affine_point: format!("02{}", "ab".repeat(32)) },
        s: Scalar { scalar: "cd".repeat(32) },
        recovery_id: 1,
    }));
    assert_eq!(sig, EvmSignature { r: "ab".repeat(32), s: "cd".repeat(32), v: 28 });
}

#[test]
fn rejects_malformed_owner_keys() {
    let r = std::panic::catch_unwind(|| parse_p256_key("00"));
    assert!(r.is_err());
    assert_eq!(parse_p256_key(&owner_key_hex(&passkey())).len(), 33);
}

#[test]
fn only_one_scope_is_needed() {
    let s = Scope { outcomes: true, ..Default::default() };
    assert!(s.outcomes && !s.perps && !s.hyperliquid);
}
