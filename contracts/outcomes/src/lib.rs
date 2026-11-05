//! # Tredio outcomes
//!
//! Up/Down outcome series on a trend's attention index. For each trend and window (24 hours,
//! 7 days, and on testnet a short drill window) the keeper opens a series whose opening index is
//! the registry's index at that moment. UP pays 1 USDC if the index at expiry is above the
//! opening (ties go to DOWN); DOWN pays 1 USDC otherwise.
//!
//! Every UP and DOWN token of every series lives in this one NEP-245 multi-token contract, with
//! token ids `<series>:up` and `<series>:down`. A complete set (one UP and one DOWN) is minted for
//! exactly 1 USDC and can be redeemed for 1 USDC at any time, before or after settlement, so the
//! USDC held always covers what the tokens can claim. A series settles from the registry's
//! settlement value; if the registry has none two days after expiry (an oracle outage), the
//! series is void and every token redeems for 0.5 USDC.

mod mt;
#[cfg(test)]
mod tests;

use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue,
};
use tredio_common::storage::{refund, StorageLedger};
use tredio_common::{now_secs, IndexSnapshot, Settlement, Side, Status};

pub const WINDOW_24H: u64 = 86_400;
pub const WINDOW_7D: u64 = 7 * 86_400;
pub const MIN_TEST_WINDOW: u64 = 300;
pub const MAX_TEST_WINDOW: u64 = 3_600;
/// A series without a settlement value this long after expiry is void.
pub const VOID_GRACE: u64 = 2 * 86_400;
/// Bytes charged per balance an account holds (key, value and trie overhead).
pub const BALANCE_ENTRY_BYTES: u64 = 180;
pub const REGISTRATION_BYTES: u64 = 120;

const GAS_REGISTRY: Gas = Gas::from_tgas(15);
const GAS_AFTER_REGISTRY: Gas = Gas::from_tgas(25);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_AFTER_PAYOUT: Gas = Gas::from_tgas(15);

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Open,
    Up,
    Down,
    Void,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Series {
    pub id: u64,
    pub trend: String,
    pub window: u64,
    /// Series number for this trend and window, from 1.
    pub number: u32,
    pub opened_at: u64,
    pub expiry: u64,
    pub opening_index: u64,
    pub settlement_index: Option<u64>,
    pub outcome: Outcome,
    #[serde(with = "u128_string")]
    pub up_supply: u128,
    #[serde(with = "u128_string")]
    pub down_supply: u128,
    /// USDC held for this series.
    #[serde(with = "u128_string")]
    pub backing: u128,
}

mod u128_string {
    use near_sdk::serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &u128, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u128, D::Error> {
        String::deserialize(d)?.parse().map_err(near_sdk::serde::de::Error::custom)
    }
}

impl Series {
    pub fn supply(&self, side: Side) -> u128 {
        match side {
            Side::Up => self.up_supply,
            Side::Down => self.down_supply,
        }
    }

    fn supply_mut(&mut self, side: Side) -> &mut u128 {
        match side {
            Side::Up => &mut self.up_supply,
            Side::Down => &mut self.down_supply,
        }
    }

    /// USDC the series still owes its token holders in its current state.
    pub fn obligations(&self) -> u128 {
        match self.outcome {
            Outcome::Up => self.up_supply,
            Outcome::Down => self.down_supply,
            Outcome::Void => self.up_supply / 2 + self.down_supply / 2,
            Outcome::Open => self.up_supply.max(self.down_supply),
        }
    }
}

/// What USDC senders put in `msg`.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
pub enum FtMsg {
    /// Mint complete sets of `series` for the attached USDC, to `receiver` (default: sender).
    Mint { series: u64, receiver: Option<AccountId> },
}

#[near(event_json(standard = "tredio-outcomes"))]
pub enum Event<'a> {
    #[event_version("1.0.0")]
    SeriesOpened {
        series: u64,
        trend: &'a str,
        window: u64,
        number: u32,
        opened_at: u64,
        expiry: u64,
        opening_index: u64,
    },
    #[event_version("1.0.0")]
    SetsMinted { series: u64, payer: &'a AccountId, receiver: &'a AccountId, amount: U128 },
    #[event_version("1.0.0")]
    SetsRedeemed { series: u64, owner: &'a AccountId, amount: U128 },
    #[event_version("1.0.0")]
    SeriesSettled { series: u64, outcome: Outcome, opening_index: u64, settlement_index: Option<u64> },
    #[event_version("1.0.0")]
    WinningsRedeemed { series: u64, owner: &'a AccountId, up: U128, down: U128, payout: U128 },
    #[event_version("1.0.0")]
    PayoutFailed { series: u64, owner: &'a AccountId, amount: U128 },
}

#[derive(BorshStorageKey)]
#[near]
pub(crate) enum Key {
    Series,
    Latest,
    Balances,
    Storage,
    PendingOpen,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Outcomes {
    pub(crate) owner: AccountId,
    pub(crate) usdc: AccountId,
    pub(crate) registry: AccountId,
    /// Zero, or an extra short window (testnet drills) between 5 and 60 minutes.
    pub(crate) test_window: u64,
    pub(crate) series: LookupMap<u64, Series>,
    /// Latest series id per `<trend>|<window>`.
    pub(crate) latest: LookupMap<String, u64>,
    /// Opens waiting on the registry, per `<trend>|<window>`, so two cannot race.
    pub(crate) pending_open: LookupMap<String, u64>,
    pub(crate) next_series: u64,
    pub(crate) balances: LookupMap<(u64, Side, AccountId), u128>,
    pub(crate) storage: StorageLedger,
    pub(crate) total_backing: u128,
}

fn latest_key(trend: &str, window: u64) -> String {
    format!("{trend}|{window}")
}

/// `<series>:up` or `<series>:down`.
pub fn token_id(series: u64, side: Side) -> String {
    format!("{series}:{}", side.as_str())
}

pub fn parse_token_id(token_id: &str) -> (u64, Side) {
    let (series, side) = token_id.split_once(':').unwrap_or_else(|| env::panic_str("bad token id"));
    let side = match side {
        "up" => Side::Up,
        "down" => Side::Down,
        _ => env::panic_str("bad token id"),
    };
    (series.parse().unwrap_or_else(|_| env::panic_str("bad token id")), side)
}

#[near]
impl Outcomes {
    #[init]
    pub fn new(owner: AccountId, usdc: AccountId, registry: AccountId, test_window: u64) -> Self {
        require!(
            test_window == 0 || (MIN_TEST_WINDOW..=MAX_TEST_WINDOW).contains(&test_window),
            "invalid test window"
        );
        Self {
            owner,
            usdc,
            registry,
            test_window,
            series: LookupMap::new(Key::Series),
            latest: LookupMap::new(Key::Latest),
            pending_open: LookupMap::new(Key::PendingOpen),
            next_series: 1,
            balances: LookupMap::new(Key::Balances),
            storage: StorageLedger::new(Key::Storage, REGISTRATION_BYTES, BALANCE_ENTRY_BYTES),
            total_backing: 0,
        }
    }

    /// Every window a series can be opened for.
    pub fn windows(&self) -> Vec<u64> {
        let mut w = vec![WINDOW_24H, WINDOW_7D];
        if self.test_window != 0 {
            w.push(self.test_window);
        }
        w
    }

    // ---------------------------------------------------------------------------------------
    // Series lifecycle
    // ---------------------------------------------------------------------------------------

    /// Opens the next series for a trend and window. Permissionless: the keeper calls it as soon
    /// as a trend lists and again whenever the previous series expires. The registry checks the
    /// trend is active and fresh and returns the opening index.
    pub fn open_series(&mut self, trend: String, window: u64) -> Promise {
        require!(self.windows().contains(&window), "invalid window");
        let key = latest_key(&trend, window);
        if let Some(prev) = self.latest.get(&key).and_then(|id| self.series.get(id)) {
            require!(now_secs() >= prev.expiry, "series still open");
        }
        let now = now_secs();
        if let Some(since) = self.pending_open.get(&key) {
            // A previous open whose callback never ran (out of gas) expires after a minute.
            require!(now > since + 60, "open in flight");
        }
        self.pending_open.insert(key, now);
        let expiry = now + window;
        Promise::new(self.registry.clone())
            .function_call(
                "register_expiry",
                near_sdk::serde_json::json!({ "id": trend, "expiry": expiry }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_REGISTRY,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_AFTER_REGISTRY)
                    .on_series_registered(trend, window, now, expiry),
            )
    }

    #[private]
    pub fn on_series_registered(
        &mut self,
        trend: String,
        window: u64,
        opened_at: u64,
        expiry: u64,
        #[callback_result] snapshot: Result<IndexSnapshot, PromiseError>,
    ) -> Option<u64> {
        let key = latest_key(&trend, window);
        self.pending_open.remove(&key);
        let snapshot = snapshot.ok()?;
        let id = self.next_series;
        self.next_series += 1;
        let number = self.latest.get(&key).and_then(|prev| self.series.get(prev)).map_or(1, |s| s.number + 1);
        Event::SeriesOpened {
            series: id,
            trend: &trend,
            window,
            number,
            opened_at,
            expiry,
            opening_index: snapshot.index,
        }
        .emit();
        self.series.insert(
            id,
            Series {
                id,
                trend,
                window,
                number,
                opened_at,
                expiry,
                opening_index: snapshot.index,
                settlement_index: None,
                outcome: Outcome::Open,
                up_supply: 0,
                down_supply: 0,
                backing: 0,
            },
        );
        self.latest.insert(key, id);
        Some(id)
    }

    /// Settles an expired series from the registry. Permissionless.
    pub fn settle(&mut self, series: u64) -> Promise {
        let s = self.get(series);
        require!(s.outcome == Outcome::Open, "already settled");
        require!(now_secs() >= s.expiry, "series not expired");
        Promise::new(self.registry.clone())
            .function_call(
                "settlement_of",
                near_sdk::serde_json::json!({ "id": s.trend, "expiry": s.expiry }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_REGISTRY,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_AFTER_REGISTRY)
                    .on_settlement(series),
            )
    }

    #[private]
    pub fn on_settlement(
        &mut self,
        series: u64,
        #[callback_result] settlement: Result<Settlement, PromiseError>,
    ) -> Outcome {
        let mut s = self.get(series);
        if s.outcome != Outcome::Open {
            return s.outcome;
        }
        match settlement {
            Ok(Settlement { finalized: true, value }) => {
                s.outcome = if value > s.opening_index { Outcome::Up } else { Outcome::Down };
                s.settlement_index = Some(value);
            }
            _ if now_secs() >= s.expiry + VOID_GRACE => s.outcome = Outcome::Void,
            Ok(_) => env::panic_str("not settleable yet"),
            Err(_) => env::panic_str("registry call failed"),
        }
        Event::SeriesSettled {
            series,
            outcome: s.outcome,
            opening_index: s.opening_index,
            settlement_index: s.settlement_index,
        }
        .emit();
        let outcome = s.outcome;
        self.series.insert(series, s);
        outcome
    }

    // ---------------------------------------------------------------------------------------
    // Complete sets and payouts
    // ---------------------------------------------------------------------------------------

    /// Burns `amount` UP and `amount` DOWN from the caller and pays `amount` USDC. Always
    /// available, before and after settlement.
    pub fn redeem_sets(&mut self, series: u64, amount: U128) -> Promise {
        require!(amount.0 > 0, "zero amount");
        let owner = env::predecessor_account_id();
        let mut s = self.get(series);
        self.burn(&mut s, Side::Up, &owner, amount.0);
        self.burn(&mut s, Side::Down, &owner, amount.0);
        s.backing -= amount.0;
        self.total_backing -= amount.0;
        self.series.insert(series, s);
        Event::SetsRedeemed { series, owner: &owner, amount }.emit();
        self.pay(series, owner, amount.0, amount.0, amount.0)
    }

    /// Redeems settled tokens: each winning token pays 1 USDC, each token of a void series pays
    /// half, losing tokens pay nothing (they are burned).
    pub fn redeem_winnings(&mut self, series: u64, up: U128, down: U128) -> PromiseOrValue<U128> {
        require!(up.0 > 0 || down.0 > 0, "zero amount");
        let owner = env::predecessor_account_id();
        let mut s = self.get(series);
        let payout = match s.outcome {
            Outcome::Open => env::panic_str("series not settled"),
            Outcome::Up => up.0,
            Outcome::Down => down.0,
            Outcome::Void => up.0 / 2 + down.0 / 2,
        };
        if up.0 > 0 {
            self.burn(&mut s, Side::Up, &owner, up.0);
        }
        if down.0 > 0 {
            self.burn(&mut s, Side::Down, &owner, down.0);
        }
        s.backing -= payout;
        self.total_backing -= payout;
        self.series.insert(series, s);
        Event::WinningsRedeemed { series, owner: &owner, up, down, payout: U128(payout) }.emit();
        if payout == 0 {
            return PromiseOrValue::Value(U128(0));
        }
        PromiseOrValue::Promise(self.pay(series, owner, payout, up.0, down.0))
    }

    /// Sends `amount` USDC to `owner`; if the transfer fails the burned tokens and backing are
    /// restored so nothing is lost.
    fn pay(&self, series: u64, owner: AccountId, amount: u128, up: u128, down: u128) -> Promise {
        Promise::new(self.usdc.clone())
            .function_call(
                "ft_transfer",
                near_sdk::serde_json::json!({ "receiver_id": owner, "amount": U128(amount) })
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_FT_TRANSFER,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_AFTER_PAYOUT).after_payout(
                series,
                owner,
                U128(amount),
                U128(up),
                U128(down),
            ))
    }

    #[private]
    pub fn after_payout(
        &mut self,
        series: u64,
        owner: AccountId,
        amount: U128,
        up: U128,
        down: U128,
    ) -> U128 {
        if tredio_common::promise_succeeded() {
            return amount;
        }
        let mut s = self.get(series);
        if up.0 > 0 {
            self.mint(&mut s, Side::Up, &owner, up.0);
        }
        if down.0 > 0 {
            self.mint(&mut s, Side::Down, &owner, down.0);
        }
        s.backing += amount.0;
        self.total_backing += amount.0;
        self.series.insert(series, s);
        Event::PayoutFailed { series, owner: &owner, amount }.emit();
        U128(0)
    }

    // ---------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------

    pub fn get_series(&self, series: u64) -> Option<Series> {
        self.series.get(&series).cloned()
    }

    pub fn latest_series(&self, trend: String, window: u64) -> Option<Series> {
        self.latest.get(&latest_key(&trend, window)).and_then(|id| self.series.get(id)).cloned()
    }

    pub fn series_count(&self) -> u64 {
        self.next_series - 1
    }

    pub fn obligations(&self, series: u64) -> U128 {
        U128(self.series.get(&series).map_or(0, |s| s.obligations()))
    }

    pub fn total_backing(&self) -> U128 {
        U128(self.total_backing)
    }

    pub fn config(&self) -> (AccountId, AccountId, u64) {
        (self.usdc.clone(), self.registry.clone(), self.test_window)
    }
}

impl Outcomes {
    pub(crate) fn get(&self, series: u64) -> Series {
        self.series.get(&series).cloned().unwrap_or_else(|| env::panic_str("unknown series"))
    }

    pub(crate) fn balance(&self, series: u64, side: Side, owner: &AccountId) -> u128 {
        self.balances.get(&(series, side, owner.clone())).copied().unwrap_or(0)
    }

    /// Credits `amount` of a token to `owner`, charging storage for a new balance.
    pub(crate) fn credit(&mut self, series: u64, side: Side, owner: &AccountId, amount: u128) {
        let key = (series, side, owner.clone());
        match self.balances.get_mut(&key) {
            Some(b) => *b += amount,
            None => {
                self.storage.add_entry(owner);
                self.balances.insert(key, amount);
            }
        }
    }

    /// Debits `amount` of a token from `owner`, freeing the balance's storage at zero.
    pub(crate) fn debit(&mut self, series: u64, side: Side, owner: &AccountId, amount: u128) {
        let key = (series, side, owner.clone());
        let b = self.balances.get(&key).copied().unwrap_or(0);
        require!(b >= amount, "insufficient balance");
        if b == amount {
            self.balances.remove(&key);
            self.storage.remove_entry(owner);
        } else {
            self.balances.insert(key, b - amount);
        }
    }

    fn mint(&mut self, s: &mut Series, side: Side, owner: &AccountId, amount: u128) {
        self.credit(s.id, side, owner, amount);
        *s.supply_mut(side) += amount;
        mt::emit_mint(owner, &[token_id(s.id, side)], &[amount], None);
    }

    fn burn(&mut self, s: &mut Series, side: Side, owner: &AccountId, amount: u128) {
        self.debit(s.id, side, owner, amount);
        *s.supply_mut(side) -= amount;
        mt::emit_burn(owner, &[token_id(s.id, side)], &[amount], None);
    }

    fn mint_sets(&mut self, series: u64, payer: &AccountId, receiver: &AccountId, amount: u128) {
        let mut s = self.get(series);
        require!(s.outcome == Outcome::Open && now_secs() < s.expiry, "series expired");
        self.mint(&mut s, Side::Up, receiver, amount);
        self.mint(&mut s, Side::Down, receiver, amount);
        s.backing += amount;
        self.total_backing += amount;
        self.series.insert(series, s);
        Event::SetsMinted { series, payer, receiver, amount: U128(amount) }.emit();
    }
}

#[near]
impl FungibleTokenReceiver for Outcomes {
    /// Mints complete sets for USDC (`msg` = [`FtMsg`]), after the registry confirms the trend
    /// is still active. Anything not used is refunded through the token's resolve step.
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.usdc, "only USDC");
        let Ok(FtMsg::Mint { series, receiver }) = near_sdk::serde_json::from_str::<FtMsg>(&msg) else {
            env::panic_str("bad message");
        };
        require!(amount.0 > 0, "zero amount");
        let s = self.get(series);
        require!(s.outcome == Outcome::Open && now_secs() < s.expiry, "series expired");
        let receiver = receiver.unwrap_or_else(|| sender_id.clone());
        require!(self.storage.is_registered(&receiver), "receiver is not registered for storage");
        PromiseOrValue::Promise(
            Promise::new(self.registry.clone())
                .function_call(
                    "index_of",
                    near_sdk::serde_json::json!({ "id": s.trend }).to_string().into_bytes(),
                    NearToken::from_yoctonear(0),
                    GAS_REGISTRY,
                )
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_AFTER_REGISTRY)
                        .on_mint_checked(series, sender_id, receiver, amount),
                ),
        )
    }
}

#[near]
impl Outcomes {
    /// Mints when the trend is active; otherwise returns the whole amount as unused.
    #[private]
    pub fn on_mint_checked(
        &mut self,
        series: u64,
        payer: AccountId,
        receiver: AccountId,
        amount: U128,
        #[callback_result] snapshot: Result<Option<IndexSnapshot>, PromiseError>,
    ) -> U128 {
        let active = matches!(snapshot, Ok(Some(ref t)) if t.status == Status::Active);
        let s = self.get(series);
        if !active
            || s.outcome != Outcome::Open
            || now_secs() >= s.expiry
            || !self.storage.is_registered(&receiver)
        {
            return amount;
        }
        self.mint_sets(series, &payer, &receiver, amount.0);
        U128(0)
    }
}

#[near]
impl StorageManagement for Outcomes {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        let account = account_id.unwrap_or_else(env::predecessor_account_id);
        let back = self.storage.deposit(
            &account,
            env::attached_deposit().as_yoctonear(),
            registration_only.unwrap_or(false),
        );
        refund(&env::predecessor_account_id(), back);
        self.storage.balance_of(&account).unwrap()
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        near_sdk::assert_one_yocto();
        let account = env::predecessor_account_id();
        let taken = self.storage.withdraw(&account, amount.map(|a| a.as_yoctonear()));
        refund(&account, taken);
        self.storage.balance_of(&account).unwrap()
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        near_sdk::assert_one_yocto();
        require!(
            !force.unwrap_or(false),
            "force unregister is not supported; redeem or transfer tokens first"
        );
        let account = env::predecessor_account_id();
        match self.storage.unregister(&account) {
            Some(deposit) => {
                refund(&account, deposit);
                true
            }
            None => false,
        }
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.storage.bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.storage.balance_of(&account_id)
    }
}
