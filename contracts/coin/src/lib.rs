//! # Tredio trend coin
//!
//! One 18-decimal NEP-141 per trend, living at `<trend slug>.coins.<root>`. The code is published
//! once as a global contract and every coin account references it by hash, so a coin costs only
//! its own state. Only the minter (the coins factory) mints, and it can burn only coins it holds
//! (what sellers sent back to the curve). New holders are registered on mint from the deposit
//! the minter attaches.

use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{FungibleToken, FungibleTokenCore, FungibleTokenResolver};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::U128;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise, PromiseOrValue,
};

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Token,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Coin {
    minter: AccountId,
    token: FungibleToken,
    name: String,
    symbol: String,
    icon: Option<String>,
    trend: String,
}

#[near]
impl Coin {
    #[init]
    pub fn new(minter: AccountId, trend: String, name: String, symbol: String, icon: Option<String>) -> Self {
        require!(
            !name.is_empty() && name.len() <= 64 && !symbol.is_empty() && symbol.len() <= 16,
            "bad metadata"
        );
        Self { minter, token: FungibleToken::new(Key::Token), name, symbol, icon, trend }
    }

    /// Mints to `account_id`, registering it with the attached deposit when needed; any unused
    /// deposit goes back to the minter.
    #[payable]
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(env::predecessor_account_id() == self.minter, "minter only");
        let mut deposit = env::attached_deposit().as_yoctonear();
        if !self.token.accounts.contains_key(&account_id) {
            let cost = self.token.storage_balance_bounds().min.as_yoctonear();
            require!(deposit >= cost, "attach storage for a new holder");
            deposit -= cost;
            self.token.internal_register_account(&account_id);
        }
        self.token.internal_deposit(&account_id, amount.0);
        FtMint { owner_id: &account_id, amount, memo: None }.emit();
        if deposit > 0 {
            Promise::new(self.minter.clone()).transfer(NearToken::from_yoctonear(deposit)).detach();
        }
    }

    /// Burns coins the minter holds.
    pub fn burn(&mut self, amount: U128) {
        let minter = env::predecessor_account_id();
        require!(minter == self.minter, "minter only");
        self.token.internal_withdraw(&minter, amount.0);
        FtBurn { owner_id: &minter, amount, memo: Some("curve sell") }.emit();
    }

    pub fn trend(&self) -> String {
        self.trend.clone()
    }

    pub fn minter(&self) -> AccountId {
        self.minter.clone()
    }
}

#[near]
impl FungibleTokenCore for Coin {
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
impl FungibleTokenResolver for Coin {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used, _burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used.into()
    }
}

#[near]
impl StorageManagement for Coin {
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
impl FungibleTokenMetadataProvider for Coin {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: self.name.clone(),
            symbol: self.symbol.clone(),
            icon: self.icon.clone(),
            reference: None,
            reference_hash: None,
            decimals: 18,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn ctx(who: &str, deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(who.parse().unwrap())
            .attached_deposit(deposit)
            .build());
    }

    #[test]
    fn minter_mints_and_burns_its_own() {
        ctx("coins.testnet", NearToken::from_yoctonear(0));
        let mut c = Coin::new(
            "coins.testnet".parse().unwrap(),
            "topic:a".into(),
            "Tredio topic:a".into(),
            "TOPIC-A".into(),
            None,
        );
        ctx("coins.testnet", NearToken::from_millinear(10));
        c.mint("alice.testnet".parse().unwrap(), U128(5));
        c.mint("coins.testnet".parse().unwrap(), U128(7));
        assert_eq!(c.ft_balance_of("alice.testnet".parse().unwrap()).0, 5);
        ctx("coins.testnet", NearToken::from_yoctonear(0));
        c.burn(U128(7));
        assert_eq!(c.ft_total_supply().0, 5);
        assert_eq!(c.ft_metadata().decimals, 18);
    }

    #[test]
    #[should_panic(expected = "minter only")]
    fn others_cannot_mint() {
        ctx("coins.testnet", NearToken::from_yoctonear(0));
        let mut c = Coin::new(
            "coins.testnet".parse().unwrap(),
            "topic:a".into(),
            "Tredio topic:a".into(),
            "TOPIC-A".into(),
            None,
        );
        ctx("mallory.testnet", NearToken::from_millinear(10));
        c.mint("mallory.testnet".parse().unwrap(), U128(5));
    }

    #[test]
    #[should_panic(expected = "attach storage for a new holder")]
    fn new_holders_need_storage() {
        ctx("coins.testnet", NearToken::from_yoctonear(0));
        let mut c = Coin::new(
            "coins.testnet".parse().unwrap(),
            "topic:a".into(),
            "Tredio topic:a".into(),
            "TOPIC-A".into(),
            None,
        );
        c.mint("alice.testnet".parse().unwrap(), U128(5));
    }
}
