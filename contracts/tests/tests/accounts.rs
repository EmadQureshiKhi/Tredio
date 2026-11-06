//! Universal accounts on a local sandbox node: creation through the factory, the passkey upgrade
//! from the v1 code testnet accounts run today, and v2 sessions on real gas keys.

mod common;

use anyhow::Result;
use common::*;
use near_workspaces::types::{KeyType, NearToken, SecretKey};
use serde_json::{json, Value};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const MILLINEAR: u128 = NEAR / 1_000;

async fn balance(s: &Stack, who: &near_workspaces::AccountId) -> Result<u128> {
    Ok(s.worker.view_account(who).await?.balance.as_yoctonear())
}

fn add_session(key: &SecretKey, expires_at: u64, gas_key: bool, gas_funding: u128) -> Value {
    json!({ "add_session": {
        "public_key": key.public_key(),
        "label": "web",
        "scope": { "outcomes": true, "perps": true, "hyperliquid": false },
        "expires_at": expires_at,
        "daily_limit": (100 * USDC).to_string(),
        "gas_key": gas_key,
        "gas_funding": gas_funding.to_string()
    } })
}

/// Creates the account of `pk` through the factory with `deposit`, adding `first` as the
/// first request's actions.
async fn create(s: &Stack, pk: &Passkey, deposit: u128, first: Value) -> Result<near_workspaces::AccountId> {
    let account: near_workspaces::AccountId =
        s.accounts.view("account_id_of").args_json(json!({ "owner_key": pk.public_hex() })).await?.json()?;
    let request = owner_request(&s.worker, &account, 1, first).await?;
    ok(s.root
        .call(s.accounts.id(), "create_account")
        .args_json(json!({ "owner_key": pk.public_hex(), "first_request": request, "first_proof": pk.prove(&request) }))
        .deposit(NearToken::from_yoctonear(deposit))
        .max_gas()
        .transact()
        .await?)
    .await?;
    Ok(account)
}

/// Runs a passkey request on `account`, relayed by bob.
async fn owner(
    s: &Stack,
    pk: &Passkey,
    account: &near_workspaces::AccountId,
    nonce: u64,
    actions: Value,
) -> Result<Done> {
    let request = owner_request(&s.worker, account, nonce, actions).await?;
    ok(s.bob
        .call(account, "owner_execute")
        .args_json(json!({ "request": request, "proof": pk.prove(&request) }))
        .max_gas()
        .transact()
        .await?)
    .await
}

#[tokio::test]
async fn a_failed_account_creation_refunds_the_caller() -> Result<()> {
    let s = Stack::new().await?;
    let pk = Passkey::new(51);
    let account: near_workspaces::AccountId =
        s.accounts.view("account_id_of").args_json(json!({ "owner_key": pk.public_hex() })).await?.json()?;
    let request = owner_request(&s.worker, &account, 1, json!([{ "freeze": { "frozen": false } }])).await?;
    // The proof signs another request, so the first request (and with it the whole batch) fails.
    let wrong = Passkey::new(51).prove(&request.replace("false", "true"));
    let before = balance(&s, s.alice.id()).await?;
    let r = s
        .alice
        .call(s.accounts.id(), "create_account")
        .args_json(json!({ "owner_key": pk.public_hex(), "first_request": request, "first_proof": wrong }))
        .deposit(NearToken::from_near(2))
        .max_gas()
        .transact()
        .await?;
    assert!(r.logs().iter().any(|l| l.contains("account_creation_failed")), "{:?}", r.logs());
    s.worker.fast_forward(3).await?;
    let lost = before - balance(&s, s.alice.id()).await?;
    assert!(lost < 50 * MILLINEAR, "the caller lost {lost} yoctoNEAR of its 2 NEAR deposit");
    Ok(())
}

#[tokio::test]
async fn a_first_request_that_fails_later_is_not_refunded() -> Result<()> {
    // The account exists and holds the deposit even though a call its first request made failed:
    // the factory must not pay the deposit back a second time.
    let s = Stack::new().await?;
    let pk = Passkey::new(53);
    let failing = json!([{ "call": {
        "receiver_id": s.usdc.id(), "method_name": "no_such_method", "args": "e30=", "deposit": "0", "gas": "10000000000000"
    } }]);
    let factory_before = balance(&s, s.accounts.id()).await?;
    let account = create(&s, &pk, 2 * NEAR, failing).await?;
    s.worker.fast_forward(3).await?;
    assert!(balance(&s, &account).await? > NEAR, "the account kept the deposit");
    let factory_after = balance(&s, s.accounts.id()).await?;
    assert!(
        factory_after + 10 * MILLINEAR >= factory_before,
        "the factory paid out {}",
        factory_before - factory_after
    );
    Ok(())
}

#[tokio::test]
async fn creating_an_existing_account_again_loses_nothing() -> Result<()> {
    let s = Stack::new().await?;
    let pk = Passkey::new(54);
    let first = SecretKey::from_seed(KeyType::ED25519, "first");
    let account = create(
        &s,
        &pk,
        500 * MILLINEAR,
        json!([add_session(&first, now(&s.worker).await? + 86_400, true, 300 * MILLINEAR)]),
    )
    .await?;
    let (account_before, payer_before) = (balance(&s, &account).await?, balance(&s, s.alice.id()).await?);
    let r = s
        .alice
        .call(s.accounts.id(), "create_account")
        .args_json(json!({ "owner_key": pk.public_hex(), "first_request": null, "first_proof": null }))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?;
    eprintln!("second create_account logs: {:?}", r.logs());
    s.worker.fast_forward(3).await?;
    let topped_up = balance(&s, &account).await? >= account_before + NEAR - MILLINEAR;
    let refunded = payer_before - balance(&s, s.alice.id()).await? < 50 * MILLINEAR;
    assert!(
        topped_up ^ refunded,
        "the NEAR went to the account (topped up: {topped_up}) or back to the payer (refunded: {refunded})"
    );
    Ok(())
}

/// A v1 account (the exact code testnet accounts run) with a funded gas-key session, 80 USDC
/// of complete sets and the rest of the faucet's USDC.
struct V1Account {
    s: Stack,
    pk: Passkey,
    account: near_workspaces::AccountId,
    key: SecretKey,
    series: u64,
}

async fn v1_account() -> Result<V1Account> {
    let v1 = account_v1_wasm();
    assert_eq!(code_hash(&v1), ACCOUNT_V1_HASH, "the fixture is the deployed v1 code");
    let s = Stack::with_account_code(&v1).await?;
    let pk = Passkey::new(61);
    let key = SecretKey::from_seed(KeyType::ED25519, "browser");
    let account = create(
        &s,
        &pk,
        1_500 * MILLINEAR,
        json!([add_session(&key, now(&s.worker).await? + 7 * 86_400, true, 400 * MILLINEAR)]),
    )
    .await?;
    let (balance, receiver, methods) =
        gas_key::info(&s.worker, &account, &key.public_key()).await.expect("a gas key");
    assert_eq!(
        (balance, receiver.as_str(), methods),
        (400 * MILLINEAR, account.as_str(), vec!["session_call".to_string()])
    );
    // v1 needs 300 Tgas for token calls.
    let faucet = gas_key::call(&s.worker, &account, &key, "session_call", json!({ "action": "faucet" }), 300)
        .await
        .unwrap();
    assert!(faucet.success, "{:?}", faucet.failure);
    s.list_trend("topic:a", 50 * POINT).await?;
    let series = s.open_series("topic:a", TEST_WINDOW).await?;
    let mint = json!({ "action": { "mint_sets": { "series": series, "amount": (80 * USDC).to_string() } } });
    let r = gas_key::call(&s.worker, &account, &key, "session_call", mint, 300).await.unwrap();
    assert!(r.success, "{:?}", r.failure);
    Ok(V1Account { s, pk, account, key, series })
}

async fn publish_v2(s: &Stack) -> Result<String> {
    publish_global_as(&s.root, "publisher3", &wasm("tredio_account")).await
}

async fn session_of(
    s: &Stack,
    account: &near_workspaces::AccountId,
    key: &SecretKey,
) -> Result<Option<Value>> {
    Ok(s.worker
        .view(account, "session")
        .args_json(json!({ "public_key": key.public_key() }))
        .await?
        .json()?)
}

#[tokio::test]
async fn a_v1_account_upgrades_to_v2_and_keeps_its_sessions_and_balances() -> Result<()> {
    let V1Account { s, pk, account, key, series } = v1_account().await?;
    let up = format!("{series}:up");
    let before = (
        s.usdc_of(&account).await?,
        s.mt_of(&account, &up).await?,
        session_of(&s, &account, &key).await?,
        gas_key::info(&s.worker, &account, &key.public_key()).await,
        s.worker.view(&account, "owner_key").await?.json::<String>()?,
        s.worker.view(&account, "protocol").await?.json::<Value>()?,
    );
    let near_before = balance(&s, &account).await?;
    assert!(s.worker.view(&account, "version").await.is_err(), "v1 has no version view");

    let v2 = publish_v2(&s).await?;
    owner(&s, &pk, &account, 2, json!([{ "upgrade": { "code_hash": v2 } }])).await?;
    s.worker.fast_forward(2).await?;

    assert_eq!(s.worker.view(&account, "version").await?.json::<u32>()?, 2);
    let after = (
        s.usdc_of(&account).await?,
        s.mt_of(&account, &up).await?,
        session_of(&s, &account, &key).await?,
        gas_key::info(&s.worker, &account, &key.public_key()).await,
        s.worker.view(&account, "owner_key").await?.json::<String>()?,
        s.worker.view(&account, "protocol").await?.json::<Value>()?,
    );
    assert_eq!(before, after, "state, balances and the gas key survive the upgrade");
    assert_eq!(after.1, 80 * USDC);
    let near_after = balance(&s, &account).await?;
    assert!(near_after.abs_diff(near_before) < MILLINEAR, "NEAR {near_before} -> {near_after}");
    assert!(s.worker.view(&account, "nonce_used").args_json(json!({ "nonce": 1 })).await?.json::<bool>()?);
    assert!(s.worker.view(&account, "dormant_keys").await?.json::<Vec<String>>()?.is_empty());

    // The same session keeps trading, now with half the gas, and its limit carries on.
    let mint = json!({ "action": { "mint_sets": { "series": series, "amount": (10 * USDC).to_string() } } });
    let r = gas_key::call(&s.worker, &account, &key, "session_call", mint, 150).await.unwrap();
    assert!(r.success, "{:?}", r.failure);
    assert_eq!(s.mt_of(&account, &up).await?, 90 * USDC);
    assert_eq!(session_of(&s, &account, &key).await?.unwrap()["spent"], (90 * USDC).to_string());
    Ok(())
}

/// The market maker rests UP asks at 0.20, 0.22 and 0.45 on `series`.
async fn quote_asks(s: &Stack, series: u64) -> Result<()> {
    ok(s.root
        .call(s.book.id(), "list_series")
        .args_json(json!({ "series": series }))
        .max_gas()
        .transact()
        .await?)
    .await?;
    s.mint_sets(&s.mm, series, 100 * USDC).await?;
    ok(s.mm
        .call(s.outcomes.id(), "mt_transfer_call")
        .args_json(json!({ "receiver_id": s.book.id(), "token_id": format!("{series}:up"), "amount": (100 * USDC).to_string(), "msg": "" }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?)
    .await?;
    for tick in [200, 220, 450] {
        ok(s.mm
            .call(s.book.id(), "place_order")
            .args_json(json!({ "order": { "series": series, "side": "up", "dir": "sell", "tick": tick, "size": (20 * USDC).to_string(), "tif": "gtc" } }))
            .max_gas()
            .transact()
            .await?)
        .await?;
    }
    // Bids for the session's sale.
    ok(s.mm
        .call(s.usdc.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": s.book.id(), "amount": (50 * USDC).to_string(), "msg": "" }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?)
    .await?;
    for tick in [150, 140] {
        ok(s.mm
            .call(s.book.id(), "place_order")
            .args_json(json!({ "order": { "series": series, "side": "up", "dir": "buy", "tick": tick, "size": (20 * USDC).to_string(), "tif": "gtc" } }))
            .max_gas()
            .transact()
            .await?)
        .await?;
    }
    Ok(())
}

#[tokio::test]
async fn new_accounts_upgrade_in_their_first_request_and_trade_with_150_tgas() -> Result<()> {
    let s = Stack::with_account_code(&account_v1_wasm()).await?;
    let v2 = publish_v2(&s).await?;
    let pk = Passkey::new(62);
    let key = SecretKey::from_seed(KeyType::ED25519, "browser");
    // One prompt: the first session and the upgrade, so the account never trades on v1.
    let first = json!([add_session(&key, now(&s.worker).await? + 7 * 86_400, true, 300 * MILLINEAR), { "upgrade": { "code_hash": v2 } }]);
    let account = create(&s, &pk, 1_500 * MILLINEAR, first).await?;
    s.worker.fast_forward(2).await?;
    assert_eq!(s.worker.view(&account, "version").await?.json::<u32>()?, 2);
    assert!(session_of(&s, &account, &key).await?.is_some());

    s.list_trend("topic:a", 50 * POINT).await?;
    let series = s.open_series("topic:a", TEST_WINDOW).await?;
    quote_asks(&s, series).await?;
    let call = |action: Value| {
        let (worker, account, key) = (&s.worker, &account, &key);
        async move {
            gas_key::call(worker, account, key, "session_call", json!({ "action": action }), 150)
                .await
                .unwrap()
        }
    };
    let r = call(json!("faucet")).await;
    assert!(r.success, "faucet: {:?}", r.failure);
    let r = call(json!({ "mint_sets": { "series": series, "amount": (10 * USDC).to_string() } })).await;
    assert!(r.success, "mint_sets: {:?}", r.failure);
    let up = format!("{series}:up");
    let r = call(json!({ "swap": { "series": series, "side": "up", "buy": true, "amount": (20 * USDC).to_string(), "min_out": "1" } })).await;
    assert!(r.success, "swap buy: {:?}", r.failure);
    let bought = s.mt_of(&account, &up).await? - 10 * USDC;
    assert!(bought > 0, "the anchored buy filled");
    let r = call(json!({ "swap": { "series": series, "side": "up", "buy": false, "amount": (5 * USDC).to_string(), "min_out": "1" } })).await;
    assert!(r.success, "swap sell: {:?}", r.failure);
    let r = call(json!({ "perp_open": { "trend": "topic:a", "is_long": true, "margin": (10 * USDC).to_string(), "leverage_bps": 20_000, "acceptable_index": 60 * POINT } })).await;
    assert!(r.success, "perp_open: {:?}", r.failure);
    let positions: Vec<Value> =
        s.perps.view("positions_of").args_json(json!({ "account_id": account })).await?.json()?;
    assert_eq!(positions.len(), 1);
    let r = call(json!({ "perp_close": { "id": positions[0]["id"], "acceptable_index": 0 } })).await;
    assert!(r.success, "perp_close: {:?}", r.failure);
    let positions: Vec<Value> =
        s.perps.view("positions_of").args_json(json!({ "account_id": account })).await?.json()?;
    assert!(positions.is_empty());
    let r = call(json!({ "redeem_sets": { "series": series, "amount": USDC.to_string() } })).await;
    assert!(r.success, "redeem_sets: {:?}", r.failure);
    Ok(())
}

#[tokio::test]
async fn renewal_keeps_the_float_and_a_revoked_key_cannot_act() -> Result<()> {
    let s = Stack::with_account_code(&account_v1_wasm()).await?;
    let v2 = publish_v2(&s).await?;
    let pk = Passkey::new(63);
    let key = SecretKey::from_seed(KeyType::ED25519, "browser");
    let first = json!([add_session(&key, now(&s.worker).await? + 86_400, true, 300 * MILLINEAR), { "upgrade": { "code_hash": v2 } }]);
    let account = create(&s, &pk, 1_500 * MILLINEAR, first).await?;
    s.worker.fast_forward(2).await?;
    let float = |s: &Stack| {
        let worker = s.worker.clone();
        let (account, key) = (account.clone(), key.public_key());
        async move { gas_key::info(&worker, &account, &key).await.map(|i| i.0) }
    };
    let session_call = |action: Value, tgas: u64| {
        let (worker, account, key) = (&s.worker, &account, &key);
        async move { gas_key::call(worker, account, key, "session_call", json!({ "action": action }), tgas).await }
    };
    let r = session_call(json!("faucet"), 150).await.unwrap();
    assert!(r.success, "{:?}", r.failure);
    let start = float(&s).await.unwrap();

    // Renewal in place: no new key, the float is untouched, the expiry moves.
    let later = now(&s.worker).await? + 20 * 86_400;
    let done = owner(&s, &pk, &account, 2, json!([add_session(&key, later, true, 0)])).await?;
    assert!(done.0.receipt_failures().is_empty(), "no AddKey on an existing key");
    assert_eq!(float(&s).await, Some(start));
    assert_eq!(session_of(&s, &account, &key).await?.unwrap()["expires_at"], later);
    // Renewal with funding tops the same key up.
    owner(&s, &pk, &account, 3, json!([add_session(&key, later, true, 100 * MILLINEAR)])).await?;
    assert_eq!(float(&s).await, Some(start + 100 * MILLINEAR));

    // The session refills its own key from the account, within the daily cap.
    let account_near = balance(&s, &account).await?;
    let before = float(&s).await.unwrap();
    let r =
        session_call(json!({ "top_up_gas": { "amount": (200 * MILLINEAR).to_string() } }), 30).await.unwrap();
    assert!(r.success, "{:?}", r.failure);
    let after = float(&s).await.unwrap();
    assert!(after > before + 190 * MILLINEAR && after < before + 200 * MILLINEAR, "{before} -> {after}");
    assert!(account_near - balance(&s, &account).await? >= 200 * MILLINEAR);
    let r =
        session_call(json!({ "top_up_gas": { "amount": (400 * MILLINEAR).to_string() } }), 30).await.unwrap();
    assert!(!r.success, "0.2 + 0.4 NEAR is past the 0.5 NEAR daily cap");

    // Revoked: the gas key stays with its balance, but can no longer act.
    let kept = float(&s).await.unwrap();
    let done = owner(&s, &pk, &account, 4, json!([{ "revoke_session": { "public_key": key.public_key() } }]))
        .await?;
    assert!(done.logs().iter().any(|l| l.contains("session_key_kept")));
    assert_eq!(float(&s).await, Some(kept));
    assert!(session_of(&s, &account, &key).await?.is_none());
    let dormant: Vec<String> = s.worker.view(&account, "dormant_keys").await?.json()?;
    assert_eq!(dormant, vec![key.public_key().to_string()]);
    let r = session_call(json!("faucet"), 150).await.unwrap();
    assert!(
        !r.success && r.failure.as_deref().is_some_and(|f| f.contains("not a session key")),
        "{:?}",
        r.failure
    );
    let request = owner_request(&s.worker, &account, 5, json!([{ "freeze": { "frozen": true } }])).await?;
    let r = gas_key::call(
        &s.worker,
        &account,
        &key,
        "owner_execute",
        json!({ "request": request, "proof": pk.prove(&request) }),
        100,
    )
    .await;
    assert!(r.is_err(), "the key may call session_call only: {:?}", r.as_ref().map(|o| &o.failure));
    let frozen: bool = s.worker.view(&account, "frozen").await?.json()?;
    assert!(!frozen);

    // Adding a session for the dormant key brings it back with what is left of its balance.
    let left = float(&s).await.unwrap();
    let done = owner(&s, &pk, &account, 6, json!([add_session(&key, later, true, 0)])).await?;
    assert!(done.0.receipt_failures().is_empty(), "no AddKey on the dormant key");
    assert_eq!(float(&s).await, Some(left));
    let r = session_call(json!("faucet"), 150).await.unwrap();
    assert!(r.success, "the reactivated key trades again: {:?}", r.failure);

    // `delete_key` removes it for good.
    owner(
        &s,
        &pk,
        &account,
        7,
        json!([{ "revoke_session": { "public_key": key.public_key(), "delete_key": true } }]),
    )
    .await?;
    s.worker.fast_forward(2).await?;
    assert!(!gas_key::exists(&s.worker, &account, &key.public_key()).await);
    assert!(session_of(&s, &account, &key).await?.is_none());
    Ok(())
}

#[tokio::test]
async fn token_calls_work_at_the_120_tgas_minimum() -> Result<()> {
    let s = Stack::new().await?;
    let pk = Passkey::new(64);
    let key = SecretKey::from_seed(KeyType::ED25519, "browser");
    let account = create(
        &s,
        &pk,
        1_500 * MILLINEAR,
        json!([add_session(&key, now(&s.worker).await? + 7 * 86_400, true, 300 * MILLINEAR)]),
    )
    .await?;
    s.list_trend("topic:a", 50 * POINT).await?;
    let series = s.open_series("topic:a", TEST_WINDOW).await?;
    quote_asks(&s, series).await?;
    let call = |action: Value, tgas: u64| {
        let (worker, account, key) = (&s.worker, &account, &key);
        async move {
            gas_key::call(worker, account, key, "session_call", json!({ "action": action }), tgas)
                .await
                .unwrap()
        }
    };
    assert!(call(json!("faucet"), 120).await.success);
    for (name, action) in [
        ("mint_sets", json!({ "mint_sets": { "series": series, "amount": USDC.to_string() } })),
        (
            "swap buy",
            json!({ "swap": { "series": series, "side": "up", "buy": true, "amount": (3 * USDC).to_string(), "min_out": "1" } }),
        ),
        (
            "swap sell",
            json!({ "swap": { "series": series, "side": "up", "buy": false, "amount": USDC.to_string(), "min_out": "1" } }),
        ),
        (
            "perp_open",
            json!({ "perp_open": { "trend": "topic:a", "is_long": true, "margin": (2 * USDC).to_string(), "leverage_bps": 20_000, "acceptable_index": 60 * POINT } }),
        ),
    ] {
        let r = call(action, 120).await;
        assert!(r.success, "{name} at 120 Tgas: {:?}", r.failure);
    }
    let positions: Vec<Value> =
        s.perps.view("positions_of").args_json(json!({ "account_id": account })).await?.json()?;
    let r = call(json!({ "perp_close": { "id": positions[0]["id"], "acceptable_index": 0 } }), 120).await;
    assert!(r.success, "perp_close at 120 Tgas: {:?}", r.failure);
    // Below the minimum the call fails in the account, before it counts against the limit.
    let spent = session_of(&s, &account, &key).await?.unwrap()["spent"].clone();
    let r = call(json!({ "mint_sets": { "series": series, "amount": USDC.to_string() } }), 110).await;
    assert!(r.failure.as_deref().is_some_and(|f| f.contains("attach at least 120 Tgas")), "{:?}", r.failure);
    assert_eq!(session_of(&s, &account, &key).await?.unwrap()["spent"], spent);
    Ok(())
}

#[tokio::test]
async fn the_hyperliquid_guard_reads_the_asset_index_from_the_registry() -> Result<()> {
    let s = Stack::new().await?;
    let pk = Passkey::new(65);
    let key = SecretKey::from_seed(KeyType::ED25519, "autopilot");
    let mut grant = add_session(&key, now(&s.worker).await? + 86_400, true, 300 * MILLINEAR);
    grant["add_session"]["scope"] = json!({ "outcomes": false, "perps": false, "hyperliquid": true });
    let account = create(&s, &pk, 1_500 * MILLINEAR, json!([grant])).await?;
    ok(s.report(
        json!([]),
        json!([]),
        json!([{ "asset": "BTC", "price": "6500000000000", "asset_index": 0 }]),
    )
    .await?)
    .await?;
    let mark: Value = s.registry.view("mark_of").args_json(json!({ "asset": "BTC" })).await?.json()?;
    assert_eq!(mark["asset_index"], 0);
    let order = |asset_index: u32| {
        json!({ "hl_order": { "order": {
            "asset": "BTC", "asset_index": asset_index, "is_buy": true, "price": "65500", "size": "0.01", "reduce_only": false, "tif": "Ioc"
        }, "nonce": 1_700_000_000_000u64 } })
    };
    // BTC's mark cannot vouch for an order on asset 3.
    let r = gas_key::call(&s.worker, &account, &key, "session_call", json!({ "action": order(3) }), 150)
        .await
        .unwrap();
    assert!(r.failure.as_deref().is_some_and(|f| f.contains("mark is for another asset")), "{:?}", r.failure);
    assert!(!r.logs.iter().any(|l| l.contains("hyperliquid_signed")));
    // On asset 0 the guard passes and the digest goes to the signer (absent in the sandbox).
    let r = gas_key::call(&s.worker, &account, &key, "session_call", json!({ "action": order(0) }), 150)
        .await
        .unwrap();
    assert!(r.logs.iter().any(|l| l.contains("hyperliquid_signed")), "{:?} {:?}", r.logs, r.failure);
    Ok(())
}
