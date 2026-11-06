//! NEP-145 storage accounting shared by the contracts that keep per-user state.
//!
//! Accounts deposit NEAR to cover the entries they own (balances, orders, positions). Each entry
//! is priced at a fixed byte size per contract, so the charge is deterministic and an operation
//! that adds an entry for an account without enough deposit fails before it writes anything.

use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, IntoStorageKey, NearToken, Promise};

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct Entry {
    pub deposit: u128,
    pub entries: u32,
}

#[near]
pub struct StorageLedger {
    accounts: LookupMap<AccountId, Entry>,
    /// Bytes charged for registration itself.
    base_bytes: u64,
    /// Bytes charged per entry an account owns.
    entry_bytes: u64,
}

impl StorageLedger {
    pub fn new<S: IntoStorageKey>(prefix: S, base_bytes: u64, entry_bytes: u64) -> Self {
        Self { accounts: LookupMap::new(prefix), base_bytes, entry_bytes }
    }

    fn cost(&self, bytes: u64) -> u128 {
        bytes as u128 * env::storage_byte_cost().as_yoctonear()
    }

    pub fn min_deposit(&self) -> u128 {
        self.cost(self.base_bytes)
    }

    fn required(&self, entries: u32) -> u128 {
        self.cost(self.base_bytes + entries as u64 * self.entry_bytes)
    }

    pub fn is_registered(&self, account: &AccountId) -> bool {
        self.accounts.contains_key(account)
    }

    /// `storage_deposit`: credits `amount` to `account`, registering it if needed. With
    /// `registration_only`, an already registered account gets everything back and a new one
    /// keeps only the minimum. Returns the yoctoNEAR to refund to the caller.
    pub fn deposit(&mut self, account: &AccountId, amount: u128, registration_only: bool) -> u128 {
        let min = self.min_deposit();
        match self.accounts.get_mut(account) {
            Some(_) if registration_only => amount,
            Some(e) => {
                e.deposit += amount;
                0
            }
            None => {
                require!(amount >= min, "attached deposit is below the storage minimum");
                let keep = if registration_only { min } else { amount };
                self.accounts.insert(account.clone(), Entry { deposit: keep, entries: 0 });
                amount - keep
            }
        }
    }

    /// Withdraws up to `amount` (everything available when `None`) and returns it.
    pub fn withdraw(&mut self, account: &AccountId, amount: Option<u128>) -> u128 {
        let required = {
            let e = self.accounts.get(account).unwrap_or_else(|| env::panic_str("account not registered"));
            self.required(e.entries)
        };
        let e = self.accounts.get_mut(account).unwrap();
        let available = e.deposit.saturating_sub(required);
        let take = amount.unwrap_or(available);
        require!(take <= available, "amount exceeds the available storage balance");
        e.deposit -= take;
        take
    }

    /// Removes an account that owns no entries and returns its whole deposit.
    pub fn unregister(&mut self, account: &AccountId) -> Option<u128> {
        let e = self.accounts.get(account)?.clone();
        require!(e.entries == 0, "account still owns state; withdraw it first");
        self.accounts.remove(account);
        Some(e.deposit)
    }

    /// Charges one more entry to `account`, failing when its deposit does not cover it.
    pub fn add_entry(&mut self, account: &AccountId) {
        let need = {
            let e = self
                .accounts
                .get(account)
                .unwrap_or_else(|| env::panic_str(&format!("{account} is not registered for storage")));
            self.required(e.entries + 1)
        };
        let e = self.accounts.get_mut(account).unwrap();
        require!(e.deposit >= need, format!("{account} needs a larger storage deposit"));
        e.entries += 1;
    }

    /// Records one more entry for `account` without requiring its deposit to cover it, when it is
    /// registered (unregistered accounts' entries are the contract's). For value that must land
    /// even when the owner's storage is full, such as a failed payout coming back: the owner then
    /// cannot withdraw storage or unregister until the entry is gone.
    pub fn force_add_entry(&mut self, account: &AccountId) {
        if let Some(e) = self.accounts.get_mut(account) {
            e.entries += 1;
        }
    }

    /// Releases one entry owned by `account`.
    pub fn remove_entry(&mut self, account: &AccountId) {
        if let Some(e) = self.accounts.get_mut(account) {
            e.entries = e.entries.saturating_sub(1);
        }
    }

    pub fn balance_of(&self, account: &AccountId) -> Option<StorageBalance> {
        self.accounts.get(account).map(|e| StorageBalance {
            total: NearToken::from_yoctonear(e.deposit),
            available: NearToken::from_yoctonear(e.deposit.saturating_sub(self.required(e.entries))),
        })
    }

    pub fn bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds { min: NearToken::from_yoctonear(self.min_deposit()), max: None }
    }
}

/// Sends `yocto` back to `to` when it is not zero.
pub fn refund(to: &AccountId, yocto: u128) {
    if yocto > 0 {
        Promise::new(to.clone()).transfer(NearToken::from_yoctonear(yocto)).detach();
    }
}
