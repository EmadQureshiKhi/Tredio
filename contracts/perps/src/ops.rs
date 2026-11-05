//! Opening, closing, liquidating and settling positions. Every operation that needs the index
//! reads it from the registry first and acts in the callback; a refused open returns the whole
//! margin through the token's resolve step.

use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, serde_json, AccountId, NearToken, Promise, PromiseError, PromiseOrValue};
use tredio_common::math::{mul_div_floor, UWAD};
use tredio_common::{now_secs, IndexSnapshot, Status, BPS};

use crate::{
    funding_owed, notional, oi_cap, pnl_of, Event, Perps, PerpsExt, Position, GAS_AFTER_REGISTRY,
    GAS_REGISTRY, LIQUIDATION_REWARD_BPS, MAINTENANCE_MARGIN_BPS, MAX_LEVERAGE_BPS, MIN_MARGIN,
    TRADE_FEE_BPS,
};

/// What USDC senders put in `msg`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum FtMsg {
    /// Opens a position with the attached USDC as margin (fee included). `leverage_bps` is
    /// notional over net margin (10000 = 1x, at most 30000). `acceptable_index` is the highest
    /// entry for a long and the lowest for a short. `owner` defaults to the sender.
    Open {
        trend: String,
        is_long: bool,
        leverage_bps: u32,
        acceptable_index: u64,
        deadline: Option<u64>,
        owner: Option<AccountId>,
    },
    /// Adds the attached USDC to the sender's own position.
    AddMargin { id: u64 },
    /// Adds the attached USDC to the pool (insurance); never withdrawable, only backs traders.
    DepositPool,
}

impl Perps {
    fn read_index(&self, trend: &str) -> Promise {
        Promise::new(self.registry.clone()).function_call(
            "index_of",
            serde_json::json!({ "id": trend }).to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            GAS_REGISTRY,
        )
    }

    fn get(&self, id: u64) -> Position {
        self.positions.get(&id).cloned().unwrap_or_else(|| env::panic_str("unknown position"))
    }

    fn remove(&mut self, p: &Position) {
        let mut m = self.markets.get(&p.trend).cloned().unwrap_or_default();
        if p.is_long {
            m.long_qty = U128(m.long_qty.0 - p.qty.0);
        } else {
            m.short_qty = U128(m.short_qty.0 - p.qty.0);
        }
        self.markets.insert(p.trend.clone(), m);
        self.total_margin -= p.margin.0;
        self.positions.remove(&p.id);
        self.remove_owner_position(&p.owner, p.id);
    }

    /// Settles `p` at `index` with `fee`, pays the owner and returns the payout.
    fn settle(
        &mut self,
        p: &Position,
        index: u64,
        fee: u128,
        surfacer: Option<AccountId>,
        retired: bool,
    ) -> u128 {
        let m = self.markets.get(&p.trend).cloned().unwrap_or_default();
        let delta = if p.is_long { m.cum_long } else { m.cum_short } - p.entry_funding;
        let funding = funding_owed(p.qty.0, delta);
        let pnl = pnl_of(p, index);
        let equity = p.margin.0 as i128 + pnl - funding;
        self.remove(p);
        self.pool += p.margin.0;
        let (mut payout, mut fee_charged) = (0u128, 0u128);
        if equity > 0 {
            fee_charged = fee.min(equity as u128);
            payout = equity as u128 - fee_charged;
            if payout > self.pool {
                Event::SocializedLoss { id: p.id, shortfall: U128(payout - self.pool) }.emit();
                payout = self.pool;
            }
            // The trader is paid first; the fee takes only what the pool has left.
            fee_charged = fee_charged.min(self.pool - payout);
            self.pool -= payout + fee_charged;
        }
        let to_curation = self.book_fee(fee_charged);
        self.pay_curation(&p.trend, surfacer, to_curation);
        if payout > 0 {
            self.send_usdc(&p.owner, payout).detach();
        }
        Event::PositionClosed {
            id: p.id,
            owner: &p.owner,
            trend: &p.trend,
            is_long: p.is_long,
            entry_index: p.entry_index,
            exit_index: index,
            qty: p.qty,
            margin: p.margin,
            pnl: pnl.to_string(),
            funding: funding.to_string(),
            fee: U128(fee_charged),
            payout: U128(payout),
            retired,
        }
        .emit();
        payout
    }
}

#[near]
impl FungibleTokenReceiver for Perps {
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.usdc, "only USDC");
        let msg: FtMsg = serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("bad message"));
        match msg {
            FtMsg::Open { trend, is_long, leverage_bps, acceptable_index, deadline, owner } => {
                require!(leverage_bps > 0 && leverage_bps <= MAX_LEVERAGE_BPS, "invalid leverage");
                let owner = owner.unwrap_or_else(|| sender_id.clone());
                require!(self.storage.is_registered(&owner), "owner is not registered for storage");
                PromiseOrValue::Promise(self.read_index(&trend).then(
                    Self::ext(env::current_account_id()).with_static_gas(GAS_AFTER_REGISTRY).with_unused_gas_weight(1).on_open(
                        sender_id,
                        owner,
                        trend,
                        is_long,
                        amount,
                        leverage_bps,
                        acceptable_index,
                        deadline,
                    ),
                ))
            }
            FtMsg::AddMargin { id } => {
                let mut p = self.get(id);
                // Only the owner tops up: otherwise a capped session could move the account's
                // USDC into a position someone else controls.
                require!(p.owner == sender_id, "not your position");
                p.margin = U128(p.margin.0 + amount.0);
                self.total_margin += amount.0;
                self.positions.insert(id, p);
                Event::MarginAdded { id, payer: &sender_id, amount }.emit();
                PromiseOrValue::Value(U128(0))
            }
            FtMsg::DepositPool => {
                self.pool += amount.0;
                Event::PoolDeposit { from: &sender_id, amount }.emit();
                PromiseOrValue::Value(U128(0))
            }
        }
    }
}

#[near]
impl Perps {
    /// Opens the position once the registry answered, or refuses it and returns the margin.
    #[private]
    #[allow(clippy::too_many_arguments)]
    pub fn on_open(
        &mut self,
        payer: AccountId,
        owner: AccountId,
        trend: String,
        is_long: bool,
        margin: U128,
        leverage_bps: u32,
        acceptable_index: u64,
        deadline: Option<u64>,
        #[callback_result] snapshot: Result<Option<IndexSnapshot>, PromiseError>,
    ) -> U128 {
        let refuse = |reason: &str| {
            Event::OpenRefused { owner: &owner, trend: &trend, reason, amount: margin }.emit();
            margin
        };
        let Ok(Some(t)) = snapshot else { return refuse("registry unavailable") };
        if t.status != Status::Active {
            return refuse("trend not active");
        }
        if !t.fresh {
            return refuse("index stale");
        }
        if deadline.is_some_and(|d| now_secs() > d) {
            return refuse("expired");
        }
        let index = t.index;
        if if is_long { index > acceptable_index } else { index < acceptable_index } {
            return refuse("price not acceptable");
        }
        // margin = net + fee and fee = net x leverage x fee rate.
        let net = mul_div_floor(margin.0, BPS * BPS, BPS * BPS + leverage_bps as u128 * TRADE_FEE_BPS);
        if net < MIN_MARGIN {
            return refuse("margin too small");
        }
        let fee = margin.0 - net;
        let notional_usdc = net * leverage_bps as u128 / BPS;
        let qty = mul_div_floor(notional_usdc, UWAD, index as u128);
        if qty == 0 {
            return refuse("size too small");
        }
        let m = self.markets.get(&trend).cloned().unwrap_or_default();
        let side_qty = if is_long { m.long_qty.0 } else { m.short_qty.0 } + qty;
        if notional(side_qty, index) > oi_cap(self.pool, self.max_oi_per_side, index) {
            return refuse("open interest cap");
        }
        if self.by_owner.get(&owner).is_some_and(|ids| ids.len() >= crate::MAX_POSITIONS_PER_OWNER) {
            return refuse("too many open positions");
        }
        let mut m = self.accrue(&trend, index, false);
        if is_long {
            m.long_qty = U128(side_qty);
        } else {
            m.short_qty = U128(side_qty);
        }
        let entry_funding = if is_long { m.cum_long } else { m.cum_short };
        self.markets.insert(trend.clone(), m);
        let id = self.next_position;
        self.next_position += 1;
        self.add_owner_position(&owner, id);
        self.positions.insert(
            id,
            Position {
                id,
                owner: owner.clone(),
                trend: trend.clone(),
                is_long,
                entry_index: index,
                qty: U128(qty),
                margin: U128(net),
                entry_funding,
                opened_at: now_secs(),
            },
        );
        self.total_margin += net;
        let to_curation = self.book_fee(fee);
        self.pay_curation(&trend, t.surfacer.clone(), to_curation);
        Event::PositionOpened {
            id,
            owner: &owner,
            trend: &trend,
            is_long,
            qty: U128(qty),
            margin: U128(net),
            entry_index: index,
            fee: U128(fee),
            payer: &payer,
        }
        .emit();
        U128(0)
    }

    /// Closes the caller's position at the current index. `acceptable_index` is the lowest exit
    /// for a long and the highest for a short.
    pub fn close(&mut self, id: u64, acceptable_index: u64) -> Promise {
        let p = self.get(id);
        require!(p.owner == env::predecessor_account_id(), "not your position");
        self.read_index(&p.trend).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_AFTER_REGISTRY)
                .on_close(id, acceptable_index),
        )
    }

    #[private]
    pub fn on_close(
        &mut self,
        id: u64,
        acceptable_index: u64,
        #[callback_result] snapshot: Result<Option<IndexSnapshot>, PromiseError>,
    ) -> U128 {
        let Ok(Some(t)) = snapshot else { env::panic_str("registry unavailable") };
        let p = self.get(id);
        require!(t.status != Status::Retired, "trend retired: use settle_retired");
        require!(t.fresh, "index stale");
        let index = t.index;
        require!(
            if p.is_long { index >= acceptable_index } else { index <= acceptable_index },
            "price not acceptable"
        );
        self.accrue(&p.trend, index, false);
        let fee = notional(p.qty.0, index) * TRADE_FEE_BPS / BPS;
        U128(self.settle(&p, index, fee, t.surfacer, false))
    }

    /// Settles a position of a retired trend at the final index, with no fee, paying its owner.
    /// Permissionless so positions never stay stranded.
    pub fn settle_retired(&mut self, id: u64) -> Promise {
        let p = self.get(id);
        self.read_index(&p.trend).then(
            Self::ext(env::current_account_id()).with_static_gas(GAS_AFTER_REGISTRY).with_unused_gas_weight(1).on_settle_retired(id),
        )
    }

    #[private]
    pub fn on_settle_retired(
        &mut self,
        id: u64,
        #[callback_result] snapshot: Result<Option<IndexSnapshot>, PromiseError>,
    ) -> U128 {
        let Ok(Some(t)) = snapshot else { env::panic_str("registry unavailable") };
        require!(t.status == Status::Retired, "trend not retired");
        let p = self.get(id);
        self.accrue(&p.trend, t.index, true);
        U128(self.settle(&p, t.index, 0, t.surfacer, true))
    }

    /// Liquidates a position whose equity is below maintenance. Permissionless; the caller earns
    /// up to 1% of notional from the remaining equity.
    pub fn liquidate(&mut self, id: u64) -> Promise {
        let p = self.get(id);
        self.read_index(&p.trend).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_AFTER_REGISTRY)
                .on_liquidate(id, env::predecessor_account_id()),
        )
    }

    #[private]
    pub fn on_liquidate(
        &mut self,
        id: u64,
        liquidator: AccountId,
        #[callback_result] snapshot: Result<Option<IndexSnapshot>, PromiseError>,
    ) -> U128 {
        let Ok(Some(t)) = snapshot else { env::panic_str("registry unavailable") };
        require!(t.status != Status::Retired, "trend retired: use settle_retired");
        require!(t.fresh, "index stale");
        let p = self.get(id);
        let index = t.index;
        let m = self.accrue(&p.trend, index, false);
        let delta = if p.is_long { m.cum_long } else { m.cum_short } - p.entry_funding;
        let equity = p.margin.0 as i128 + pnl_of(&p, index) - funding_owed(p.qty.0, delta);
        let n = notional(p.qty.0, index);
        require!(equity < (n * MAINTENANCE_MARGIN_BPS / BPS) as i128, "not liquidatable");
        self.remove(&p);
        self.pool += p.margin.0;
        let mut reward = 0;
        if equity > 0 {
            reward = (n * LIQUIDATION_REWARD_BPS / BPS).min(equity as u128).min(self.pool);
            self.pool -= reward;
            if reward > 0 {
                self.send_usdc(&liquidator, reward).detach();
            }
        }
        Event::PositionLiquidated {
            id,
            owner: &p.owner,
            liquidator: &liquidator,
            exit_index: index,
            equity: equity.to_string(),
            reward: U128(reward),
        }
        .emit();
        U128(reward)
    }

    /// Accrues funding to now and refreshes the mark. Permissionless (the keeper pokes).
    pub fn poke(&mut self, trend: String) -> Promise {
        self.read_index(&trend)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_AFTER_REGISTRY).with_unused_gas_weight(1).on_poke(trend))
    }

    #[private]
    pub fn on_poke(
        &mut self,
        trend: String,
        #[callback_result] snapshot: Result<Option<IndexSnapshot>, PromiseError>,
    ) {
        let Ok(Some(t)) = snapshot else { env::panic_str("registry unavailable") };
        self.accrue(&trend, t.index, t.status == Status::Retired);
    }
}
