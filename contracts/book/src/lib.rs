//! # Tredio book
//!
//! The exchange for UP and DOWN tokens against USDC: one market per token, prices on 0.001 USDC
//! ticks between 0.001 and 0.999, price-time priority, and internal balances.
//!
//! Two ways in:
//! - **Trading account** (market maker, limit orders): deposit USDC with `ft_transfer_call` and
//!   tokens with `mt_transfer_call`, then place, cancel and batch-update orders against the
//!   deposited balance; fills settle into balances, withdrawable at any time.
//! - **Swaps** (what a trading session sends): transfer USDC or tokens with a `swap` message; the
//!   book fills immediately up to a worst price, delivers the proceeds to the sender's wallet and
//!   returns what it could not use. An `anchored` swap first reads the registry and only fills
//!   within 0.10 USDC of the attention-implied value of the token, so a stolen session key cannot
//!   dump an account's tokens into a book it controls.
//!
//! Sizes are in raw token units (6 decimals) and must be multiples of 0.001 token, so every fill
//! costs a whole number of micro-USDC. A taker fee (basis points of the USDC side) accrues to the
//! treasury.

mod book;
mod receivers;
#[cfg(test)]
mod tests;

use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise};
use tredio_common::storage::{refund, StorageLedger};
use tredio_common::{now_secs, Side, BPS};

/// One tick is 0.001 USDC (1,000 micro-USDC) per whole token.
pub const TICK: u128 = 1_000;
pub const MIN_TICK: u16 = 1;
pub const MAX_TICK: u16 = 999;
/// Sizes are multiples of 0.001 token.
pub const LOT: u128 = 1_000;
/// Session swaps fill only within this distance of the attention-implied value (0.10 USDC).
pub const MAX_DEVIATION: u128 = 100_000;
/// Most fills one call makes, to stay well inside the gas limit.
pub const MAX_FILLS: u32 = 40;
pub const MAX_BATCH: usize = 40;
pub const BALANCE_ENTRY_BYTES: u64 = 160;
pub const ORDER_ENTRY_BYTES: u64 = 260;
pub const REGISTRATION_BYTES: u64 = 120;

pub(crate) const GAS_VIEW: Gas = Gas::from_tgas(10);
pub(crate) const GAS_TRANSFER: Gas = Gas::from_tgas(15);
pub(crate) const GAS_AFTER_TRANSFER: Gas = Gas::from_tgas(10);

/// What a balance is held in.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Asset {
    Usdc,
    Token { series: u64, side: Side },
}

/// Buy (bid) or sell (ask) the market's token.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Dir {
    Buy,
    Sell,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimeInForce {
    /// Rests what does not fill.
    Gtc,
    /// Rests only; skipped if it would trade on arrival.
    PostOnly,
    /// Fills what it can now and cancels the rest.
    Ioc,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Market {
    pub series: u64,
    pub side: Side,
    pub trend: String,
    pub opening_index: u64,
    pub expiry: u64,
    #[serde(skip)]
    pub(crate) bids: [u64; 16],
    #[serde(skip)]
    pub(crate) asks: [u64; 16],
    pub last_tick: Option<u16>,
    pub volume_usdc: U128,
    pub trades: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub(crate) struct Level {
    pub head: u64,
    pub tail: u64,
    pub size: u128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Order {
    pub id: u64,
    pub owner: AccountId,
    pub series: u64,
    pub side: Side,
    pub dir: Dir,
    pub tick: u16,
    pub remaining: U128,
    pub placed_at: u64,
    #[serde(skip)]
    pub(crate) prev: u64,
    #[serde(skip)]
    pub(crate) next: u64,
}

/// One order in a placement or batch.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct OrderSpec {
    pub series: u64,
    pub side: Side,
    pub dir: Dir,
    pub tick: u16,
    pub size: U128,
    pub tif: TimeInForce,
}

/// What a placement did.
#[near(serializers = [json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Placement {
    /// The resting order's id, if any of it rests.
    pub order_id: Option<u64>,
    pub filled: U128,
    /// USDC paid (buy) or received (sell), fees included.
    pub usdc: U128,
    /// True when a post-only order would have crossed and was skipped.
    pub skipped: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LevelView {
    pub tick: u16,
    pub price: U128,
    pub size: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Depth {
    pub series: u64,
    pub side: Side,
    pub bids: Vec<LevelView>,
    pub asks: Vec<LevelView>,
    pub last_tick: Option<u16>,
}

#[near(event_json(standard = "tredio-book"))]
pub enum Event<'a> {
    #[event_version("1.0.0")]
    MarketListed { series: u64, side: Side, trend: &'a str, expiry: u64 },
    #[event_version("1.0.0")]
    Deposit { account: &'a AccountId, asset: Asset, amount: U128 },
    #[event_version("1.0.0")]
    Withdraw { account: &'a AccountId, asset: Asset, amount: U128 },
    #[event_version("1.0.0")]
    OrderPlaced { id: u64, owner: &'a AccountId, series: u64, side: Side, dir: Dir, tick: u16, size: U128 },
    #[event_version("1.0.0")]
    OrderCancelled { id: u64, owner: &'a AccountId, remaining: U128 },
    #[event_version("1.0.0")]
    OrderSkipped { owner: &'a AccountId, series: u64, side: Side, dir: Dir, tick: u16, reason: &'a str },
    #[event_version("1.0.0")]
    Trade {
        series: u64,
        side: Side,
        maker_order: u64,
        maker: &'a AccountId,
        taker: &'a AccountId,
        taker_dir: Dir,
        tick: u16,
        size: U128,
        usdc: U128,
        fee: U128,
    },
    #[event_version("1.0.0")]
    Swap {
        account: &'a AccountId,
        series: u64,
        side: Side,
        dir: Dir,
        anchored: bool,
        fair: Option<U128>,
        amount_in: U128,
        amount_out: U128,
    },
    #[event_version("1.0.0")]
    DeliveryFailed { account: &'a AccountId, asset: Asset, amount: U128 },
}

#[derive(BorshStorageKey)]
#[near]
pub(crate) enum Key {
    Markets,
    Levels,
    Orders,
    Balances,
    Storage,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Book {
    pub(crate) owner: AccountId,
    pub(crate) usdc: AccountId,
    pub(crate) outcomes: AccountId,
    pub(crate) registry: AccountId,
    pub(crate) treasury: AccountId,
    pub(crate) taker_fee_bps: u32,
    pub(crate) markets: LookupMap<(u64, Side), Market>,
    pub(crate) levels: LookupMap<(u64, Side, bool, u16), Level>,
    pub(crate) orders: LookupMap<u64, Order>,
    pub(crate) next_order: u64,
    pub(crate) balances: LookupMap<(AccountId, Asset), u128>,
    pub(crate) storage: StorageLedger,
    pub(crate) fees: u128,
}

#[near]
impl Book {
    #[init]
    pub fn new(
        owner: AccountId,
        usdc: AccountId,
        outcomes: AccountId,
        registry: AccountId,
        treasury: AccountId,
        taker_fee_bps: u32,
    ) -> Self {
        require!(taker_fee_bps <= 100, "fee above 1%");
        Self {
            owner,
            usdc,
            outcomes,
            registry,
            treasury,
            taker_fee_bps,
            markets: LookupMap::new(Key::Markets),
            levels: LookupMap::new(Key::Levels),
            orders: LookupMap::new(Key::Orders),
            next_order: 1,
            balances: LookupMap::new(Key::Balances),
            storage: StorageLedger::new(
                Key::Storage,
                REGISTRATION_BYTES,
                BALANCE_ENTRY_BYTES.max(ORDER_ENTRY_BYTES),
            ),
            fees: 0,
        }
    }

    // ---------------------------------------------------------------------------------------
    // Listing
    // ---------------------------------------------------------------------------------------

    /// Lists both tokens of an outcome series. Permissionless: the keeper calls it after opening
    /// a series; the series terms come from the outcomes contract.
    pub fn list_series(&mut self, series: u64) -> Promise {
        require!(!self.markets.contains_key(&(series, Side::Up)), "already listed");
        Promise::new(self.outcomes.clone())
            .function_call(
                "get_series",
                near_sdk::serde_json::json!({ "series": series }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_VIEW,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(15))
                    .on_series_info(series),
            )
    }

    #[private]
    pub fn on_series_info(
        &mut self,
        series: u64,
        #[callback_result] info: Result<Option<SeriesInfo>, near_sdk::PromiseError>,
    ) -> bool {
        let Ok(Some(info)) = info else { return false };
        if self.markets.contains_key(&(series, Side::Up)) || info.expiry <= now_secs() {
            return false;
        }
        for side in [Side::Up, Side::Down] {
            Event::MarketListed { series, side, trend: &info.trend, expiry: info.expiry }.emit();
            self.markets.insert(
                (series, side),
                Market {
                    series,
                    side,
                    trend: info.trend.clone(),
                    opening_index: info.opening_index,
                    expiry: info.expiry,
                    bids: [0; 16],
                    asks: [0; 16],
                    last_tick: None,
                    volume_usdc: U128(0),
                    trades: 0,
                },
            );
        }
        true
    }

    // ---------------------------------------------------------------------------------------
    // Trading account
    // ---------------------------------------------------------------------------------------

    /// Places one order against the caller's deposited balance.
    pub fn place_order(&mut self, order: OrderSpec) -> Placement {
        let owner = env::predecessor_account_id();
        self.place(&owner, &order)
    }

    /// Cancels orders, then places new ones, in one call (the market maker's re-quote). Unknown
    /// or already filled order ids are ignored, and a post-only order that would cross is
    /// skipped, so one stale entry never fails the whole batch.
    pub fn batch_update(&mut self, cancels: Vec<u64>, places: Vec<OrderSpec>) -> Vec<Placement> {
        require!(cancels.len() + places.len() <= MAX_BATCH, "batch too large");
        let owner = env::predecessor_account_id();
        for id in cancels {
            if self.orders.get(&id).is_some_and(|o| o.owner == owner) {
                self.cancel(id);
            }
        }
        places.iter().map(|o| self.place(&owner, o)).collect()
    }

    pub fn cancel_order(&mut self, order_id: u64) -> U128 {
        let o = self.orders.get(&order_id).cloned().unwrap_or_else(|| env::panic_str("unknown order"));
        require!(o.owner == env::predecessor_account_id(), "not your order");
        U128(self.cancel(order_id))
    }

    /// Withdraws `amount` of a deposited asset to the caller's wallet. A failed transfer is
    /// credited back to the balance.
    pub fn withdraw(&mut self, asset: Asset, amount: U128) -> Promise {
        let owner = env::predecessor_account_id();
        require!(amount.0 > 0, "zero amount");
        self.debit(&owner, asset, amount.0);
        Event::Withdraw { account: &owner, asset, amount }.emit();
        self.deliver(owner, asset, amount.0)
    }

    /// Moves the accrued taker fees to the treasury's balance in the book. Anyone may call it.
    pub fn sweep_fees(&mut self) -> U128 {
        let fees = std::mem::take(&mut self.fees);
        if fees > 0 {
            let treasury = self.treasury.clone();
            self.credit(&treasury, Asset::Usdc, fees);
        }
        U128(fees)
    }

    // ---------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------

    pub fn get_market(&self, series: u64, side: Side) -> Option<Market> {
        self.markets.get(&(series, side)).cloned()
    }

    /// The best `levels` price levels on each side.
    pub fn depth(&self, series: u64, side: Side, levels: Option<u8>) -> Depth {
        let m = self.markets.get(&(series, side)).unwrap_or_else(|| env::panic_str("unknown market"));
        let n = levels.unwrap_or(10).min(50) as usize;
        let view = |is_bid: bool| -> Vec<LevelView> {
            let bits = if is_bid { &m.bids } else { &m.asks };
            let ticks: Box<dyn Iterator<Item = u16>> =
                if is_bid { Box::new((MIN_TICK..=MAX_TICK).rev()) } else { Box::new(MIN_TICK..=MAX_TICK) };
            ticks
                .filter(|t| book::bit(bits, *t))
                .take(n)
                .map(|t| {
                    let l = self.levels.get(&(series, side, is_bid, t)).cloned().unwrap_or_default();
                    LevelView { tick: t, price: U128(t as u128 * TICK), size: U128(l.size) }
                })
                .collect()
        };
        Depth { series, side, bids: view(true), asks: view(false), last_tick: m.last_tick }
    }

    pub fn get_order(&self, order_id: u64) -> Option<Order> {
        self.orders.get(&order_id).cloned()
    }

    pub fn balance_of(&self, account_id: AccountId, asset: Asset) -> U128 {
        U128(self.balances.get(&(account_id, asset)).copied().unwrap_or(0))
    }

    pub fn taker_fee_bps(&self) -> u32 {
        self.taker_fee_bps
    }

    pub fn accrued_fees(&self) -> U128 {
        U128(self.fees)
    }
}

/// The part of an outcomes series the book needs.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SeriesInfo {
    pub trend: String,
    pub opening_index: u64,
    pub expiry: u64,
}

impl Book {
    pub(crate) fn balance(&self, owner: &AccountId, asset: Asset) -> u128 {
        self.balances.get(&(owner.clone(), asset)).copied().unwrap_or(0)
    }

    pub(crate) fn credit(&mut self, owner: &AccountId, asset: Asset, amount: u128) {
        if amount == 0 {
            return;
        }
        let key = (owner.clone(), asset);
        match self.balances.get_mut(&key) {
            Some(b) => *b += amount,
            None => {
                self.storage.add_entry(owner);
                self.balances.insert(key, amount);
            }
        }
    }

    pub(crate) fn debit(&mut self, owner: &AccountId, asset: Asset, amount: u128) {
        if amount == 0 {
            return;
        }
        let key = (owner.clone(), asset);
        let b = self.balances.get(&key).copied().unwrap_or(0);
        require!(b >= amount, "insufficient balance");
        if b == amount {
            self.balances.remove(&key);
            self.storage.remove_entry(owner);
        } else {
            self.balances.insert(key, b - amount);
        }
    }

    pub(crate) fn fee_on(&self, usdc: u128) -> u128 {
        usdc * self.taker_fee_bps as u128 / BPS
    }

    /// Sends `amount` of `asset` from the book to `to`'s wallet; on failure the amount is
    /// credited to `to`'s balance in the book instead.
    pub(crate) fn deliver(&self, to: AccountId, asset: Asset, amount: u128) -> Promise {
        let transfer = match asset {
            Asset::Usdc => Promise::new(self.usdc.clone()).function_call(
                "ft_transfer",
                near_sdk::serde_json::json!({ "receiver_id": to, "amount": U128(amount) })
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_TRANSFER,
            ),
            Asset::Token { series, side } => Promise::new(self.outcomes.clone()).function_call(
                "mt_transfer",
                near_sdk::serde_json::json!({
                    "receiver_id": to,
                    "token_id": format!("{series}:{}", side.as_str()),
                    "amount": U128(amount),
                })
                .to_string()
                .into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_TRANSFER,
            ),
        };
        transfer.then(
            Self::ext(env::current_account_id()).with_static_gas(GAS_AFTER_TRANSFER).after_delivery(
                to,
                asset,
                U128(amount),
            ),
        )
    }
}

#[near]
impl Book {
    #[private]
    pub fn after_delivery(&mut self, to: AccountId, asset: Asset, amount: U128) -> U128 {
        if tredio_common::promise_succeeded() {
            return amount;
        }
        // Keep it in the book, withdrawable later, even when the account's storage is full or
        // it is not registered (the book then pays for the entry). A registered account's new
        // entry is counted, so the debit that later removes it releases an entry it holds.
        let key = (to.clone(), asset);
        match self.balances.get_mut(&key) {
            Some(b) => *b += amount.0,
            None => {
                self.storage.force_add_entry(&to);
                self.balances.insert(key, amount.0);
            }
        }
        Event::DeliveryFailed { account: &to, asset, amount }.emit();
        U128(0)
    }
}

#[near]
impl StorageManagement for Book {
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
        require!(!force.unwrap_or(false), "force unregister is not supported; withdraw and cancel first");
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
