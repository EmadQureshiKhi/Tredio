//! Shared sandbox setup: the whole Tredio stack on a local node, wired as on testnet.

#![allow(dead_code)]

use anyhow::Result;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::network::Sandbox;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use p256::ecdsa::signature::hazmat::PrehashSigner;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const USDC: u128 = 1_000_000;
pub const POINT: u64 = 1_000_000;
pub const TEST_WINDOW: u64 = 300;

pub fn wasm(name: &str) -> Vec<u8> {
    let path = format!("{}/../target/near/{name}/{name}.wasm", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|_| panic!("missing {path}: run contracts/scripts/build.sh first"))
}

pub fn code_hash(code: &[u8]) -> String {
    bs58::encode(Sha256::digest(code)).into_string()
}

pub struct Stack {
    pub worker: Worker<Sandbox>,
    pub root: Account,
    pub usdc: Contract,
    pub registry: Contract,
    pub outcomes: Contract,
    pub book: Contract,
    pub perps: Contract,
    pub curation: Contract,
    pub coins: Contract,
    pub accounts: Contract,
    pub treasury: Account,
    pub alice: Account,
    pub bob: Account,
    pub mm: Account,
    pub oracle_key: SigningKey,
    pub run_id: std::cell::Cell<u64>,
}

async fn sub(root: &Account, name: &str, near: u128) -> Result<Account> {
    Ok(root.create_subaccount(name).initial_balance(NearToken::from_near(near)).transact().await?.into_result()?)
}

async fn deploy(root: &Account, name: &str, crate_name: &str, near: u128) -> Result<Contract> {
    let acc = sub(root, name, near).await?;
    Ok(acc.deploy(&wasm(crate_name)).await?.into_result()?)
}

/// A successful transaction (possibly with tolerated receipt failures, which are printed).
pub struct Done(pub near_workspaces::result::ExecutionFinalResult);

impl Done {
    pub fn json<T: serde::de::DeserializeOwned>(self) -> Result<T> {
        Ok(self.0.json()?)
    }

    pub fn logs(&self) -> Vec<&str> {
        self.0.logs()
    }
}

pub async fn ok(r: near_workspaces::result::ExecutionFinalResult) -> Result<Done> {
    if !r.is_success() {
        anyhow::bail!("transaction failed: {:#?}", r.failures());
    }
    for f in r.receipt_failures() {
        eprintln!("receipt failure (tolerated): {f:?}");
    }
    Ok(Done(r))
}

/// Publishes `code` as a global contract and returns its base58 hash.
pub async fn publish_global(root: &Account, code: &[u8]) -> Result<String> {
    let publisher = deploy(root, "publisher", "tredio_test_publisher", 60).await?;
    ok(publisher.call("publish").args_json(json!({ "code": STANDARD.encode(code) })).max_gas().transact().await?).await?;
    Ok(code_hash(code))
}

pub async fn now(worker: &Worker<Sandbox>) -> Result<u64> {
    Ok(worker.view_block().await?.timestamp() / 1_000_000_000)
}

impl Stack {
    pub async fn new() -> Result<Self> {
        let worker = near_workspaces::sandbox().await?;
        let root = worker.root_account()?;
        let oracle_key = SigningKey::from_bytes(&[11u8; 32]);
        let oracle_pk = format!("ed25519:{}", bs58::encode(oracle_key.verifying_key().as_bytes()).into_string());

        let treasury = sub(&root, "treasury", 10).await?;
        let alice = sub(&root, "alice", 20).await?;
        let bob = sub(&root, "bob", 20).await?;
        let mm = sub(&root, "mm", 20).await?;

        let usdc = deploy(&root, "usdc", "tredio_usdc", 10).await?;
        let registry = deploy(&root, "registry", "tredio_registry", 10).await?;
        let outcomes = deploy(&root, "outcomes", "tredio_outcomes", 10).await?;
        let book = deploy(&root, "book", "tredio_book", 10).await?;
        let perps = deploy(&root, "perps", "tredio_perps", 10).await?;
        let curation = deploy(&root, "curation", "tredio_curation", 10).await?;
        let coins = deploy(&root, "coins", "tredio_coins", 30).await?;
        let accounts = deploy(&root, "accounts", "tredio_accounts", 10).await?;

        let coin_hash = publish_global(&root, &wasm("tredio_coin")).await?;
        let account_hash = {
            let p2 = deploy(&root, "publisher2", "tredio_test_publisher", 60).await?;
            let code = wasm("tredio_account");
            ok(p2.call("publish").args_json(json!({ "code": STANDARD.encode(&code) })).max_gas().transact().await?).await?;
            code_hash(&code)
        };

        let r = root.id();
        ok(usdc.call("new").args_json(json!({ "owner": r, "drip_amount": (10_000 * USDC).to_string(), "drip_cooldown": 0 })).transact().await?).await?;
        ok(registry
            .call("new")
            .args_json(json!({
                "owner": r,
                "oracle": { "tee_signer": { "public_key": oracle_pk } },
                "params": {
                    "staleness_limit": 600, "max_move_bps": 5000, "attention_floor": 5_000_000,
                    "cooling_window": 1800, "retire_window": 3600, "stale_retire_window": 7200,
                    "settlement_tolerance": 600, "max_report_age": 300, "max_future_skew": 60
                }
            }))
            .transact()
            .await?)
        .await?;
        ok(outcomes.call("new").args_json(json!({ "owner": r, "usdc": usdc.id(), "registry": registry.id(), "test_window": TEST_WINDOW })).transact().await?).await?;
        ok(book.call("new").args_json(json!({ "owner": r, "usdc": usdc.id(), "outcomes": outcomes.id(), "registry": registry.id(), "treasury": treasury.id(), "taker_fee_bps": 20 })).transact().await?).await?;
        ok(curation.call("new").args_json(json!({ "owner": r, "usdc": usdc.id(), "treasury": treasury.id() })).transact().await?).await?;
        ok(perps.call("new").args_json(json!({ "owner": r, "usdc": usdc.id(), "registry": registry.id(), "curation": curation.id(), "treasury": treasury.id(), "max_oi_per_side": (1_000_000 * USDC).to_string() })).transact().await?).await?;
        ok(coins
            .call("new")
            .args_json(json!({
                "owner": r, "usdc": usdc.id(), "registry": registry.id(), "curation": curation.id(),
                "treasury": treasury.id(), "exchange": "exchange.test.near", "pool_fee_bps": 30,
                "coin_code": coin_hash, "base_virtual_quote": (1_000 * USDC).to_string(),
                "graduation_reserve": (500 * USDC).to_string()
            }))
            .transact()
            .await?)
        .await?;
        ok(accounts
            .call("new")
            .args_json(json!({
                "owner": r, "network": "testnet", "account_code": account_hash,
                "protocol": {
                    "usdc": usdc.id(), "registry": registry.id(), "outcomes": outcomes.id(), "book": book.id(),
                    "perps": perps.id(), "coins": coins.id(), "curation": curation.id(),
                    "signer": "signer.test.near", "factory": "accounts.test.near"
                }
            }))
            .transact()
            .await?)
        .await?;

        // Wiring.
        ok(root.call(registry.id(), "add_consumer").args_json(json!({ "account_id": outcomes.id() })).transact().await?).await?;
        for source in [perps.id(), coins.id()] {
            ok(root.call(curation.id(), "add_source").args_json(json!({ "account_id": source })).transact().await?).await?;
        }
        // Storage: protocol contracts with USDC, users with the protocol.
        for holder in [outcomes.id(), book.id(), perps.id(), curation.id(), coins.id(), treasury.id()] {
            ok(root
                .call(usdc.id(), "storage_deposit")
                .args_json(json!({ "account_id": holder }))
                .deposit(NearToken::from_millinear(10))
                .transact()
                .await?)
            .await?;
        }
        for user in [&alice, &bob, &mm] {
            ok(user.call(usdc.id(), "faucet").transact().await?).await?;
            for c in [outcomes.id(), book.id(), perps.id()] {
                ok(user.call(c, "storage_deposit").args_json(json!({})).deposit(NearToken::from_millinear(200)).transact().await?).await?;
            }
        }
        // The book holds outcome tokens for its traders.
        ok(root
            .call(outcomes.id(), "storage_deposit")
            .args_json(json!({ "account_id": book.id() }))
            .deposit(NearToken::from_near(1))
            .transact()
            .await?)
        .await?;
        ok(root.call(book.id(), "storage_deposit").args_json(json!({ "account_id": treasury.id() })).deposit(NearToken::from_millinear(50)).transact().await?).await?;
        // Seed the perps pool.
        ok(mm
            .call(usdc.id(), "ft_transfer_call")
            .args_json(json!({ "receiver_id": perps.id(), "amount": (5_000 * USDC).to_string(), "msg": "\"deposit_pool\"" }))
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
            .await?)
        .await?;

        Ok(Self {
            worker,
            root,
            usdc,
            registry,
            outcomes,
            book,
            perps,
            curation,
            coins,
            accounts,
            treasury,
            alice,
            bob,
            mm,
            oracle_key,
            run_id: std::cell::Cell::new(0),
        })
    }

    /// Signs and submits an oracle report observed now.
    pub async fn report(&self, new_trends: Value, updates: Value, marks: Value) -> Result<near_workspaces::result::ExecutionFinalResult> {
        let run = self.run_id.get() + 1;
        self.run_id.set(run);
        let observed = now(&self.worker).await?;
        let report = json!({ "run_id": run, "observed_at": observed, "new_trends": new_trends, "updates": updates, "marks": marks }).to_string();
        let sig = self.oracle_key.sign(&Sha256::digest(report.as_bytes()));
        Ok(self
            .root
            .call(self.registry.id(), "submit_report")
            .args_json(json!({ "report_json": report, "signature": STANDARD.encode(sig.to_bytes()) }))
            .max_gas()
            .transact()
            .await?)
    }

    pub async fn list_trend(&self, id: &str, index: u64) -> Result<()> {
        ok(self
            .report(
                json!([{ "identifier": id, "asset_class": "topic", "index": index, "surfacer": self.bob.id(), "smart_money_confirmed": false, "review_hash": null, "asset": null }]),
                json!([]),
                json!([]),
            )
            .await?)
        .await?;
        Ok(())
    }

    pub async fn update(&self, id: &str, index: u64) -> Result<()> {
        ok(self.report(json!([]), json!([{ "id": id, "index": index }]), json!([])).await?).await?;
        Ok(())
    }

    pub async fn usdc_of(&self, who: &near_workspaces::AccountId) -> Result<u128> {
        let v: String = self.usdc.view("ft_balance_of").args_json(json!({ "account_id": who })).await?.json()?;
        Ok(v.parse()?)
    }

    pub async fn mt_of(&self, who: &near_workspaces::AccountId, token: &str) -> Result<u128> {
        let v: String = self.outcomes.view("mt_balance_of").args_json(json!({ "account_id": who, "token_id": token })).await?.json()?;
        Ok(v.parse()?)
    }

    pub async fn open_series(&self, trend: &str, window: u64) -> Result<u64> {
        let r = ok(self.root.call(self.outcomes.id(), "open_series").args_json(json!({ "trend": trend, "window": window })).max_gas().transact().await?).await?;
        let id: Option<u64> = r.json()?;
        id.ok_or_else(|| anyhow::anyhow!("series not opened"))
    }

    pub async fn mint_sets(&self, who: &Account, series: u64, amount: u128) -> Result<()> {
        ok(who
            .call(self.usdc.id(), "ft_transfer_call")
            .args_json(json!({ "receiver_id": self.outcomes.id(), "amount": amount.to_string(), "msg": json!({ "mint": { "series": series, "receiver": null } }).to_string() }))
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
            .await?)
        .await?;
        Ok(())
    }
}

/// A passkey for owner requests, signing as a browser would.
pub struct Passkey(pub p256::ecdsa::SigningKey);

impl Passkey {
    pub fn new(seed: u8) -> Self {
        Self(p256::ecdsa::SigningKey::from_bytes(&[seed; 32].into()).unwrap())
    }

    pub fn public_hex(&self) -> String {
        hex::encode(self.0.verifying_key().to_encoded_point(true).as_bytes())
    }

    /// The WebAuthn proof for `request` (challenge = SHA-256("tredio-account:v1:" || request)).
    pub fn prove(&self, request: &str) -> Value {
        let mut tagged = b"tredio-account:v1:".to_vec();
        tagged.extend_from_slice(request.as_bytes());
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(&tagged));
        let client = format!(r#"{{"type":"webauthn.get","challenge":"{challenge}","origin":"https://app.tredio.bid"}}"#);
        let mut auth = Sha256::digest(b"tredio.bid").to_vec();
        auth.push(0x05);
        auth.extend_from_slice(&[0, 0, 0, 1]);
        let mut msg = auth.clone();
        msg.extend_from_slice(&Sha256::digest(client.as_bytes()));
        let sig: p256::ecdsa::Signature = self.0.sign_prehash(&Sha256::digest(&msg)).unwrap();
        json!({
            "authenticator_data": URL_SAFE_NO_PAD.encode(&auth),
            "client_data_json": client,
            "signature": hex::encode(sig.to_bytes()),
        })
    }
}
