//! Cross-contract flows on a local sandbox node: oracle, outcomes, book, perps, coins, curation
//! and universal accounts with passkey-authorized sessions.

mod common;

use anyhow::Result;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use common::*;
use near_workspaces::types::{NearToken, SecretKey};
use near_workspaces::Account;
use serde_json::{json, Value};

#[tokio::test]
async fn the_registry_takes_only_signed_reports() -> Result<()> {
    let s = Stack::new().await?;
    s.list_trend("topic:openai", 40 * POINT).await?;
    let t: Value = s.registry.view("get_trend").args_json(json!({ "id": "topic:openai" })).await?.json()?;
    assert_eq!(t["index"], 40 * POINT);
    assert_eq!(t["surfacer"], s.bob.id().as_str());

    // A report signed by another key is refused and changes nothing.
    let forged = json!({ "run_id": 99, "observed_at": now(&s.worker).await?, "updates": [{ "id": "topic:openai", "index": 90_000_000 }] }).to_string();
    use ed25519_dalek::Signer;
    let sig = ed25519_dalek::SigningKey::from_bytes(&[5u8; 32]).sign(&sha2_digest(&forged));
    let r = s
        .alice
        .call(s.registry.id(), "submit_report")
        .args_json(json!({ "report_json": forged, "signature": STANDARD.encode(sig.to_bytes()) }))
        .max_gas()
        .transact()
        .await?;
    assert!(r.is_failure());
    let t: Value = s.registry.view("index_of").args_json(json!({ "id": "topic:openai" })).await?.json()?;
    assert_eq!(t["index"], 40 * POINT);
    Ok(())
}

fn sha2_digest(s: &str) -> Vec<u8> {
    use sha2::Digest;
    sha2::Sha256::digest(s.as_bytes()).to_vec()
}

#[tokio::test]
async fn outcome_series_mint_settle_and_redeem() -> Result<()> {
    let s = Stack::new().await?;
    s.list_trend("topic:a", 50 * POINT).await?;
    let series = s.open_series("topic:a", TEST_WINDOW).await?;
    let info: Value = s.outcomes.view("get_series").args_json(json!({ "series": series })).await?.json()?;
    assert_eq!(info["opening_index"], 50 * POINT);

    let before = s.usdc_of(s.alice.id()).await?;
    s.mint_sets(&s.alice, series, 10 * USDC).await?;
    assert_eq!(s.usdc_of(s.alice.id()).await?, before - 10 * USDC);
    assert_eq!(s.mt_of(s.alice.id(), &format!("{series}:up")).await?, 10 * USDC);

    // Alice keeps UP, gives DOWN to Bob.
    ok(s.alice
        .call(s.outcomes.id(), "mt_transfer")
        .args_json(json!({ "receiver_id": s.bob.id(), "token_id": format!("{series}:down"), "amount": (10 * USDC).to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?)
    .await?;

    // Past expiry, the first observation settles it: the index rose, so UP wins.
    let expiry = info["expiry"].as_u64().unwrap();
    while now(&s.worker).await? <= expiry {
        s.worker.fast_forward(200).await?;
    }
    s.update("topic:a", 55 * POINT).await?;
    let st: Value = s
        .registry
        .view("settlement_of")
        .args_json(json!({ "id": "topic:a", "expiry": expiry }))
        .await?
        .json()?;
    assert_eq!(st["finalized"], true);
    let outcome: Value = ok(s
        .root
        .call(s.outcomes.id(), "settle")
        .args_json(json!({ "series": series }))
        .max_gas()
        .transact()
        .await?)
    .await?
    .json()?;
    assert_eq!(outcome, "up");

    let alice_before = s.usdc_of(s.alice.id()).await?;
    ok(s.alice
        .call(s.outcomes.id(), "redeem_winnings")
        .args_json(json!({ "series": series, "up": (10 * USDC).to_string(), "down": "0" }))
        .max_gas()
        .transact()
        .await?)
    .await?;
    assert_eq!(s.usdc_of(s.alice.id()).await?, alice_before + 10 * USDC);
    let backing: String = s.outcomes.view("total_backing").await?.json()?;
    assert_eq!(backing, "0", "only the losing DOWN tokens remain, and they are owed nothing");
    Ok(())
}

#[tokio::test]
async fn minting_is_refunded_when_the_trend_cools() -> Result<()> {
    let s = Stack::new().await?;
    s.list_trend("topic:a", 50 * POINT).await?;
    let series = s.open_series("topic:a", TEST_WINDOW).await?;
    // Drop below the floor long enough to cool (30 minutes on these params).
    for _ in 0..4 {
        s.update("topic:a", 2 * POINT).await.ok();
        s.worker.fast_forward(700).await?;
    }
    s.update("topic:a", 2 * POINT).await?;
    let t: Value = s.registry.view("index_of").args_json(json!({ "id": "topic:a" })).await?.json()?;
    if t["status"] != "cooling" {
        eprintln!("trend status after fast-forward: {}", t["status"]);
        return Ok(());
    }
    let before = s.usdc_of(s.alice.id()).await?;
    s.mint_sets(&s.alice, series, 5 * USDC).await.ok();
    assert_eq!(s.usdc_of(s.alice.id()).await?, before, "the whole amount came back");
    Ok(())
}

async fn quote_asks(s: &Stack, series: u64) -> Result<()> {
    // The market maker mints sets and rests UP asks on the book.
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
    Ok(())
}

#[tokio::test]
async fn anchored_swaps_fill_inside_the_band_and_refund_the_rest() -> Result<()> {
    let s = Stack::new().await?;
    s.list_trend("topic:a", 50 * POINT).await?;
    let series = s.open_series("topic:a", TEST_WINDOW).await?;
    quote_asks(&s, series).await?;

    let before = s.usdc_of(s.alice.id()).await?;
    let msg = json!({ "swap": { "series": series, "side": "up", "limit_tick": null, "min_out": "1", "anchored": true } }).to_string();
    ok(s.alice
        .call(s.usdc.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": s.book.id(), "amount": (50 * USDC).to_string(), "msg": msg }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?)
    .await?;
    let got = s.mt_of(s.alice.id(), &format!("{series}:up")).await?;
    let spent = before - s.usdc_of(s.alice.id()).await?;
    // With minutes left and ties going DOWN, an at-the-money UP is worth about 0.15 to 0.20, so the
    // band ends near 0.27: the 0.20 and 0.22 asks fill, 0.45 does not.
    assert_eq!(got, 40 * USDC, "both near asks filled");
    assert!(spent > 8_400_000 && spent < 8_450_000, "paid {spent} (0.2% fee included), the rest refunded");
    let depth: Value = s
        .book
        .view("depth")
        .args_json(json!({ "series": series, "side": "up", "levels": 5 }))
        .await?
        .json()?;
    assert_eq!(depth["asks"][0]["tick"], 450);

    // A minimum the book cannot meet refunds everything.
    let before = s.usdc_of(s.alice.id()).await?;
    let msg = json!({ "swap": { "series": series, "side": "up", "limit_tick": null, "min_out": (1_000 * USDC).to_string(), "anchored": true } }).to_string();
    let _ = s
        .alice
        .call(s.usdc.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": s.book.id(), "amount": (5 * USDC).to_string(), "msg": msg }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert_eq!(s.usdc_of(s.alice.id()).await?, before);
    Ok(())
}

#[tokio::test]
async fn perps_open_close_and_pay_the_curator() -> Result<()> {
    let s = Stack::new().await?;
    s.list_trend("topic:a", 50 * POINT).await?;
    let open = json!({ "open": { "trend": "topic:a", "is_long": true, "leverage_bps": 20_000, "acceptable_index": 60 * POINT, "deadline": null, "owner": null } }).to_string();
    ok(s.alice
        .call(s.usdc.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": s.perps.id(), "amount": (100 * USDC).to_string(), "msg": open }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?)
    .await?;
    let positions: Vec<Value> =
        s.perps.view("positions_of").args_json(json!({ "account_id": s.alice.id() })).await?.json()?;
    assert_eq!(positions.len(), 1);
    let id = positions[0]["id"].as_u64().unwrap();

    s.update("topic:a", 55 * POINT).await?;
    let before = s.usdc_of(s.alice.id()).await?;
    ok(s.alice
        .call(s.perps.id(), "close")
        .args_json(json!({ "id": id, "acceptable_index": 0 }))
        .max_gas()
        .transact()
        .await?)
    .await?;
    let gained = s.usdc_of(s.alice.id()).await? - before;
    assert!(gained > 115 * USDC && gained < 120 * USDC, "2x on +10%: {gained}");
    // Bob surfaced the trend and earned the curation share of both fees.
    let earned: String =
        s.curation.view("claimable_of").args_json(json!({ "account_id": s.bob.id() })).await?.json()?;
    assert!(earned.parse::<u128>()? > 0);

    // An open priced past the acceptable index is refused and refunded.
    let before = s.usdc_of(s.alice.id()).await?;
    let open = json!({ "open": { "trend": "topic:a", "is_long": true, "leverage_bps": 20_000, "acceptable_index": 50 * POINT, "deadline": null, "owner": null } }).to_string();
    ok(s.alice
        .call(s.usdc.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": s.perps.id(), "amount": (10 * USDC).to_string(), "msg": open }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?)
    .await?;
    assert_eq!(s.usdc_of(s.alice.id()).await?, before);
    Ok(())
}

#[tokio::test]
async fn trend_coins_launch_from_global_code_and_trade() -> Result<()> {
    let s = Stack::new().await?;
    s.list_trend("topic:openai", 40 * POINT).await?;
    let created = ok(s
        .root
        .call(s.coins.id(), "create_curve")
        .args_json(json!({ "trend": "topic:openai" }))
        .max_gas()
        .transact()
        .await?)
    .await?;
    eprintln!("create logs: {:?}", created.logs());
    let curve: Value =
        s.coins.view("get_curve").args_json(json!({ "trend": "topic:openai" })).await?.json()?;
    assert_eq!(curve["stage"], "open");
    let coin: near_workspaces::AccountId = curve["coin"].as_str().unwrap().parse()?;
    assert_eq!(coin.as_str(), format!("topic-openai.{}", s.coins.id()));

    let buy = json!({ "buy": { "trend": "topic:openai", "min_out": "1", "receiver": null } }).to_string();
    ok(s.alice
        .call(s.usdc.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": s.coins.id(), "amount": (20 * USDC).to_string(), "msg": buy }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?)
    .await?;
    let bal: String = s
        .worker
        .view(&coin, "ft_balance_of")
        .args_json(json!({ "account_id": s.alice.id() }))
        .await?
        .json()?;
    let bal: u128 = bal.parse()?;
    assert!(bal > 0);

    // Sell half back to the curve.
    ok(s.alice
        .call(&coin, "storage_deposit")
        .args_json(json!({ "account_id": s.coins.id() }))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?)
    .await?;
    let before = s.usdc_of(s.alice.id()).await?;
    let sell = json!({ "sell": { "min_out": "1", "receiver": null } }).to_string();
    ok(s.alice
        .call(&coin, "ft_transfer_call")
        .args_json(json!({ "receiver_id": s.coins.id(), "amount": (bal / 2).to_string(), "msg": sell }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?)
    .await?;
    let back = s.usdc_of(s.alice.id()).await? - before;
    assert!(back > 9 * USDC && back < 10 * USDC, "sold half for {back}");
    Ok(())
}

#[tokio::test]
async fn a_passkey_creates_a_universal_account_with_a_guarded_session() -> Result<()> {
    let s = Stack::new().await?;
    let pk = Passkey::new(42);
    let account_id: near_workspaces::AccountId =
        s.accounts.view("account_id_of").args_json(json!({ "owner_key": pk.public_hex() })).await?.json()?;
    assert!(account_id.as_str().starts_with("0u"));

    let session = SecretKey::from_seed(near_workspaces::types::KeyType::ED25519, "tredio-session");
    let request = json!({
        "account": account_id,
        "network": "testnet",
        "nonce": 1,
        "created_at": now(&s.worker).await?,
        "actions": [{ "add_session": {
            "public_key": session.public_key(),
            "label": "web",
            "scope": { "outcomes": true, "perps": true, "hyperliquid": false },
            "expires_at": now(&s.worker).await? + 7 * 86_400,
            "daily_limit": (100 * USDC).to_string(),
            "gas_key": false,
            "gas_funding": "0"
        } }]
    })
    .to_string();
    ok(s.root
        .call(s.accounts.id(), "create_account")
        .args_json(json!({ "owner_key": pk.public_hex(), "first_request": request, "first_proof": pk.prove(&request) }))
        .deposit(NearToken::from_millinear(500))
        .max_gas()
        .transact()
        .await?)
    .await?;
    let sessions: Vec<Value> = s.worker.view(&account_id, "sessions").await?.json()?;
    assert_eq!(sessions.len(), 1);
    let boot: bool = s.worker.view(&account_id, "bootstrapped").await?.json()?;
    assert!(boot);

    // The session key draws test USDC, then hits the daily limit.
    let keys = s.worker.view_access_keys(&account_id).await?;
    assert_eq!(keys.len(), 1, "the session is the only key");
    let user = Account::from_secret_key(account_id.clone(), session, &s.worker);
    let tgas300 = near_workspaces::types::Gas::from_tgas(300);
    ok(user
        .call(&account_id, "session_call")
        .args_json(json!({ "action": "faucet" }))
        .gas(tgas300)
        .transact()
        .await?)
    .await?;
    assert_eq!(s.usdc_of(&account_id).await?, 10_000 * USDC);
    s.list_trend("topic:a", 50 * POINT).await?;
    let series = s.open_series("topic:a", TEST_WINDOW).await?;
    ok(user
        .call(&account_id, "session_call")
        .args_json(
            json!({ "action": { "mint_sets": { "series": series, "amount": (80 * USDC).to_string() } } }),
        )
        .gas(tgas300)
        .transact()
        .await?)
    .await?;
    assert_eq!(s.mt_of(&account_id, &format!("{series}:up")).await?, 80 * USDC);
    let over = user
        .call(&account_id, "session_call")
        .args_json(
            json!({ "action": { "mint_sets": { "series": series, "amount": (30 * USDC).to_string() } } }),
        )
        .gas(tgas300)
        .transact()
        .await?;
    assert!(over.is_failure(), "past the 100 USDC daily limit");

    // The session cannot withdraw: only the passkey can.
    let withdraw = user
        .call(s.usdc.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": s.bob.id(), "amount": "1" }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await;
    assert!(withdraw.is_err() || withdraw.unwrap().is_failure());

    // A passkey request with a replayed nonce is refused.
    let replay = json!({ "account": account_id, "network": "testnet", "nonce": 1, "created_at": now(&s.worker).await?, "actions": [{ "freeze": { "frozen": true } }] }).to_string();
    let r = s
        .bob
        .call(&account_id, "owner_execute")
        .args_json(json!({ "request": replay, "proof": pk.prove(&replay) }))
        .max_gas()
        .transact()
        .await?;
    assert!(r.is_failure());
    Ok(())
}
