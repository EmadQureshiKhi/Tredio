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
//! The relayer pays it; anyone may call it with their own deposit.

use near_sdk::json_types::{Base58CryptoHash, Base64VecU8};
use near_sdk::serde_json::{self, json};
use near_sdk::universal_state_init::{UniversalStateInit, UniversalStateInitV1};
use near_sdk::{env, near, require, AccountId, Gas, GlobalContractId, NearToken, PanicOnDefault, Promise};
use tredio_common::account_state::{AccountCore, Protocol};

/// Below this the new account could not cover registrations and a session.
pub const MIN_DEPOSIT: NearToken = NearToken::from_millinear(50);
const GAS_BOOTSTRAP: Gas = Gas::from_tgas(60);
const GAS_FIRST_REQUEST: Gas = Gas::from_tgas(60);
const GAS_AFTER: Gas = Gas::from_tgas(10);

#[near(event_json(standard = "tredio-accounts"))]
pub enum Event<'a> {
    #[event_version("1.0.0")]
    AccountCreated { account: &'a AccountId, owner_key: &'a str, funded: String },
    #[event_version("1.0.0")]
    AccountCreationFailed { account: &'a AccountId },
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

    /// New accounts use this code hash from now on; existing accounts upgrade with their passkey.
    pub fn set_account_code(&mut self, account_code: Base58CryptoHash) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
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
        p.then(Self::ext(env::current_account_id()).with_static_gas(GAS_AFTER).on_created(
            account,
            owner_key,
            deposit.exact_amount_display(),
        ))
    }

    #[private]
    pub fn on_created(&mut self, account: AccountId, owner_key: String, funded: String) -> AccountId {
        if tredio_common::promise_succeeded() {
            self.created += 1;
            Event::AccountCreated { account: &account, owner_key: &owner_key, funded }.emit();
        } else {
            Event::AccountCreationFailed { account: &account }.emit();
        }
        account
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

    fn hex_bytes(h: &str) -> Vec<u8> {
        (0..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap()).collect()
    }
}
