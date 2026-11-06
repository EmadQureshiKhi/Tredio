//! # Testnet USDC
//!
//! A 6-decimal NEP-141 token that stands in for USDC on NEAR testnet, where native USDC does not
//! exist. Anyone can draw from the faucet once per cooldown; minters (the backend faucet) can
//! mint to accounts that have not registered storage yet. Mainnet deployments use native USDC
//! (`17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`) and never this contract.

use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{FungibleToken, FungibleTokenCore, FungibleTokenResolver};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::U128;
use near_sdk::store::{IterableSet, LookupMap};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue};
use tredio_common::now_secs;

const ICON: &str = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='16' fill='%232775CA'/%3E%3Ctext x='16' y='21' font-family='Arial' font-size='13' font-weight='700' fill='white' text-anchor='middle'%3E$%3C/text%3E%3C/svg%3E";

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Token,
    Minters,
    LastDrip,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Usdc {
    owner: AccountId,
    token: FungibleToken,
    minters: IterableSet<AccountId>,
    last_drip: LookupMap<AccountId, u64>,
    /// Raw amount the public faucet hands out per drip.
    drip_amount: u128,
    /// Seconds between drips for one account.
    drip_cooldown: u64,
}

#[near]
impl Usdc {
    #[init]
    pub fn new(owner: AccountId, drip_amount: U128, drip_cooldown: u64) -> Self {
        require!(drip_amount.0 > 0 && drip_amount.0 <= 1_000_000 * 1_000_000, "bad drip amount");
        Self {
            owner,
            token: FungibleToken::new(Key::Token),
            minters: IterableSet::new(Key::Minters),
            last_drip: LookupMap::new(Key::LastDrip),
            drip_amount: drip_amount.0,
            drip_cooldown,
        }
    }

    /// Sends the drip amount to the caller (registering its storage from the contract balance),
    /// at most once per cooldown per account. Returns the amount minted.
    pub fn faucet(&mut self) -> U128 {
        let account = env::predecessor_account_id();
        let now = now_secs();
        if let Some(last) = self.last_drip.get(&account) {
            require!(now >= last + self.drip_cooldown, "faucet cooldown");
        }
        self.last_drip.insert(account.clone(), now);
        self.mint_to(&account, self.drip_amount, "faucet");
        U128(self.drip_amount)
    }

    /// Mints `amount` to `account_id`. Minters only (the backend faucet).
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(self.minters.contains(&env::predecessor_account_id()), "minter only");
        require!(amount.0 > 0 && amount.0 <= 100_000 * 1_000_000, "bad amount");
        self.mint_to(&account_id, amount.0, "mint");
    }

    #[payable]
    pub fn add_minter(&mut self, account_id: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        // A full-access key only: a function-call key cannot attach the yoctoNEAR.
        near_sdk::assert_one_yocto();
        self.minters.insert(account_id);
    }

    #[payable]
    pub fn remove_minter(&mut self, account_id: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        // A full-access key only: a function-call key cannot attach the yoctoNEAR.
        near_sdk::assert_one_yocto();
        self.minters.remove(&account_id);
    }

    pub fn faucet_info(&self, account_id: Option<AccountId>) -> (U128, u64, Option<u64>) {
        let next = account_id.and_then(|a| self.last_drip.get(&a).map(|t| t + self.drip_cooldown));
        (U128(self.drip_amount), self.drip_cooldown, next)
    }

    pub fn minters(&self) -> Vec<AccountId> {
        self.minters.iter().cloned().collect()
    }

    fn mint_to(&mut self, account: &AccountId, amount: u128, memo: &str) {
        if !self.token.accounts.contains_key(account) {
            self.token.internal_register_account(account);
        }
        self.token.internal_deposit(account, amount);
        FtMint { owner_id: account, amount: U128(amount), memo: Some(memo) }.emit();
    }
}

#[near]
impl FungibleTokenCore for Usdc {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Usdc {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used, _burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used.into()
    }
}

#[near]
impl StorageManagement for Usdc {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Usdc {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "USD Coin (Tredio testnet)".to_string(),
            symbol: "USDC".to_string(),
            icon: Some(ICON.to_string()),
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn ctx(who: &str, secs: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(who.parse().unwrap())
            .block_timestamp(secs * 1_000_000_000)
            .build());
    }

    #[test]
    fn faucet_respects_the_cooldown() {
        ctx("owner.testnet", 1_000);
        let mut c = Usdc::new("owner.testnet".parse().unwrap(), U128(1_000_000_000), 3_600);
        ctx("alice.testnet", 1_000);
        assert_eq!(c.faucet().0, 1_000_000_000);
        assert_eq!(c.ft_balance_of("alice.testnet".parse().unwrap()).0, 1_000_000_000);
        ctx("alice.testnet", 4_600);
        c.faucet();
        assert_eq!(c.ft_total_supply().0, 2_000_000_000);
        assert_eq!(c.faucet_info(Some("alice.testnet".parse().unwrap())).2, Some(8_200));
    }

    #[test]
    #[should_panic(expected = "faucet cooldown")]
    fn faucet_twice_too_soon() {
        ctx("owner.testnet", 1_000);
        let mut c = Usdc::new("owner.testnet".parse().unwrap(), U128(1_000_000), 3_600);
        ctx("alice.testnet", 1_000);
        c.faucet();
        ctx("alice.testnet", 2_000);
        c.faucet();
    }

    #[test]
    fn minters_mint_and_others_cannot() {
        ctx("owner.testnet", 1_000);
        let mut c = Usdc::new("owner.testnet".parse().unwrap(), U128(1_000_000), 3_600);
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id("owner.testnet".parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(1))
            .build());
        c.add_minter("faucet.testnet".parse().unwrap());
        ctx("faucet.testnet", 1_000);
        c.mint("bob.testnet".parse().unwrap(), U128(5_000_000));
        assert_eq!(c.ft_balance_of("bob.testnet".parse().unwrap()).0, 5_000_000);
        ctx("mallory.testnet", 1_000);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.mint("mallory.testnet".parse().unwrap(), U128(1))
        }));
        assert!(r.is_err());
    }
}
