//! Deposits, placements and swaps that arrive with a USDC or outcome-token transfer.

use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::U128;
use near_sdk::{
    env, near, require, serde_json, AccountId, Gas, NearToken, Promise, PromiseError, PromiseOrValue,
};
use tredio_common::pricing::fair_up_usdc;
use tredio_common::{now_secs, IndexSnapshot, Side, Status, ONE_USDC};

use crate::book::cost;
use crate::{
    Asset, Book, BookExt, Dir, Event, OrderSpec, GAS_VIEW, LOT, MAX_DEVIATION, MAX_TICK, MIN_TICK, TICK,
};

const GAS_AFTER_ANCHOR: Gas = Gas::from_tgas(60);

/// What a transfer to the book asks for, in its `msg`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum TransferMsg {
    /// Credits the transfer to the sender's trading balance (storage registration needed).
    Deposit,
    /// Deposits, then places this order.
    Place { order: OrderSpec },
    /// Fills now and delivers the proceeds to the sender's wallet; the unused input goes back.
    /// USDC in buys `side` of `series`; tokens in sell them. `limit_tick` is the worst price;
    /// `anchored` also bounds it to 0.10 USDC around the attention-implied value.
    Swap { series: u64, side: Side, limit_tick: Option<u16>, min_out: U128, anchored: bool },
}

impl Book {
    /// Executes a swap for `account`, delivers the output, and returns the unused input.
    #[allow(clippy::too_many_arguments)]
    fn swap(
        &mut self,
        account: &AccountId,
        series: u64,
        side: Side,
        dir: Dir,
        amount: u128,
        limit_tick: u16,
        min_out: u128,
        anchored: bool,
        fair: Option<u128>,
    ) -> u128 {
        let (used, out, out_asset) = match dir {
            Dir::Buy => {
                let f = self.take(account, series, side, Dir::Buy, limit_tick, u128::MAX, Some(amount));
                (f.usdc + f.fee, f.size, Asset::Token { series, side })
            }
            Dir::Sell => {
                let size = amount - amount % LOT;
                let f = self.take(account, series, side, Dir::Sell, limit_tick, size, None);
                (f.size, f.usdc - f.fee, Asset::Usdc)
            }
        };
        require!(out >= min_out && out > 0, "swap output below the minimum");
        Event::Swap {
            account,
            series,
            side,
            dir,
            anchored,
            fair: fair.map(U128),
            amount_in: U128(used),
            amount_out: U128(out),
        }
        .emit();
        self.deliver(account.clone(), out_asset, out).detach();
        amount - used
    }

    /// Worst tick for an anchored swap, from the token's attention-implied value.
    pub(crate) fn anchored_limit(dir: Dir, fair: u128, requested: Option<u16>) -> u16 {
        let tick = match dir {
            Dir::Buy => ((fair + MAX_DEVIATION) / TICK).min(MAX_TICK as u128) as u16,
            Dir::Sell => (fair.saturating_sub(MAX_DEVIATION).div_ceil(TICK)).max(MIN_TICK as u128) as u16,
        };
        match (dir, requested) {
            (Dir::Buy, Some(r)) => tick.min(r),
            (Dir::Sell, Some(r)) => tick.max(r),
            _ => tick,
        }
    }

    /// Handles a transfer of `asset` from `sender`; returns the unused amount or a promise of it.
    fn on_transfer(
        &mut self,
        sender: AccountId,
        asset: Asset,
        amount: u128,
        msg: &str,
    ) -> PromiseOrValue<U128> {
        let msg: TransferMsg = if msg.is_empty() {
            TransferMsg::Deposit
        } else {
            serde_json::from_str(msg).unwrap_or_else(|_| env::panic_str("bad message"))
        };
        match msg {
            TransferMsg::Deposit => {
                self.credit(&sender, asset, amount);
                Event::Deposit { account: &sender, asset, amount: U128(amount) }.emit();
                PromiseOrValue::Value(U128(0))
            }
            TransferMsg::Place { order } => {
                self.credit(&sender, asset, amount);
                Event::Deposit { account: &sender, asset, amount: U128(amount) }.emit();
                self.place(&sender, &order);
                PromiseOrValue::Value(U128(0))
            }
            TransferMsg::Swap { series, side, limit_tick, min_out, anchored } => {
                let dir = match asset {
                    Asset::Usdc => Dir::Buy,
                    Asset::Token { series: s, side: t } => {
                        require!(s == series && t == side, "token does not match the swap");
                        Dir::Sell
                    }
                };
                let m = self
                    .markets
                    .get(&(series, side))
                    .cloned()
                    .unwrap_or_else(|| env::panic_str("unknown market"));
                require!(now_secs() < m.expiry, "market expired");
                if !anchored {
                    let limit = limit_tick.unwrap_or_else(|| env::panic_str("limit_tick required"));
                    let unused = self.swap(&sender, series, side, dir, amount, limit, min_out.0, false, None);
                    return PromiseOrValue::Value(U128(unused));
                }
                PromiseOrValue::Promise(
                    Promise::new(self.registry.clone())
                        .function_call(
                            "index_of",
                            serde_json::json!({ "id": m.trend }).to_string().into_bytes(),
                            NearToken::from_yoctonear(0),
                            GAS_VIEW,
                        )
                        .then(
                            Self::ext(env::current_account_id()).with_static_gas(GAS_AFTER_ANCHOR).with_unused_gas_weight(1).on_anchor(
                                sender,
                                series,
                                side,
                                dir,
                                U128(amount),
                                limit_tick,
                                min_out,
                            ),
                        ),
                )
            }
        }
    }
}

#[near]
impl Book {
    /// Runs an anchored swap once the registry answered. Panics (refunding the whole input
    /// through the token's resolve step) when the index is stale or the trend unknown.
    #[private]
    #[allow(clippy::too_many_arguments)]
    pub fn on_anchor(
        &mut self,
        sender: AccountId,
        series: u64,
        side: Side,
        dir: Dir,
        amount: U128,
        limit_tick: Option<u16>,
        min_out: U128,
        #[callback_result] snapshot: Result<Option<IndexSnapshot>, PromiseError>,
    ) -> U128 {
        let Ok(Some(t)) = snapshot else { env::panic_str("registry unavailable") };
        require!(t.fresh && t.status != Status::Retired, "index stale");
        let m =
            self.markets.get(&(series, side)).cloned().unwrap_or_else(|| env::panic_str("unknown market"));
        let fair_up = fair_up_usdc(t.index, m.opening_index, m.expiry.saturating_sub(now_secs()));
        let fair = match side {
            Side::Up => fair_up,
            Side::Down => ONE_USDC - fair_up,
        };
        let limit = Self::anchored_limit(dir, fair, limit_tick);
        U128(self.swap(&sender, series, side, dir, amount.0, limit, min_out.0, true, Some(fair)))
    }

    /// Cancels up to `max` resting orders of an expired market so their funds return to
    /// balances. Permissionless.
    pub fn cancel_expired(&mut self, series: u64, side: Side, max: Option<u32>) -> u32 {
        self.sweep_expired(series, side, max.unwrap_or(30).min(60))
    }

    /// The USDC a buy of `size` tokens at `tick` locks, for clients.
    pub fn cost_of(&self, size: U128, tick: u16) -> U128 {
        U128(cost(size.0, tick))
    }
}

#[near]
impl FungibleTokenReceiver for Book {
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.usdc, "only USDC");
        self.on_transfer(sender_id, Asset::Usdc, amount.0, &msg)
    }
}

#[near]
impl Book {
    /// NEP-245 receiver for outcome tokens (one token per transfer).
    pub fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        let _ = previous_owner_ids;
        require!(env::predecessor_account_id() == self.outcomes, "only outcome tokens");
        require!(token_ids.len() == 1 && amounts.len() == 1, "one token per transfer");
        let (series, side) = token_ids[0].split_once(':').unwrap_or_else(|| env::panic_str("bad token id"));
        let side = match side {
            "up" => Side::Up,
            "down" => Side::Down,
            _ => env::panic_str("bad token id"),
        };
        let series: u64 = series.parse().unwrap_or_else(|_| env::panic_str("bad token id"));
        match self.on_transfer(sender_id, Asset::Token { series, side }, amounts[0].0, &msg) {
            PromiseOrValue::Value(v) => PromiseOrValue::Value(vec![v]),
            PromiseOrValue::Promise(p) => PromiseOrValue::Promise(
                p.then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(5)).wrap_unused()),
            ),
        }
    }

    /// Turns a single unused amount into the vector NEP-245 expects.
    #[private]
    pub fn wrap_unused(&self, #[callback_unwrap] unused: U128) -> Vec<U128> {
        vec![unused]
    }
}
