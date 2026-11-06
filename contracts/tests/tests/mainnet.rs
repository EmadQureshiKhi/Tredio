//! #mainnet rehearsal: the Tredio contracts deployed as `deployments/mainnet.json` plans them, on a
//! local sandbox that runs the code mainnet runs today for everything Tredio does not own.
//!
//! - Circle's native USDC and Rhea (`v2.ref-finance.near`) are imported from mainnet with their
//!   current code, under their mainnet account ids (`import_contract`, read over mainnet RPC).
//! - `tredio.near` and every contract account under it get the mainnet names and init arguments:
//!   no mock token, no test window, the accounts factory on network `mainnet`.
//! - Outcomes, perps, a trend coin graduating into a real Rhea pool and a passkey account trade
//!   real-code USDC end to end.
//!
//! What it cannot rehearse: Chain Signatures (`v1.signer` needs the MPC network) and the
//! off-chain mainnet services (1Click, Hyperliquid mainnet), which have their own tests.
//! MAINNET_RPC_URL overrides the RPC the mainnet code is read from.

mod common;

use anyhow::Result;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use common::*;
use near_workspaces::network::Sandbox;
use near_workspaces::types::{AccessKey, AccountDetailsPatch, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};

/// deployments/mainnet.json, the plan the deploy script follows.
fn plan() -> Value {
    let path = format!("{}/../../deployments/mainnet.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&path).expect("deployments/mainnet.json")).expect("json")
}

fn id(v: &Value) -> AccountId {
    v.as_str().expect("account id").parse().expect("valid account id")
}

fn u128_of(v: &Value) -> u128 {
    v.as_str().map(|s| s.parse().expect("u128")).unwrap_or_else(|| v.as_u64().expect("number") as u128)
}

/// A top-level mainnet account (`tredio.near`) made in the sandbox with a key the test holds.
async fn top_level(worker: &Worker<Sandbox>, name: &AccountId, near: u128) -> Result<Account> {
    let key = SecretKey::from_random(KeyType::ED25519);
    worker
        .patch(name)
        .account(AccountDetailsPatch::default().balance(NearToken::from_near(near)).storage_usage(182))
        .access_key(key.public_key(), AccessKey::full_access())
        .transact()
        .await?;
    Ok(Account::from_secret_key(name.clone(), key, worker))
}

async fn sub(parent: &Account, name: &str, near: u128) -> Result<Account> {
    Ok(parent
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(near))
        .transact()
        .await?
        .into_result()?)
}

async fn deploy(parent: &Account, name: &str, crate_name: &str, near: u128) -> Result<Contract> {
    Ok(sub(parent, name, near).await?.deploy(&wasm(crate_name)).await?.into_result()?)
}

/// Runs a call and fails the test with the receipts' failures if any receipt failed.
async fn run(call: near_workspaces::operations::CallTransaction) -> Result<Done> {
    ok(call.max_gas().transact().await?).await
}

struct Mainnet {
    worker: Worker<Sandbox>,
    usdc: Contract,
    rhea: Contract,
    root: Account,
    registry: Contract,
    outcomes: Contract,
    perps: Contract,
    curation: Contract,
    coins: Contract,
    accounts: Contract,
    alice: Account,
    bob: Account,
    keeper: Account,
    oracle_key: ed25519_dalek::SigningKey,
    run_id: std::cell::Cell<u64>,
}

impl Mainnet {
    async fn new() -> Result<Self> {
        let p = plan();
        assert_eq!(p["network"], "mainnet");
        let worker = near_workspaces::sandbox().await?;
        let rpc =
            std::env::var("MAINNET_RPC_URL").unwrap_or_else(|_| "https://rpc.mainnet.fastnear.com".into());
        let mainnet = near_workspaces::mainnet().rpc_addr(&rpc).await?;

        // The code mainnet runs today, under its mainnet ids. Their accounts keep mainnet's storage
        // size, so they need a large balance to pay for it here.
        let usdc = worker
            .import_contract(&id(&p["contracts"]["usdc"]), &mainnet)
            .initial_balance(NearToken::from_near(100_000))
            .transact()
            .await?;
        let rhea = worker
            .import_contract(&id(&p["external"]["exchange"]), &mainnet)
            .initial_balance(NearToken::from_near(100_000))
            .transact()
            .await?;
        eprintln!(
            "imported mainnet code: USDC {} and Rhea {}",
            usdc.view_code().await.map(|c| code_hash(&c))?,
            rhea.view_code().await.map(|c| code_hash(&c))?
        );

        let root = top_level(&worker, &id(&p["root"]), 1_000).await?;
        let treasury = top_level(&worker, &id(&p["treasury"]), 10).await?;
        let sandbox_root = worker.root_account()?;
        let alice = sub(&sandbox_root, "alice", 50).await?;
        let bob = sub(&sandbox_root, "bob", 50).await?;
        let keeper = sub(&sandbox_root, "keeper", 50).await?;
        let mm = sub(&sandbox_root, "mm", 50).await?;
        let second = sub(&sandbox_root, "circle", 10).await?;

        // Circle's USDC: two approvers for its multisig, a controller and a minter, as on mainnet.
        let both = json!([sandbox_root.id(), second.id()]);
        ok(usdc
            .call("init")
            .args_json(json!({ "admin_ids": both, "master_minter_ids": both, "owner_ids": both, "pauser_ids": both, "blocklister_id": sandbox_root.id(),
                "metadata": { "spec": "ft-1.0.0", "name": "USDC", "symbol": "USDC", "decimals": 6 } }))
            .max_gas()
            .transact()
            .await?)
        .await?;
        for action in [
            json!({ "ConfigureController": { "controller_id": sandbox_root.id(), "minter_id": sandbox_root.id() } }),
            json!({ "ConfigureController": { "controller_id": second.id(), "minter_id": sandbox_root.id() } }),
            json!({ "ConfigureMinterAllowance": { "controller_id": sandbox_root.id(), "minter_allowance": (100_000_000 * USDC).to_string() } }),
        ] {
            let request: u32 = run(sandbox_root
                .call(usdc.id(), "create_multisig_request")
                .args_json(json!({ "action": action })))
            .await?
            .json()?;
            for approver in [&sandbox_root, &second] {
                run(approver
                    .call(usdc.id(), "approve_multisig_request")
                    .args_json(json!({ "request_id": request })))
                .await?;
            }
            run(sandbox_root
                .call(usdc.id(), "execute_multisig_request")
                .args_json(json!({ "request_id": request })))
            .await?;
        }
        ok(rhea
            .call("new")
            .args_json(json!({ "owner_id": sandbox_root.id(), "boost_farm_id": sandbox_root.id(), "burrowland_id": sandbox_root.id(), "exchange_fee": 4, "referral_fee": 1 }))
            .transact()
            .await?)
        .await?;

        // Tredio under tredio.near, with the init arguments contracts/scripts/deploy.sh sends on mainnet.
        let c = &p["contracts"];
        let pr = &p["params"];
        let names = |role: &str| id(&c[role]).as_str().split('.').next().expect("name").to_string();
        let registry = deploy(&root, &names("registry"), "tredio_registry", 10).await?;
        let outcomes = deploy(&root, &names("outcomes"), "tredio_outcomes", 10).await?;
        let book = deploy(&root, &names("book"), "tredio_book", 10).await?;
        let perps = deploy(&root, &names("perps"), "tredio_perps", 10).await?;
        let curation = deploy(&root, &names("curation"), "tredio_curation", 10).await?;
        let coins = deploy(&root, &names("coins"), "tredio_coins", 30).await?;
        let accounts = deploy(&root, &names("accounts"), "tredio_accounts", 10).await?;
        for (contract, role) in [
            (&registry, "registry"),
            (&outcomes, "outcomes"),
            (&book, "book"),
            (&perps, "perps"),
            (&curation, "curation"),
            (&coins, "coins"),
            (&accounts, "accounts"),
        ] {
            assert_eq!(contract.id(), &id(&c[role]), "{role} has its mainnet id");
        }
        let coin_hash = publish_global_as(&root, "coin-publisher", &wasm("tredio_coin")).await?;
        let account_hash = publish_global_as(&root, "account-publisher", &wasm("tredio_account")).await?;

        let oracle_key = ed25519_dalek::SigningKey::from_bytes(&[23u8; 32]);
        let oracle_pk =
            format!("ed25519:{}", bs58::encode(oracle_key.verifying_key().as_bytes()).into_string());
        let r = root.id();
        let t = treasury.id();
        ok(registry
            .call("new")
            .args_json(json!({
                "owner": r,
                "oracle": { "tee_signer": { "public_key": oracle_pk } },
                "params": {
                    "staleness_limit": 900, "max_move_bps": 5000, "attention_floor": 5_000_000, "cooling_window": 3600, "retire_window": 7200,
                    "stale_retire_window": 21600, "settlement_tolerance": 900, "max_report_age": 600, "max_future_skew": 60
                }
            }))
            .transact()
            .await?)
        .await?;
        ok(outcomes.call("new").args_json(json!({ "owner": r, "usdc": usdc.id(), "registry": registry.id(), "test_window": pr["outcomeTestWindow"] })).transact().await?).await?;
        ok(book
            .call("new")
            .args_json(json!({ "owner": r, "usdc": usdc.id(), "outcomes": outcomes.id(), "registry": registry.id(), "treasury": t, "taker_fee_bps": pr["bookTakerFeeBps"] }))
            .transact()
            .await?)
        .await?;
        ok(curation
            .call("new")
            .args_json(json!({ "owner": r, "usdc": usdc.id(), "treasury": t }))
            .transact()
            .await?)
        .await?;
        ok(perps
            .call("new")
            .args_json(json!({ "owner": r, "usdc": usdc.id(), "registry": registry.id(), "curation": curation.id(), "treasury": t, "max_oi_per_side": pr["maxOpenInterestPerSide"] }))
            .transact()
            .await?)
        .await?;
        ok(coins
            .call("new")
            .args_json(json!({
                "owner": r, "usdc": usdc.id(), "registry": registry.id(), "curation": curation.id(), "treasury": t, "exchange": rhea.id(),
                "pool_fee_bps": 30, "coin_code": coin_hash, "base_virtual_quote": pr["curveBaseVirtualQuote"], "graduation_reserve": pr["curveGraduationReserve"]
            }))
            .transact()
            .await?)
        .await?;
        ok(accounts
            .call("new")
            .args_json(json!({
                "owner": r, "network": "mainnet", "account_code": account_hash,
                "protocol": {
                    "usdc": usdc.id(), "registry": registry.id(), "outcomes": outcomes.id(), "book": book.id(), "perps": perps.id(),
                    "coins": coins.id(), "curation": curation.id(), "signer": p["external"]["chainSignatures"], "factory": accounts.id()
                }
            }))
            .transact()
            .await?)
        .await?;

        // Wiring, as the deploy script does it.
        run(root.call(registry.id(), "add_consumer").args_json(json!({ "account_id": outcomes.id() })))
            .await?;
        for source in [perps.id(), coins.id()] {
            run(root.call(curation.id(), "add_source").args_json(json!({ "account_id": source }))).await?;
        }
        let bounds: Value = usdc.view("storage_balance_bounds").await?.json()?;
        let usdc_storage = NearToken::from_yoctonear(u128_of(&bounds["min"]));
        for holder in [
            outcomes.id(),
            book.id(),
            perps.id(),
            curation.id(),
            coins.id(),
            treasury.id(),
            rhea.id(),
            alice.id(),
            bob.id(),
            mm.id(),
            keeper.id(),
        ] {
            run(root
                .call(usdc.id(), "storage_deposit")
                .args_json(json!({ "account_id": holder, "registration_only": true }))
                .deposit(usdc_storage))
            .await?;
        }
        run(root
            .call(book.id(), "storage_deposit")
            .args_json(json!({ "account_id": treasury.id() }))
            .deposit(NearToken::from_millinear(50)))
        .await?;
        run(root
            .call(outcomes.id(), "storage_deposit")
            .args_json(json!({ "account_id": book.id() }))
            .deposit(NearToken::from_near(1)))
        .await?;
        run(root.call(coins.id(), "prepare_exchange").deposit(NearToken::from_millinear(110))).await?;

        // Real USDC for the traders, minted the way Circle mints it.
        for (who, amount) in [(&alice, 10_000), (&bob, 1_000), (&mm, 10_000)] {
            run(sandbox_root
                .call(usdc.id(), "mint")
                .args_json(json!({ "to": who.id(), "amount": (amount * USDC).to_string() })))
            .await?;
            for contract in [outcomes.id(), book.id(), perps.id()] {
                run(who
                    .call(contract, "storage_deposit")
                    .args_json(json!({}))
                    .deposit(NearToken::from_millinear(200)))
                .await?;
            }
        }
        run(mm
            .call(usdc.id(), "ft_transfer_call")
            .args_json(json!({ "receiver_id": perps.id(), "amount": (5_000 * USDC).to_string(), "msg": "\"deposit_pool\"" }))
            .deposit(NearToken::from_yoctonear(1)))
        .await?;

        Ok(Self {
            worker,
            usdc,
            rhea,
            root,
            registry,
            outcomes,
            perps,
            curation,
            coins,
            accounts,
            alice,
            bob,
            keeper,
            oracle_key,
            run_id: std::cell::Cell::new(0),
        })
    }

    async fn report(&self, new_trends: Value, updates: Value) -> Result<()> {
        use ed25519_dalek::Signer;
        use sha2::{Digest, Sha256};
        let run_id = self.run_id.get() + 1;
        self.run_id.set(run_id);
        let report = json!({ "run_id": run_id, "observed_at": now(&self.worker).await?, "new_trends": new_trends, "updates": updates, "marks": [] }).to_string();
        let signature = STANDARD.encode(self.oracle_key.sign(&Sha256::digest(report.as_bytes())).to_bytes());
        run(self
            .root
            .call(self.registry.id(), "submit_report")
            .args_json(json!({ "report_json": report, "signature": signature })))
        .await?;
        Ok(())
    }

    async fn list(&self, trend: &str, index: u64) -> Result<()> {
        let listing = json!([{ "identifier": trend, "asset_class": "topic", "index": index, "surfacer": self.bob.id(), "smart_money_confirmed": false, "review_hash": null, "asset": null }]);
        self.report(listing, json!([])).await
    }

    async fn usdc_of(&self, who: &AccountId) -> Result<u128> {
        let v: String =
            self.usdc.view("ft_balance_of").args_json(json!({ "account_id": who })).await?.json()?;
        Ok(v.parse()?)
    }

    async fn pay(&self, who: &Account, receiver: &AccountId, amount: u128, msg: Value) -> Result<Done> {
        run(who
            .call(self.usdc.id(), "ft_transfer_call")
            .args_json(
                json!({ "receiver_id": receiver, "amount": amount.to_string(), "msg": msg.to_string() }),
            )
            .deposit(NearToken::from_yoctonear(1)))
        .await
    }
}

#[tokio::test]
async fn the_mainnet_plan_runs_on_mainnet_usdc_and_rhea() -> Result<()> {
    let m = Mainnet::new().await?;

    // Outcomes: the mainnet windows only (no test window), sets minted and redeemed in Circle's USDC.
    let windows: Vec<u64> = m.outcomes.view("windows").await?.json()?;
    assert_eq!(windows, vec![86_400, 604_800], "mainnet opens 24-hour and 7-day series only");
    m.list("topic:mainnet", 50 * POINT).await?;
    let series: Option<u64> = run(m
        .root
        .call(m.outcomes.id(), "open_series")
        .args_json(json!({ "trend": "topic:mainnet", "window": 86_400 })))
    .await?
    .json()?;
    let series = series.expect("series opened");
    let before = m.usdc_of(m.alice.id()).await?;
    m.pay(&m.alice, m.outcomes.id(), 100 * USDC, json!({ "mint": { "series": series, "receiver": null } }))
        .await?;
    assert_eq!(m.usdc_of(m.alice.id()).await?, before - 100 * USDC);
    let up: String = m
        .outcomes
        .view("mt_balance_of")
        .args_json(json!({ "account_id": m.alice.id(), "token_id": format!("{series}:up") }))
        .await?
        .json()?;
    assert_eq!(up, (100 * USDC).to_string());
    run(m
        .alice
        .call(m.outcomes.id(), "redeem_sets")
        .args_json(json!({ "series": series, "amount": (40 * USDC).to_string() })))
    .await?;
    assert_eq!(m.usdc_of(m.alice.id()).await?, before - 60 * USDC, "redeemed sets pay back native USDC");

    // Perps: open and close against the pool the market maker funded.
    let open = json!({ "open": { "trend": "topic:mainnet", "is_long": true, "leverage_bps": 20_000, "acceptable_index": 60 * POINT, "deadline": null, "owner": null } });
    m.pay(&m.alice, m.perps.id(), 100 * USDC, open).await?;
    let positions: Vec<Value> =
        m.perps.view("positions_of").args_json(json!({ "account_id": m.alice.id() })).await?.json()?;
    assert_eq!(positions.len(), 1);
    m.report(json!([]), json!([{ "id": "topic:mainnet", "index": 55 * POINT }])).await?;
    let before = m.usdc_of(m.alice.id()).await?;
    run(m
        .alice
        .call(m.perps.id(), "close")
        .args_json(json!({ "id": positions[0]["id"], "acceptable_index": 0 })))
    .await?;
    let gained = m.usdc_of(m.alice.id()).await? - before;
    assert!(gained > 115 * USDC && gained < 120 * USDC, "2x on +10% pays about 118 USDC: {gained}");
    let earned: String =
        m.curation.view("claimable_of").args_json(json!({ "account_id": m.bob.id() })).await?.json()?;
    assert!(earned.parse::<u128>()? > 0, "the surfacer earns the curation share");

    // A trend coin: bought up to the graduation reserve, then graduated by the keeper into a pool on
    // mainnet's Rhea code, where it trades.
    run(m.root.call(m.coins.id(), "create_curve").args_json(json!({ "trend": "topic:mainnet" }))).await?;
    let curve = || async {
        m.coins.view("get_curve").args_json(json!({ "trend": "topic:mainnet" })).await?.json::<Value>()
    };
    let coin = id(&curve().await?["coin"]);
    for buy in 0.. {
        let c = curve().await?;
        if c["stage"] != "open" {
            break;
        }
        assert!(buy < 40, "the curve should fill in a few dozen buys");
        // Each buy stays under the curve's 20% price impact cap: about 9% of the quote side.
        let size = (u128_of(&c["virtual_quote"]) + u128_of(&c["reserve"])) * 9 / 100;
        m.pay(
            &m.alice,
            m.coins.id(),
            size,
            json!({ "buy": { "trend": "topic:mainnet", "min_out": "1", "receiver": null } }),
        )
        .await?;
    }
    assert_eq!(curve().await?["stage"], "ready");
    for step in 0.. {
        let c = curve().await?;
        if c["stage"] == "graduated" {
            break;
        }
        assert!(step < 8, "graduation takes a handful of steps: {c}");
        run(m.keeper.call(m.coins.id(), "graduate").args_json(json!({ "trend": "topic:mainnet" }))).await?;
    }
    let c = curve().await?;
    let pool_id = c["pool_id"].as_u64().expect("pool id");
    let pool: Value = m.rhea.view("get_pool").args_json(json!({ "pool_id": pool_id })).await?.json()?;
    let tokens: Vec<String> = serde_json::from_value(pool["token_account_ids"].clone())?;
    let amounts: Vec<String> = serde_json::from_value(pool["amounts"].clone())?;
    let usdc_in_pool: u128 =
        amounts[tokens.iter().position(|t| t == m.usdc.id().as_str()).expect("USDC in the pool")].parse()?;
    assert!(tokens.contains(&coin.to_string()));
    assert!(
        usdc_in_pool >= u128_of(&plan()["params"]["curveGraduationReserve"]) * 9 / 10,
        "the reserve moved into the pool: {usdc_in_pool}"
    );
    eprintln!("graduated into Rhea pool {pool_id}: {pool}");

    // Anyone can now swap on Rhea: bob buys the coin there with USDC.
    run(m
        .bob
        .call(m.rhea.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_millinear(100)))
    .await?;
    run(m.bob.call(&coin, "storage_deposit").args_json(json!({})).deposit(NearToken::from_millinear(10)))
        .await?;
    let swap = json!({ "actions": [{ "pool_id": pool_id, "token_in": m.usdc.id(), "token_out": coin, "amount_in": (10 * USDC).to_string(), "min_amount_out": "1" }] });
    m.pay(&m.bob, m.rhea.id(), 10 * USDC, swap).await?;
    let coins_bought: String =
        m.worker.view(&coin, "ft_balance_of").args_json(json!({ "account_id": m.bob.id() })).await?.json()?;
    assert!(coins_bought.parse::<u128>()? > 0, "the graduated coin trades on Rhea");

    // A passkey account on network `mainnet`: created by the factory, it registers with native
    // USDC, trades through its session, and has no faucet.
    let pk = Passkey::new(77);
    let account: AccountId =
        m.accounts.view("account_id_of").args_json(json!({ "owner_key": pk.public_hex() })).await?.json()?;
    let session = SecretKey::from_seed(KeyType::ED25519, "tredio-mainnet-session");
    let request = json!({
        "account": account, "network": "mainnet", "nonce": 1, "created_at": now(&m.worker).await? - 60,
        "actions": [{ "add_session": {
            "public_key": session.public_key(), "label": "web", "scope": { "outcomes": true, "perps": true, "hyperliquid": false },
            "expires_at": now(&m.worker).await? + 86_400, "daily_limit": (100 * USDC).to_string(), "gas_key": false, "gas_funding": "0"
        } }]
    })
    .to_string();
    run(m.root
        .call(m.accounts.id(), "create_account")
        .args_json(json!({ "owner_key": pk.public_hex(), "first_request": request, "first_proof": pk.prove(&request) }))
        .deposit(NearToken::from_millinear(500)))
    .await?;
    let network: String = m.worker.view(&account, "network").await?.json()?;
    assert_eq!(network, "mainnet");
    let registered: Option<Value> =
        m.usdc.view("storage_balance_of").args_json(json!({ "account_id": account })).await?.json()?;
    assert!(registered.is_some(), "the account registered itself with native USDC");
    run(m
        .alice
        .call(m.usdc.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": account, "amount": (50 * USDC).to_string() }))
        .deposit(NearToken::from_yoctonear(1)))
    .await?;
    let user = Account::from_secret_key(account.clone(), session, &m.worker);
    let tgas = near_workspaces::types::Gas::from_tgas(300);
    let faucet = user
        .call(&account, "session_call")
        .args_json(json!({ "action": "faucet" }))
        .gas(tgas)
        .transact()
        .await?;
    assert!(faucet.is_failure(), "no faucet on mainnet");
    ok(user
        .call(&account, "session_call")
        .args_json(
            json!({ "action": { "mint_sets": { "series": series, "amount": (20 * USDC).to_string() } } }),
        )
        .gas(tgas)
        .transact()
        .await?)
    .await?;
    let up: String = m
        .outcomes
        .view("mt_balance_of")
        .args_json(json!({ "account_id": account, "token_id": format!("{series}:up") }))
        .await?
        .json()?;
    assert_eq!(up, (20 * USDC).to_string(), "the session minted sets with native USDC");
    Ok(())
}
