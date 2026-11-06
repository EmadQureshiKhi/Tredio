//! # Tredio accounts factory
//!
//! Creates user accounts as NEP-655 universal accounts (`0u...`). The address is the SHA3-256
//! of the account's initial state: the account contract by global code hash (immutable, so we
//! can never swap a user's code), its state with the passkey's public key and the protocol
//! contracts, and no access keys. The same passkey always maps to the same address, which the
//! app computes before anything exists on chain with `account_id_of`.
//!
//! `create_account` sends one batch to that address: the state init, the attached NEAR (storage,
//! registrations and the first session's gas), `bootstrap`, and optionally the passkey-signed
//! request that adds the first session, so one Face ID prompt yields a funded, trading account.
//! The relayer pays it; anyone may call it with their own deposit. If the batch fails (a bad
//! first request, an account that exists and cannot be topped up), the runtime refunds the
//! deposit to this factory, and `on_created` sends it back to the caller.
//!
//! The code hash every account is born with is part of its address, so it is fixed once the
//! first account exists: accounts move to newer code with their passkey's `upgrade` action
//! (new accounts can include it in their first request), and every passkey keeps its address.

use near_sdk::json_types::{Base58CryptoHash, Base64VecU8, U128};
use near_sdk::serde_json::{self, json};
use near_sdk::universal_state_init::{UniversalStateInit, UniversalStateInitV1};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, GlobalContractId, IntoStorageKey, NearToken,
    PanicOnDefault, Promise,
};
use tredio_common::account_state::{AccountCore, Protocol};

/// Below this the new account could not cover registrations and a session.
pub const MIN_DEPOSIT: NearToken = NearToken::from_millinear(50);
const GAS_BOOTSTRAP: Gas = Gas::from_tgas(60);
const GAS_FIRST_REQUEST: Gas = Gas::from_tgas(60);
const GAS_AFTER: Gas = Gas::from_tgas(10);
const GAS_CHECK: Gas = Gas::from_tgas(5);

#[near(event_json(standard = "tredio-accounts"))]
pub enum Event<'a> {
    #[event_version("1.0.0")]
    AccountCreated { account: &'a AccountId, owner_key: &'a str, funded: String },
    #[event_version("1.0.0")]
    AccountCreationFailed { account: &'a AccountId },
    #[event_version("1.0.0")]
    DepositRefunded { account: &'a AccountId, payer: &'a AccountId, amount: U128, claimable: bool },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Accounts {
    owner: AccountId,
    network: String,
    protocol: Protocol,
    account_code: Base58CryptoHash,
    created: u64,
}

#[near]
impl Accounts {
    #[init]
    pub fn new(
        owner: AccountId,
        network: String,
        protocol: Protocol,
        account_code: Base58CryptoHash,
    ) -> Self {
        require!(network == "testnet" || network == "mainnet", "network must be testnet or mainnet");
        Self { owner, network, protocol, account_code, created: 0 }
    }

    /// Sets the code hash accounts are born with, before the first account exists. Every
    /// address commits to it, so changing it later would move every passkey to a new, empty
    /// address; accounts upgrade with their passkey instead.
    pub fn set_account_code(&mut self, account_code: Base58CryptoHash) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(
            self.created == 0,
            "accounts exist: their addresses commit to this code hash, so upgrade them with their passkey instead"
        );
        self.account_code = account_code;
    }

    pub fn set_protocol(&mut self, protocol: Protocol) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        self.protocol = protocol;
    }

    /// The universal account a passkey (`p256:<base58>` or hex, 33-byte compressed) maps to.
    pub fn account_id_of(&self, owner_key: String) -> AccountId {
        self.state_init(&owner_key).derive_account_id()
    }

    /// The raw state init behind `account_id_of`, for clients that want to check it.
    pub fn state_init_of(&self, owner_key: String) -> Base64VecU8 {
        Base64VecU8(self.state_init(&owner_key).to_raw().0)
    }

    pub fn config(&self) -> (String, Protocol, Base58CryptoHash, u64) {
        (self.network.clone(), self.protocol.clone(), self.account_code, self.created)
    }

    /// Creates (or tops up) the account of `owner_key` with the attached NEAR, registers it with
    /// the protocol, and runs `first_request` (a passkey-signed owner request, usually adding
    /// the first session) if given.
    #[payable]
    pub fn create_account(
        &mut self,
        owner_key: String,
        first_request: Option<String>,
        first_proof: Option<serde_json::Value>,
    ) -> Promise {
        let deposit = env::attached_deposit();
        require!(deposit >= MIN_DEPOSIT, "attach at least 0.05 NEAR");
        require!(first_request.is_some() == first_proof.is_some(), "request and proof go together");
        let init = self.state_init(&owner_key);
        let account = init.derive_account_id();
        let mut p = Promise::new(account.clone())
            .universal_state_init(init, NearToken::from_yoctonear(0))
            .transfer(deposit)
            .function_call("bootstrap", b"{}".to_vec(), NearToken::from_yoctonear(0), GAS_BOOTSTRAP);
        if let (Some(request), Some(proof)) = (first_request, first_proof) {
            p = p.function_call(
                "owner_execute",
                json!({ "request": request, "proof": proof }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_FIRST_REQUEST,
            );
        }
        // The batch's result is its last action's. Ending with a plain view keeps it independent
        // of whatever the first request returns (a call it makes can fail later while the
        // account exists and holds the deposit): `on_created` then sees a failure only when the
        // whole batch was reverted and the deposit came back here.
        p = p.function_call("bootstrapped", b"{}".to_vec(), NearToken::from_yoctonear(0), GAS_CHECK);
        p.then(Self::ext(env::current_account_id()).with_static_gas(GAS_AFTER).on_created(
            account,
            owner_key,
            env::predecessor_account_id(),
            U128(deposit.as_yoctonear()),
        ))
    }

    /// Counts a created account, or, when the batch failed (the runtime then refunded the
    /// deposit to this factory), sends the deposit back to whoever paid it.
    #[private]
    pub fn on_created(
        &mut self,
        account: AccountId,
        owner_key: String,
        payer: AccountId,
        deposit: U128,
    ) -> AccountId {
        let amount = NearToken::from_yoctonear(deposit.0);
        if tredio_common::promise_succeeded() {
            self.created += 1;
            Event::AccountCreated {
                account: &account,
                owner_key: &owner_key,
                funded: amount.exact_amount_display(),
            }
            .emit();
        } else {
            Event::AccountCreationFailed { account: &account }.emit();
            // The runtime's refund of the failed batch may land after this callback: if the
            // factory cannot cover the deposit yet, the payer claims it with `claim_refund`.
            let free = env::account_balance()
                .as_yoctonear()
                .saturating_sub(env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear());
            if free >= deposit.0 + REFUND_RESERVE.as_yoctonear() {
                Event::DepositRefunded {
                    account: &account,
                    payer: &payer,
                    amount: deposit,
                    claimable: false,
                }
                .emit();
                Promise::new(payer).transfer(amount).detach();
            } else {
                Event::DepositRefunded { account: &account, payer: &payer, amount: deposit, claimable: true }
                    .emit();
                set_refund(&payer, stored_refund(&payer) + deposit.0);
            }
        }
        account
    }

    /// Sends the caller the deposits of its failed creations that could not be refunded at once.
    pub fn claim_refund(&mut self) -> Promise {
        let payer = env::predecessor_account_id();
        let amount = stored_refund(&payer);
        require!(amount > 0, "nothing to refund");
        set_refund(&payer, 0);
        Promise::new(payer).transfer(NearToken::from_yoctonear(amount))
    }

    /// Deposits `account_id` can claim with `claim_refund`.
    pub fn refund_of(&self, account_id: AccountId) -> U128 {
        U128(stored_refund(&account_id))
    }
}

/// Liquid NEAR the factory keeps when refunding at once.
const REFUND_RESERVE: NearToken = NearToken::from_millinear(100);

#[derive(BorshStorageKey)]
#[near]
enum Key {
    /// Deposits to refund, per payer. Kept outside the root state so a factory deployed before
    /// it reads its state unchanged.
    Refunds,
}

fn refund_key(payer: &AccountId) -> Vec<u8> {
    let mut key = Key::Refunds.into_storage_key();
    key.extend_from_slice(payer.as_bytes());
    key
}

fn stored_refund(payer: &AccountId) -> u128 {
    env::storage_read(&refund_key(payer))
        .and_then(|b| <[u8; 16]>::try_from(b.as_slice()).ok())
        .map_or(0, u128::from_le_bytes)
}

fn set_refund(payer: &AccountId, amount: u128) {
    if amount == 0 {
        env::storage_remove(&refund_key(payer));
    } else {
        env::storage_write(&refund_key(payer), &amount.to_le_bytes());
    }
}

impl Accounts {
    fn state_init(&self, owner_key: &str) -> UniversalStateInit {
        let key = parse_p256_key(owner_key);
        let core = AccountCore::new(key, self.network.clone(), self.protocol.clone());
        let state = borsh::to_vec(&core).unwrap_or_else(|_| env::panic_str("state encoding failed"));
        UniversalStateInit::V1(
            UniversalStateInitV1::default()
                .with_code(GlobalContractId::CodeHash(self.account_code.into()))
                .with_data_entry(b"STATE".to_vec(), state),
        )
    }
}

fn parse_p256_key(key: &str) -> Vec<u8> {
    let bytes = match key.strip_prefix("p256:") {
        Some(b58) => near_sdk::bs58::decode(b58).into_vec().unwrap_or_default(),
        None => near_sdk::bs58::decode(key).into_vec().ok().filter(|b| b.len() == 33).unwrap_or_else(|| {
            (0..key.len())
                .step_by(2)
                .filter_map(|i| u8::from_str_radix(key.get(i..i + 2)?, 16).ok())
                .collect()
        }),
    };
    require!(
        bytes.len() == 33 && (bytes[0] == 2 || bytes[0] == 3),
        "owner key must be a compressed P-256 key"
    );
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn protocol() -> Protocol {
        let a = |s: &str| -> AccountId { s.parse().unwrap() };
        Protocol {
            usdc: a("usdc.tredio.testnet"),
            registry: a("registry.tredio.testnet"),
            outcomes: a("outcomes.tredio.testnet"),
            book: a("book.tredio.testnet"),
            perps: a("perps.tredio.testnet"),
            coins: a("coins.tredio.testnet"),
            curation: a("curation.tredio.testnet"),
            signer: a("v1.signer-prod.testnet"),
            factory: a("accounts.tredio.testnet"),
        }
    }

    fn setup() -> Accounts {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id("tredio.testnet".parse().unwrap())
            .build());
        Accounts::new(
            "tredio.testnet".parse().unwrap(),
            "testnet".into(),
            protocol(),
            Base58CryptoHash::from([9u8; 32]),
        )
    }

    const KEY: &str = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";

    #[test]
    fn one_passkey_one_address() {
        let f = setup();
        let a = f.account_id_of(KEY.into());
        assert!(a.as_str().starts_with("0u") && a.as_str().len() == 54, "{a}");
        assert_eq!(a, f.account_id_of(KEY.into()));
        let b58 = format!("p256:{}", near_sdk::bs58::encode(hex_bytes(KEY)).into_string());
        assert_eq!(a, f.account_id_of(b58));
        let other = KEY.replace("c6", "c7");
        assert_ne!(a, f.account_id_of(other));
    }

    #[test]
    fn the_address_commits_to_code_and_network() {
        let mut f = setup();
        let a = f.account_id_of(KEY.into());
        f.set_account_code(Base58CryptoHash::from([8u8; 32]));
        assert_ne!(a, f.account_id_of(KEY.into()));
        let m = Accounts::new(
            "tredio.testnet".parse().unwrap(),
            "mainnet".into(),
            protocol(),
            Base58CryptoHash::from([9u8; 32]),
        );
        assert_ne!(a, m.account_id_of(KEY.into()));
    }

    #[test]
    fn the_state_init_carries_the_account_state() {
        let f = setup();
        let raw = f.state_init_of(KEY.into()).0;
        let core = AccountCore::new(hex_bytes(KEY), "testnet".into(), protocol());
        let state = borsh::to_vec(&core).unwrap();
        assert!(raw.windows(state.len()).any(|w| w == state.as_slice()));
    }

    #[test]
    #[should_panic(expected = "compressed P-256")]
    fn rejects_bad_keys() {
        setup().account_id_of("04abcd".into());
    }

    #[test]
    #[should_panic(expected = "accounts exist")]
    fn the_birth_code_is_fixed_once_accounts_exist() {
        let mut f = setup();
        f.created = 1;
        // Every passkey's address commits to this hash: changing it would strand existing users.
        f.set_account_code(Base58CryptoHash::from([8u8; 32]));
    }

    #[test]
    fn a_failed_creation_sends_the_deposit_back() {
        let mut f = setup();
        let account = f.account_id_of(KEY.into());
        testing_env!(
            VMContextBuilder::new()
                .current_account_id("accounts.tredio.testnet".parse().unwrap())
                .predecessor_account_id("accounts.tredio.testnet".parse().unwrap())
                .account_balance(NearToken::from_near(5))
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![near_sdk::PromiseResult::Failed]
        );
        let deposit = NearToken::from_millinear(400).as_yoctonear();
        f.on_created(account, KEY.into(), "relayer.testnet".parse().unwrap(), U128(deposit));
        let refund = near_sdk::test_utils::get_created_receipts()
            .into_iter()
            .find(|r| r.receiver_id.as_str() == "relayer.testnet")
            .expect("a refund to the payer");
        assert!(matches!(
            refund.actions.as_slice(),
            [near_sdk::mock::MockAction::Transfer { deposit: d, .. }] if d.as_yoctonear() == deposit
        ));
        assert_eq!(f.created, 0);
    }

    #[test]
    fn a_refund_the_factory_cannot_cover_yet_becomes_claimable() {
        let mut f = setup();
        let account = f.account_id_of(KEY.into());
        let ctx = |results| {
            testing_env!(
                VMContextBuilder::new()
                    .current_account_id("accounts.tredio.testnet".parse().unwrap())
                    .predecessor_account_id("accounts.tredio.testnet".parse().unwrap())
                    .account_balance(NearToken::from_millinear(50))
                    .build(),
                near_sdk::test_vm_config(),
                near_sdk::RuntimeFeesConfig::test(),
                Default::default(),
                results
            )
        };
        ctx(vec![near_sdk::PromiseResult::Failed]);
        let relayer: AccountId = "relayer.testnet".parse().unwrap();
        f.on_created(account, KEY.into(), relayer.clone(), U128(NearToken::from_near(2).as_yoctonear()));
        assert_eq!(f.refund_of(relayer.clone()).0, NearToken::from_near(2).as_yoctonear());
        testing_env!(VMContextBuilder::new().predecessor_account_id(relayer.clone()).build());
        let _ = f.claim_refund();
        assert_eq!(f.refund_of(relayer).0, 0);
    }

    fn hex_bytes(h: &str) -> Vec<u8> {
        (0..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap()).collect()
    }
}
