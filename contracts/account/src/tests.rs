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
fn an_assertion_without_user_verification_is_refused() {
    let mut a = setup();
    let r = request(1, T0, "[{\"freeze\":{\"frozen\":true}}]");
    // The same key signs, but the authenticator reports presence only (flags 0x01, no UV bit).
    let challenge = URL_SAFE_NO_PAD.encode(request_hash(&r));
    let client =
        format!(r#"{{"type":"webauthn.get","challenge":"{challenge}","origin":"https://app.tredio.bid"}}"#);
    let mut auth = Sha256::digest(b"tredio.bid").to_vec();
    auth.push(0x01);
    auth.extend_from_slice(&[0, 0, 0, 1]);
    let mut msg = auth.clone();
    msg.extend_from_slice(&Sha256::digest(client.as_bytes()));
    let sig: Signature = passkey().sign_prehash(&Sha256::digest(&msg)).unwrap();
    let proof = Proof {
        authenticator_data: URL_SAFE_NO_PAD.encode(&auth),
        client_data_json: client,
        signature: hex::encode(sig.to_bytes()),
    };
    ctx("relayer.testnet", None, T0);
    let _ = a.owner_execute(r, proof);
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

/// The implicit account of `pk`: its 32 key bytes as 64 hex characters, as custody enclaves sign.
fn implicit_of(pk: &PublicKey) -> String {
    hex::encode(&pk.as_bytes()[1..])
}

/// A context where `predecessor` called directly, signed by `signer` with `pk`.
fn ctx_signed(predecessor: &str, signer: &str, pk: PublicKey, secs: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc(ME))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(signer))
        .signer_account_pk(pk)
        .block_timestamp(secs * 1_000_000_000)
        .account_balance(NearToken::from_near(5))
        .build());
}

/// An account with a plain-key (not gas key) Hyperliquid session for a policy wallet's key, as a grant adds it.
fn with_wallet_session(limit: u128) -> Account {
    let mut a = setup();
    let actions = format!(
        r#"[{{"add_session":{{"public_key":"{}","label":"autopilot","scope":{{"outcomes":false,"perps":false,"hyperliquid":true}},"expires_at":{},"daily_limit":"{limit}","gas_key":false,"gas_funding":"0"}}}}]"#,
        String::from(&session_pk()),
        T0 + 7 * 86_400
    );
    let r = request(1, T0, &actions);
    ctx("relayer.testnet", None, T0);
    assert!(a.owner_execute(r.clone(), prove(&r, &passkey())).is_some());
    a
}

#[test]
fn a_policy_wallet_acts_for_its_session_as_its_own_implicit_account() {
    let mut a = with_wallet_session(100_000_000);
    let wallet = implicit_of(&session_pk());
    assert_eq!(wallet.len(), 64);
    ctx_signed(&wallet, &wallet, session_pk(), T0 + 60);
    let _ =
        a.session_call(SessionAction::HlLeverage { asset_index: 0, is_cross: false, leverage: 3, nonce: 1 });
    assert!(get_logs().iter().any(|l| l.contains("session_action")));
    // The session still bounds it: an action outside its Hyperliquid scope is refused.
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = a.session_call(SessionAction::MintSets { series: 1, amount: U128(1) });
    }));
    assert!(r.is_err(), "outcomes are outside a Hyperliquid-only session");
}

#[test]
#[should_panic(expected = "session keys only")]
fn a_contract_cannot_relay_a_wallet_call() {
    let mut a = with_wallet_session(100);
    let wallet = implicit_of(&session_pk());
    // The wallet's key signed, but the call reaches the account through another contract.
    ctx_signed("relay.testnet", &wallet, session_pk(), T0);
    let _ = a.session_call(SessionAction::Faucet);
}

#[test]
#[should_panic(expected = "session keys only")]
fn an_implicit_account_must_be_the_session_keys_own() {
    let mut a = with_wallet_session(100);
    let other: PublicKey = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap();
    let theirs = implicit_of(&other);
    // Another implicit account signing with the session's key would need that key on its account.
    ctx_signed(&theirs, &theirs, session_pk(), T0);
    let _ = a.session_call(SessionAction::Faucet);
}

#[test]
#[should_panic(expected = "not a session key")]
fn an_implicit_account_without_a_session_is_refused() {
    let mut a = with_wallet_session(100);
    let other: PublicKey = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap();
    let theirs = implicit_of(&other);
    ctx_signed(&theirs, &theirs, other, T0);
    let _ = a.session_call(SessionAction::Faucet);
}

#[test]
#[should_panic(expected = "a gas key session signs as the account")]
fn a_gas_key_session_never_signs_from_its_implicit_account() {
    let mut a = with_session(100);
    let wallet = implicit_of(&session_pk());
    ctx_signed(&wallet, &wallet, session_pk(), T0);
    let _ = a.session_call(SessionAction::Faucet);
}

#[test]
#[should_panic(expected = "sessions are frozen")]
fn a_frozen_account_refuses_its_policy_wallet_too() {
    let mut a = with_wallet_session(100);
    let r = request(2, T0, "[{\"freeze\":{\"frozen\":true}}]");
    ctx("relayer.testnet", None, T0);
    let _ = a.owner_execute(r.clone(), prove(&r, &passkey()));
    let wallet = implicit_of(&session_pk());
    ctx_signed(&wallet, &wallet, session_pk(), T0 + 60);
    let _ =
        a.session_call(SessionAction::HlLeverage { asset_index: 0, is_cross: false, leverage: 3, nonce: 2 });
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
    let _ = a.on_hl_mark(
        order,
        1,
        Ok(Some(Mark { price: U128(6_500_000_000_000), at: T0, asset_index: Some(0) })),
    );
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
    let _ = a.on_hl_mark(
        order,
        1,
        Ok(Some(Mark { price: U128(6_500_000_000_000), at: T0, asset_index: Some(0) })),
    );
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
    let _ = a.on_hl_mark(
        order,
        1,
        Ok(Some(Mark { price: U128(6_500_000_000_000), at: T0, asset_index: Some(0) })),
    );
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

fn mark_json(price: u128, at: u64, asset_index: Option<u32>) -> Mark {
    let index = asset_index.map_or("null".to_string(), |i| i.to_string());
    near_sdk::serde_json::from_str(&format!(r#"{{"price":"{price}","at":{at},"asset_index":{index}}}"#))
        .unwrap()
}

#[test]
#[should_panic(expected = "mark is for another asset")]
fn the_hyperliquid_guard_binds_the_mark_to_the_signed_asset() {
    let mut a = with_session(100);
    // The mark is BTC's (asset 0), but the signed order is for asset 7.
    let order = hyperliquid::HlOrder {
        asset: "BTC".into(),
        asset_index: 7,
        is_buy: true,
        price: "65500".into(),
        size: "0.01".into(),
        reduce_only: false,
        tif: "Ioc".into(),
    };
    ctx(ME, None, T0 + 30);
    let _ = a.on_hl_mark(order, 1, Ok(Some(mark_json(6_500_000_000_000, T0, Some(0)))));
}

#[test]
#[should_panic(expected = "mark is for another asset")]
fn the_hyperliquid_guard_needs_the_marks_asset_index() {
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
    let _ = a.on_hl_mark(order, 1, Ok(Some(mark_json(6_500_000_000_000, T0, None))));
}

// ---------------------------------------------------------------------------------------------
// v2
// ---------------------------------------------------------------------------------------------

use near_sdk::mock::MockAction;

fn receipts() -> Vec<MockAction> {
    near_sdk::test_utils::get_created_receipts().into_iter().flat_map(|r| r.actions).collect()
}

fn run(a: &mut Account, nonce: u64, actions: &str) {
    let r = request(nonce, T0, actions);
    ctx("relayer.testnet", None, T0);
    drop(a.owner_execute(r.clone(), prove(&r, &passkey())));
}

fn revoke(public_key: &PublicKey, delete_key: bool) -> String {
    format!(
        r#"[{{"revoke_session":{{"public_key":"{}","delete_key":{delete_key}}}}}]"#,
        String::from(public_key)
    )
}

fn adds_a_key(actions: &[MockAction]) -> bool {
    actions.iter().any(|a| {
        matches!(a, MockAction::AddGasKeyWithFunctionCall { .. } | MockAction::AddKeyWithFunctionCall { .. })
    })
}

#[test]
fn a_new_session_key_is_checked_by_a_callback() {
    let mut a = setup();
    run(
        &mut a,
        1,
        &add_session_action(T0 + 86_400, 100, r#"{"outcomes":true,"perps":false,"hyperliquid":false}"#),
    );
    let actions = receipts();
    assert!(adds_a_key(&actions));
    assert!(actions.iter().any(|a| matches!(a, MockAction::FunctionCallWeight { method_name, .. } if method_name == b"on_session_key")));
}

#[test]
fn a_session_whose_key_was_not_added_is_dropped() {
    let mut a = with_session(100);
    let ctx_result = |r: near_sdk::PromiseResult| {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(acc(ME))
                .predecessor_account_id(acc(ME))
                .block_timestamp(T0 * 1_000_000_000)
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![r]
        )
    };
    ctx_result(near_sdk::PromiseResult::Successful(vec![]));
    assert!(a.on_session_key(session_pk(), T0));
    assert!(a.session(session_pk()).is_some());
    ctx_result(near_sdk::PromiseResult::Failed);
    assert!(!a.on_session_key(session_pk(), T0));
    assert!(a.session(session_pk()).is_none());
    assert!(get_logs().iter().any(|l| l.contains("session_key_failed")));
}

#[test]
fn renewing_a_session_keeps_its_key_and_todays_spending() {
    let mut a = with_session(100_000_000);
    ctx(ME, Some(session_pk()), T0 + 60);
    let _ = a.session_call(SessionAction::MintSets { series: 1, amount: U128(30_000_000) });
    let before = a.session(session_pk()).unwrap();
    run(
        &mut a,
        2,
        &add_session_action(
            T0 + 20 * 86_400,
            200_000_000,
            r#"{"outcomes":true,"perps":false,"hyperliquid":false}"#,
        ),
    );
    let actions = receipts();
    assert!(!adds_a_key(&actions), "renewal adds no key: {actions:?}");
    // The new funding goes into the existing gas key.
    assert!(actions.iter().any(|a| matches!(a, MockAction::TransferToGasKey { .. })));
    let s = a.session(session_pk()).unwrap();
    assert_eq!((s.expires_at, s.daily_limit.0, s.scope.perps), (T0 + 20 * 86_400, 200_000_000, false));
    assert_eq!(
        (s.created_at, s.spent, s.day, s.gas_key),
        (before.created_at, before.spent, before.day, true)
    );
}

#[test]
fn renewal_without_funding_sends_nothing() {
    let mut a = with_session(100);
    let actions =
        add_session_action(T0 + 86_400, 100, r#"{"outcomes":true,"perps":true,"hyperliquid":true}"#)
            .replace(r#""gas_funding":"100000000000000000000000""#, r#""gas_funding":"0""#);
    let r = request(2, T0, &actions);
    ctx("relayer.testnet", None, T0);
    assert!(a.owner_execute(r.clone(), prove(&r, &passkey())).is_none());
}

#[test]
#[should_panic(expected = "a session key cannot change type")]
fn renewal_cannot_change_the_key_type() {
    let mut a = with_session(100);
    let actions =
        add_session_action(T0 + 86_400, 100, r#"{"outcomes":true,"perps":true,"hyperliquid":true}"#)
            .replace(r#""gas_key":true"#, r#""gas_key":false"#);
    let r = request(2, T0, &actions);
    ctx("relayer.testnet", None, T0);
    let _ = a.owner_execute(r.clone(), prove(&r, &passkey()));
}

#[test]
fn revoking_a_gas_key_keeps_it_dormant_and_unable_to_act() {
    let mut a = with_session(100);
    run(&mut a, 2, &revoke(&session_pk(), false));
    assert!(!receipts().iter().any(|a| matches!(a, MockAction::DeleteKey { .. })), "the gas key is kept");
    assert!(a.session(session_pk()).is_none());
    assert_eq!(a.dormant_keys(), vec![session_pk()]);
    assert!(
        get_logs().iter().any(|l| l.contains("session_revoked"))
            && get_logs().iter().any(|l| l.contains("session_key_kept"))
    );
    ctx(ME, Some(session_pk()), T0 + 1);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = a.session_call(SessionAction::Faucet);
    }));
    assert!(r.is_err(), "a dormant key cannot call session_call");
    ctx(ME, Some(session_pk()), T0 + 1);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = a.session_call(SessionAction::TopUpGas { amount: U128(1) });
    }));
    assert!(r.is_err(), "nor top up its own gas");
}

#[test]
fn a_dormant_key_comes_back_with_its_balance() {
    let mut a = with_session(100);
    run(&mut a, 2, &revoke(&session_pk(), false));
    run(
        &mut a,
        3,
        &add_session_action(T0 + 86_400, 100, r#"{"outcomes":true,"perps":false,"hyperliquid":false}"#),
    );
    assert!(!adds_a_key(&receipts()), "the key is already on the account");
    assert!(a.dormant_keys().is_empty());
    let s = a.session(session_pk()).unwrap();
    assert_eq!((s.created_at, s.spent.0, s.gas_key), (T0, 0, true));
    ctx(ME, Some(session_pk()), T0 + 1);
    let _ = a.session_call(SessionAction::Faucet);
}

#[test]
#[should_panic(expected = "this key is a gas key")]
fn a_dormant_key_cannot_come_back_as_a_plain_key() {
    let mut a = with_session(100);
    run(&mut a, 2, &revoke(&session_pk(), false));
    let actions =
        add_session_action(T0 + 86_400, 100, r#"{"outcomes":true,"perps":false,"hyperliquid":false}"#)
            .replace(r#""gas_key":true"#, r#""gas_key":false"#);
    let r = request(3, T0, &actions);
    ctx("relayer.testnet", None, T0);
    let _ = a.owner_execute(r.clone(), prove(&r, &passkey()));
}

#[test]
fn delete_key_removes_a_session_key_or_a_dormant_one() {
    let mut a = with_session(100);
    run(&mut a, 2, &revoke(&session_pk(), true));
    assert!(receipts().iter().any(|a| matches!(a, MockAction::DeleteKey { .. })));
    assert!(a.session(session_pk()).is_none() && a.dormant_keys().is_empty());

    let mut a = with_session(100);
    run(&mut a, 2, &revoke(&session_pk(), false));
    run(&mut a, 3, &revoke(&session_pk(), true));
    assert!(receipts().iter().any(|a| matches!(a, MockAction::DeleteKey { .. })));
    assert!(a.dormant_keys().is_empty());
    assert!(get_logs().iter().any(|l| l.contains("session_key_deleted")));
}

#[test]
#[should_panic(expected = "unknown session")]
fn revoking_a_dormant_key_again_needs_delete_key() {
    let mut a = with_session(100);
    run(&mut a, 2, &revoke(&session_pk(), false));
    let r = request(3, T0, &revoke(&session_pk(), false));
    ctx("relayer.testnet", None, T0);
    let _ = a.owner_execute(r.clone(), prove(&r, &passkey()));
}

#[test]
fn plain_session_keys_are_deleted_on_revoke() {
    let mut a = setup();
    let actions =
        add_session_action(T0 + 86_400, 100, r#"{"outcomes":true,"perps":false,"hyperliquid":false}"#)
            .replace(r#""gas_key":true"#, r#""gas_key":false"#);
    run(&mut a, 1, &actions);
    run(&mut a, 2, &format!(r#"[{{"revoke_session":{{"public_key":"{}"}}}}]"#, String::from(&session_pk())));
    assert!(receipts().iter().any(|a| matches!(a, MockAction::DeleteKey { .. })));
    assert!(a.dormant_keys().is_empty());
}

#[test]
fn dormant_keys_count_toward_the_key_limit() {
    let mut a = setup();
    for i in 0..MAX_SESSIONS as u64 {
        let key: PublicKey =
            near_sdk::PublicKey::from_parts(near_sdk::CurveType::ED25519, vec![i as u8 + 1; 32]).unwrap();
        let add =
            add_session_action(T0 + 86_400, 100, r#"{"outcomes":true,"perps":false,"hyperliquid":false}"#)
                .replace(&String::from(&session_pk()), &String::from(&key));
        run(&mut a, 10 + 2 * i, &add);
        run(&mut a, 11 + 2 * i, &revoke(&key, false));
    }
    assert_eq!(a.dormant_keys().len(), MAX_SESSIONS as usize);
    let r = request(
        99,
        T0,
        &add_session_action(T0 + 86_400, 100, r#"{"outcomes":true,"perps":false,"hyperliquid":false}"#),
    );
    ctx("relayer.testnet", None, T0);
    let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = a.owner_execute(r.clone(), prove(&r, &passkey()));
    }));
    assert!(refused.is_err(), "too many keys on the account");
}

#[test]
fn sessions_top_up_their_own_gas_key_within_the_cap() {
    let mut a = with_session(100);
    ctx(ME, Some(session_pk()), T0 + 60);
    drop(a.session_call(SessionAction::TopUpGas {
        amount: U128(NearToken::from_millinear(300).as_yoctonear()),
    }));
    let moved = receipts().into_iter().find_map(|a| match a {
        MockAction::TransferToGasKey { public_key, deposit, .. } => Some((public_key, deposit)),
        _ => None,
    });
    let (to, amount) = moved.expect("a gas key transfer");
    assert_eq!(to.to_string(), String::from(&session_pk()));
    assert_eq!(amount, NearToken::from_millinear(300));
    assert_eq!(a.gas_top_up_of(session_pk()).0 .0, NearToken::from_millinear(300).as_yoctonear());
    // 0.3 + 0.3 is past the 0.5 NEAR daily cap.
    ctx(ME, Some(session_pk()), T0 + 61);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = a.session_call(SessionAction::TopUpGas {
            amount: U128(NearToken::from_millinear(300).as_yoctonear()),
        });
    }));
    assert!(r.is_err());
    // A new UTC day has a new cap.
    ctx(ME, Some(session_pk()), T0 + 86_400);
    drop(a.session_call(SessionAction::TopUpGas {
        amount: U128(NearToken::from_millinear(300).as_yoctonear()),
    }));
    assert_eq!(a.gas_top_up_of(session_pk()).0 .0, NearToken::from_millinear(300).as_yoctonear());
}

#[test]
#[should_panic(expected = "not enough NEAR on the account")]
fn a_top_up_leaves_the_account_its_reserve() {
    let mut a = with_session(100);
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ME))
        .predecessor_account_id(acc(ME))
        .signer_account_pk(session_pk())
        .block_timestamp((T0 + 60) * 1_000_000_000)
        .account_balance(NearToken::from_millinear(60));
    testing_env!(b.build());
    let _ = a
        .session_call(SessionAction::TopUpGas { amount: U128(NearToken::from_millinear(20).as_yoctonear()) });
}

#[test]
#[should_panic(expected = "not a gas key")]
fn only_gas_key_sessions_top_up() {
    let mut a = setup();
    let actions =
        add_session_action(T0 + 86_400, 100, r#"{"outcomes":true,"perps":false,"hyperliquid":false}"#)
            .replace(r#""gas_key":true"#, r#""gas_key":false"#);
    run(&mut a, 1, &actions);
    ctx(ME, Some(session_pk()), T0 + 60);
    let _ = a.session_call(SessionAction::TopUpGas { amount: U128(1) });
}

#[test]
fn token_calls_attach_a_small_static_gas_and_the_rest() {
    let mut a = with_session(100_000_000);
    ctx(ME, Some(session_pk()), T0 + 60);
    drop(a.session_call(SessionAction::MintSets { series: 1, amount: U128(1_000_000) }));
    let call = receipts().into_iter().find_map(|a| match a {
        MockAction::FunctionCallWeight { method_name, prepaid_gas, gas_weight, .. }
            if method_name == b"ft_transfer_call" =>
        {
            Some((prepaid_gas, gas_weight.0))
        }
        _ => None,
    });
    assert_eq!(call, Some((Gas::from_tgas(20), 1)));
}

#[test]
#[should_panic(expected = "attach at least 120 Tgas")]
fn underfunded_token_calls_fail_before_they_count() {
    let mut a = with_session(100_000_000);
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ME))
        .predecessor_account_id(acc(ME))
        .signer_account_pk(session_pk())
        .block_timestamp((T0 + 60) * 1_000_000_000)
        .prepaid_gas(Gas::from_tgas(110));
    testing_env!(b.build());
    let _ = a.session_call(SessionAction::MintSets { series: 1, amount: U128(1_000_000) });
}

#[test]
fn the_mark_may_be_five_minutes_old() {
    let order = || hyperliquid::HlOrder {
        asset: "BTC".into(),
        asset_index: 0,
        is_buy: true,
        price: "65000".into(),
        size: "0.01".into(),
        reduce_only: false,
        tif: "Ioc".into(),
    };
    let mut a = with_session(100);
    ctx(ME, None, T0 + 295);
    let _ = a.on_hl_mark(order(), 1, Ok(Some(mark_json(6_500_000_000_000, T0, Some(0)))));
    ctx(ME, None, T0 + 305);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = a.on_hl_mark(order(), 2, Ok(Some(mark_json(6_500_000_000_000, T0, Some(0)))));
    }));
    assert!(r.is_err(), "older than five minutes");
}

#[test]
fn bootstrap_runs_once_and_is_a_no_op_after() {
    let mut a = setup();
    a.bootstrap();
    assert!(a.bootstrapped());
    ctx("accounts.testnet", None, T0);
    a.bootstrap();
    assert!(receipts().is_empty(), "no second registration");
}

#[test]
fn v1_state_reads_as_v2_with_an_empty_extension() {
    // Exactly what the factory writes into a universal account (and v1 code keeps).
    setup();
    let mut core = AccountCore::new(parse_p256_key(&owner_key_hex(&passkey())), "testnet".into(), protocol());
    core.bootstrapped = true;
    core.sessions.insert(
        session_pk(),
        Session {
            label: "web".into(),
            scope: Scope { outcomes: true, ..Default::default() },
            created_at: T0,
            expires_at: T0 + 86_400,
            daily_limit: U128(5),
            spent: U128(1),
            day: T0 / 86_400,
            gas_key: true,
        },
    );
    core.sessions.flush();
    env::state_write(&core);
    let a: Account = env::state_read().expect("v1 state decodes as v2");
    assert!(a.bootstrapped());
    assert_eq!(a.session(session_pk()).unwrap().spent.0, 1);
    assert!(a.dormant_keys().is_empty());
    assert_eq!(a.version(), VERSION);
}
