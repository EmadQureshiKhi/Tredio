//! # Tredio attention perps
//!
//! Perpetual long or short exposure to a trend's attention index, settled in USDC.
//!
//! - The mark is the registry's index. One contract (1e18 units of `qty`) is worth 1 USDC per
//!   index point, so PnL = qty x (exit - entry) for a long.
//! - Isolated margin per position, up to 3x leverage at open, 10% maintenance margin.
//! - Funding is a crowding tax: the larger side pays the smaller side a rate proportional to the
//!   long/short skew, accrued per second from the last stored mark; the keeper pokes to keep the
//!   mark current.
//! - Open interest per side is capped by the pool, scaled down for low-attention trends.
//! - Liquidation is permissionless once equity falls below maintenance; the liquidator earns up
//!   to 1% of notional out of the remaining equity.
//! - Nothing trades against a stale index: open, close and liquidate read the registry first and
//!   refuse a stale observation. A retired trend settles every position at its final index.
//!
//! Counterparty and loss order: positions settle against the pool (the insurance fund), which
//! also takes trade fees and liquidated margin. Losses come first from a position's own margin,
//! then from the pool. If the pool cannot pay a winner in full, the winner gets what the pool
//! holds and the shortfall is logged as a socialized loss; other traders' margins are never used.
//! Fees: 10 bps of notional per trade, 60% to the pool, 15% to the trend's curator, the rest to
//! the treasury.

mod ops;
#[cfg(test)]
mod tests;

use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise};
use tredio_common::math::{mul_div_ceil, mul_div_floor, UWAD};
use tredio_common::storage::{refund, StorageLedger};
use tredio_common::{now_secs, BPS, INDEX_SCALE, ONE_USDC};

pub const MAX_LEVERAGE_BPS: u32 = 30_000;
pub const MAINTENANCE_MARGIN_BPS: u128 = 1_000;
pub const TRADE_FEE_BPS: u128 = 10;
pub const LIQUIDATION_REWARD_BPS: u128 = 100;
pub const POOL_FEE_SHARE_BPS: u128 = 6_000;
pub const CURATION_FEE_SHARE_BPS: u128 = 1_500;
/// Funding per second at 100% skew, as a WAD fraction of notional (about 4.3% a day), also the cap.
pub const FUNDING_RATE_PER_SEC_AT_FULL_SKEW: u128 = 500_000_000_000;
pub const OI_POOL_MULTIPLE: u128 = 5;
/// Index at which the open-interest cap is no longer scaled down (25 points).
pub const ATTENTION_REFERENCE_INDEX: u64 = 25 * INDEX_SCALE;
/// Smallest attention scaling of the cap (20%).
pub const MIN_ATTENTION_FACTOR: u128 = UWAD / 5;
pub const MIN_MARGIN: u128 = ONE_USDC;
pub const MAX_POSITIONS_PER_OWNER: usize = 32;
pub const POSITION_ENTRY_BYTES: u64 = 300;
pub const REGISTRATION_BYTES: u64 = 120;

pub(crate) const GAS_REGISTRY: Gas = Gas::from_tgas(10);
pub(crate) const GAS_AFTER_REGISTRY: Gas = Gas::from_tgas(60);
pub(crate) const GAS_TRANSFER: Gas = Gas::from_tgas(15);
pub(crate) const GAS_TRANSFER_CALL: Gas = Gas::from_tgas(40);
pub(crate) const GAS_AFTER_TRANSFER: Gas = Gas::from_tgas(10);

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Position {
    pub id: u64,
    pub owner: AccountId,
    pub trend: String,
    pub is_long: bool,
    pub entry_index: u64,
    /// Contracts, WAD-scaled.
    pub qty: U128,
    /// USDC margin net of the opening fee.
    pub margin: U128,
    /// The side's cumulative funding when the position opened (string-encoded i128).
    #[serde(with = "i128_string")]
    pub entry_funding: i128,
    pub opened_at: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct Market {
    pub long_qty: U128,
    pub short_qty: U128,
    /// Cumulative funding per contract (USDC units x 1e18); positive is owed.
    #[serde(with = "i128_string")]
    pub cum_long: i128,
    #[serde(with = "i128_string")]
    pub cum_short: i128,
    pub last_time: u64,
    pub last_mark: u64,
}

mod i128_string {
    use near_sdk::serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &i128, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<i128, D::Error> {
        String::deserialize(d)?.parse().map_err(near_sdk::serde::de::Error::custom)
    }
}

/// Live state of a position at an index.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PositionState {
    pub index: u64,
    #[serde(with = "i128_string")]
    pub equity: i128,
    #[serde(with = "i128_string")]
    pub pnl: i128,
    #[serde(with = "i128_string")]
    pub funding: i128,
    pub notional: U128,
    pub liquidatable: bool,
    /// Index at which the position becomes liquidatable, at current funding.
    pub liquidation_index: u64,
}

#[near(event_json(standard = "tredio-perps"))]
pub enum Event<'a> {
    #[event_version("1.0.0")]
    Poked { trend: &'a str, mark: u64, cum_long: String, cum_short: String, at: u64 },
    #[event_version("1.0.0")]
    PositionOpened {
        id: u64,
        owner: &'a AccountId,
        trend: &'a str,
        is_long: bool,
        qty: U128,
        margin: U128,
        entry_index: u64,
        fee: U128,
        payer: &'a AccountId,
    },
    #[event_version("1.0.0")]
    MarginAdded { id: u64, payer: &'a AccountId, amount: U128 },
    #[event_version("1.0.0")]
    PositionClosed {
        id: u64,
        owner: &'a AccountId,
        trend: &'a str,
        is_long: bool,
        entry_index: u64,
        exit_index: u64,
        qty: U128,
        margin: U128,
        pnl: String,
        funding: String,
        fee: U128,
        payout: U128,
        retired: bool,
    },
    #[event_version("1.0.0")]
    PositionLiquidated {
        id: u64,
        owner: &'a AccountId,
        liquidator: &'a AccountId,
        exit_index: u64,
        equity: String,
        reward: U128,
    },
    #[event_version("1.0.0")]
    SocializedLoss { id: u64, shortfall: U128 },
    #[event_version("1.0.0")]
    PoolDeposit { from: &'a AccountId, amount: U128 },
    #[event_version("1.0.0")]
    OpenRefused { owner: &'a AccountId, trend: &'a str, reason: &'a str, amount: U128 },
    #[event_version("1.0.0")]
    PayoutDeferred { account: &'a AccountId, amount: U128 },
}

#[derive(BorshStorageKey)]
#[near]
pub(crate) enum Key {
    Positions,
    Markets,
    ByOwner,
    Claimable,
    Storage,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Perps {
    pub(crate) owner: AccountId,
    pub(crate) usdc: AccountId,
    pub(crate) registry: AccountId,
    pub(crate) curation: AccountId,
    pub(crate) treasury: AccountId,
    /// Absolute cap on each side's notional per trend (USDC).
    pub(crate) max_oi_per_side: u128,
    pub(crate) positions: IterableMap<u64, Position>,
    pub(crate) markets: LookupMap<String, Market>,
    pub(crate) by_owner: LookupMap<AccountId, Vec<u64>>,
    /// Payouts whose transfer failed, waiting for `withdraw_claimable`.
    pub(crate) claimable: LookupMap<AccountId, u128>,
    pub(crate) storage: StorageLedger,
    pub(crate) next_position: u64,
    /// The pool: insurance fund and counterparty to every position.
    pub(crate) pool: u128,
    pub(crate) total_margin: u128,
    pub(crate) protocol_fees: u128,
}

#[near]
impl Perps {
    #[init]
    pub fn new(
        owner: AccountId,
        usdc: AccountId,
        registry: AccountId,
        curation: AccountId,
        treasury: AccountId,
        max_oi_per_side: U128,
    ) -> Self {
        require!(
            (1_000 * ONE_USDC..=100_000_000 * ONE_USDC).contains(&max_oi_per_side.0),
            "invalid open interest cap"
        );
        Self {
            owner,
            usdc,
            registry,
            curation,
            treasury,
            max_oi_per_side: max_oi_per_side.0,
            positions: IterableMap::new(Key::Positions),
            markets: LookupMap::new(Key::Markets),
            by_owner: LookupMap::new(Key::ByOwner),
            claimable: LookupMap::new(Key::Claimable),
            storage: StorageLedger::new(Key::Storage, REGISTRATION_BYTES, POSITION_ENTRY_BYTES),
            next_position: 1,
            pool: 0,
            total_margin: 0,
            protocol_fees: 0,
        }
    }

    // ---------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------

    pub fn get_position(&self, id: u64) -> Option<Position> {
        self.positions.get(&id).cloned()
    }

    pub fn positions_of(&self, account_id: AccountId) -> Vec<Position> {
        self.by_owner
            .get(&account_id)
            .map(|ids| ids.iter().filter_map(|id| self.positions.get(id).cloned()).collect())
            .unwrap_or_default()
    }

    /// Open positions in id order, for the keeper's liquidation scan.
    pub fn get_positions(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Position> {
        self.positions
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(100).min(500) as usize)
            .cloned()
            .collect()
    }

    pub fn position_count(&self) -> u32 {
        self.positions.len()
    }

    pub fn get_market(&self, trend: String) -> Market {
        self.markets.get(&trend).cloned().unwrap_or_default()
    }

    /// Equity, PnL and funding of a position at `index` (the market's last mark when omitted),
    /// including funding accrued since the last touch.
    pub fn position_state(&self, id: u64, index: Option<u64>) -> PositionState {
        let p = self.positions.get(&id).cloned().unwrap_or_else(|| env::panic_str("unknown position"));
        let m = self.markets.get(&p.trend).cloned().unwrap_or_default();
        let index = index.unwrap_or(m.last_mark);
        let (cum_long, cum_short) = pending_cumulative(&m, now_secs());
        let delta = if p.is_long { cum_long } else { cum_short } - p.entry_funding;
        let funding = funding_owed(p.qty.0, delta);
        let pnl = pnl_of(&p, index);
        let equity = p.margin.0 as i128 + pnl - funding;
        let notional = notional(p.qty.0, index);
        PositionState {
            index,
            equity,
            pnl,
            funding,
            notional: U128(notional),
            liquidatable: equity < (notional * MAINTENANCE_MARGIN_BPS / BPS) as i128,
            liquidation_index: liquidation_index(&p, funding),
        }
    }

    /// Cap on each side's notional at `index`.
    pub fn open_interest_cap(&self, index: u64) -> U128 {
        U128(oi_cap(self.pool, self.max_oi_per_side, index))
    }

    /// Current funding rate per second (WAD fraction of notional), positive when longs pay.
    pub fn funding_rate(&self, trend: String) -> String {
        let m = self.markets.get(&trend).cloned().unwrap_or_default();
        rate(m.long_qty.0, m.short_qty.0).to_string()
    }

    pub fn pool(&self) -> U128 {
        U128(self.pool)
    }

    pub fn totals(&self) -> (U128, U128, U128) {
        (U128(self.pool), U128(self.total_margin), U128(self.protocol_fees))
    }

    pub fn claimable_of(&self, account_id: AccountId) -> U128 {
        U128(self.claimable.get(&account_id).copied().unwrap_or(0))
    }
}

// -------------------------------------------------------------------------------------------
// Pure math (WAD-scaled qty, 6-decimal index and USDC)
// -------------------------------------------------------------------------------------------

/// USDC notional of `qty` contracts at `index`.
pub fn notional(qty: u128, index: u64) -> u128 {
    mul_div_floor(qty, index as u128 * ONE_USDC, UWAD * INDEX_SCALE as u128)
}

pub fn oi_cap(pool: u128, max_per_side: u128, index: u64) -> u128 {
    let factor = if index >= ATTENTION_REFERENCE_INDEX {
        UWAD
    } else {
        mul_div_floor(index as u128, UWAD, ATTENTION_REFERENCE_INDEX as u128).max(MIN_ATTENTION_FACTOR)
    };
    mul_div_floor(pool * OI_POOL_MULTIPLE, factor, UWAD).min(max_per_side)
}

/// Funding rate per second (WAD), positive when longs pay shorts.
pub fn rate(long_qty: u128, short_qty: u128) -> i128 {
    let total = long_qty + short_qty;
    if total == 0 || long_qty == short_qty {
        return 0;
    }
    let diff = long_qty.abs_diff(short_qty);
    let r = mul_div_floor(diff, FUNDING_RATE_PER_SEC_AT_FULL_SKEW, total)
        .min(FUNDING_RATE_PER_SEC_AT_FULL_SKEW) as i128;
    if long_qty > short_qty {
        r
    } else {
        -r
    }
}

/// Cumulative funding including what accrued since `m.last_time` at the last mark. The paying
/// side rounds up and the receiving side down, so receivers never get more than payers pay.
pub fn pending_cumulative(m: &Market, now: u64) -> (i128, i128) {
    let (mut cl, mut cs) = (m.cum_long, m.cum_short);
    if m.last_time == 0 || now <= m.last_time {
        return (cl, cs);
    }
    let r = rate(m.long_qty.0, m.short_qty.0);
    if r == 0 {
        return (cl, cs);
    }
    let dt = (now - m.last_time) as u128;
    let per_contract =
        mul_div_ceil(r.unsigned_abs() * dt, m.last_mark as u128 * ONE_USDC, INDEX_SCALE as u128);
    if r > 0 {
        cl += per_contract as i128;
        if m.short_qty.0 > 0 {
            cs -= mul_div_floor(per_contract, m.long_qty.0, m.short_qty.0) as i128;
        }
    } else {
        cs += per_contract as i128;
        if m.long_qty.0 > 0 {
            cl -= mul_div_floor(per_contract, m.short_qty.0, m.long_qty.0) as i128;
        }
    }
    (cl, cs)
}

/// Positive delta is owed (rounded up), negative is credited (rounded down).
pub fn funding_owed(qty: u128, delta: i128) -> i128 {
    if delta >= 0 {
        mul_div_ceil(qty, delta as u128, UWAD * UWAD) as i128
    } else {
        -(mul_div_floor(qty, delta.unsigned_abs(), UWAD * UWAD) as i128)
    }
}

/// Gains round down and losses round up, in the pool's favour.
pub fn pnl_of(p: &Position, index: u64) -> i128 {
    let up = index >= p.entry_index;
    let mv = index.abs_diff(p.entry_index) as u128;
    let gain = up == p.is_long;
    let d = UWAD * INDEX_SCALE as u128;
    let amount =
        if gain { mul_div_floor(p.qty.0 * mv, ONE_USDC, d) } else { mul_div_ceil(p.qty.0 * mv, ONE_USDC, d) };
    if gain {
        amount as i128
    } else {
        -(amount as i128)
    }
}

/// Index at which equity meets maintenance, given the funding owed so far.
///
/// With q = qty, W = 1e18, B = margin - funding and m = maintenance: a long hits it at
/// (qE - BW) / (q(1 - m)), a short at (BW + qE) / (q(1 + m)).
pub fn liquidation_index(p: &Position, funding: i128) -> u64 {
    let q = p.qty.0 as i128;
    if q == 0 {
        return 0;
    }
    let bw = (p.margin.0 as i128 - funding) * UWAD as i128;
    let qe = q * p.entry_index as i128;
    let bps = BPS as i128;
    let mm = MAINTENANCE_MARGIN_BPS as i128;
    // Multiply before dividing, so the quantity is not first truncated to a multiple of 1e4.
    let scaled = |m: i128| q.checked_mul(m).map_or(q / bps * m, |x| x / bps).max(1);
    let i = if p.is_long { (qe - bw) / scaled(bps - mm) } else { (bw + qe) / scaled(bps + mm) };
    i.clamp(0, u64::MAX as i128) as u64
}

impl Perps {
    pub(crate) fn add_owner_position(&mut self, owner: &AccountId, id: u64) {
        let mut ids = self.by_owner.get(owner).cloned().unwrap_or_default();
        require!(ids.len() < MAX_POSITIONS_PER_OWNER, "too many open positions");
        ids.push(id);
        self.by_owner.insert(owner.clone(), ids);
        self.storage.add_entry(owner);
    }

    pub(crate) fn remove_owner_position(&mut self, owner: &AccountId, id: u64) {
        if let Some(ids) = self.by_owner.get_mut(owner) {
            ids.retain(|x| *x != id);
            if ids.is_empty() {
                self.by_owner.remove(owner);
            }
        }
        self.storage.remove_entry(owner);
    }

    /// Accrues funding to now and stores `index` as the mark.
    pub(crate) fn accrue(&mut self, trend: &str, index: u64, retired: bool) -> Market {
        let mut m = self.markets.get(trend).cloned().unwrap_or_default();
        let now = now_secs();
        if !retired {
            let (cl, cs) = pending_cumulative(&m, now);
            m.cum_long = cl;
            m.cum_short = cs;
        }
        m.last_time = now;
        m.last_mark = index;
        Event::Poked {
            trend,
            mark: index,
            cum_long: m.cum_long.to_string(),
            cum_short: m.cum_short.to_string(),
            at: now,
        }
        .emit();
        self.markets.insert(trend.to_string(), m.clone());
        m
    }

    /// Splits a fee: pool share now, curation share returned for sending, the rest protocol.
    pub(crate) fn book_fee(&mut self, fee: u128) -> u128 {
        if fee == 0 {
            return 0;
        }
        let to_pool = fee * POOL_FEE_SHARE_BPS / BPS;
        let to_curation = fee * CURATION_FEE_SHARE_BPS / BPS;
        self.pool += to_pool;
        self.protocol_fees += fee - to_pool - to_curation;
        to_curation
    }

    pub(crate) fn send_usdc(&self, to: &AccountId, amount: u128) -> Promise {
        Promise::new(self.usdc.clone())
            .function_call(
                "ft_transfer",
                near_sdk::serde_json::json!({ "receiver_id": to, "amount": U128(amount) })
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_TRANSFER,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_AFTER_TRANSFER)
                    .after_send(to.clone(), U128(amount)),
            )
    }

    pub(crate) fn pay_curation(&self, trend: &str, surfacer: Option<AccountId>, amount: u128) {
        if amount == 0 {
            return;
        }
        Promise::new(self.usdc.clone())
            .function_call(
                "ft_transfer_call",
                near_sdk::serde_json::json!({
                    "receiver_id": self.curation,
                    "amount": U128(amount),
                    "msg": near_sdk::serde_json::json!({ "trend": trend, "surfacer": surfacer }).to_string(),
                })
                .to_string()
                .into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_TRANSFER_CALL,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_AFTER_TRANSFER)
                    .after_curation(U128(amount)),
            )
            .detach();
    }
}

#[near]
impl Perps {
    /// A payout that failed to transfer becomes claimable instead of being lost.
    #[private]
    pub fn after_send(&mut self, to: AccountId, amount: U128) -> U128 {
        if tredio_common::promise_succeeded() {
            return amount;
        }
        *self.claimable.entry(to.clone()).or_insert(0) += amount.0;
        Event::PayoutDeferred { account: &to, amount }.emit();
        U128(0)
    }

    /// What curation did not take (its `ft_transfer_call` returned it) goes to protocol fees.
    #[private]
    pub fn after_curation(&mut self, amount: U128) {
        let used = env::promise_result_checked(0, 64)
            .ok()
            .and_then(|b| near_sdk::serde_json::from_slice::<U128>(&b).ok())
            .map_or(0, |u| u.0.min(amount.0));
        self.protocol_fees += amount.0 - used;
    }

    /// Sends the caller's deferred payouts.
    pub fn withdraw_claimable(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let amount = self.claimable.remove(&who).unwrap_or(0);
        require!(amount > 0, "nothing to withdraw");
        self.send_usdc(&who, amount)
    }

    /// Sends accrued protocol fees to the treasury. Permissionless.
    pub fn sweep_protocol_fees(&mut self) -> Promise {
        let amount = std::mem::take(&mut self.protocol_fees);
        require!(amount > 0, "nothing to sweep");
        let treasury = self.treasury.clone();
        self.send_usdc(&treasury, amount)
    }
}

#[near]
impl StorageManagement for Perps {
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
        require!(!force.unwrap_or(false), "force unregister is not supported; close positions first");
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
