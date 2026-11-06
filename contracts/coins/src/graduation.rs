//! Graduation into a Rhea pool, one idempotent step per `graduate` call: create the pool, mint
//! the paired coins, deposit both sides, add the liquidity. A failed step leaves the curve where
//! it was so the next call retries it. LP shares stay with the factory, which cannot withdraw
//! them: graduated liquidity is locked.
//!
//! One step runs at a time per curve: `graduate` refuses while the previous step's callback is
//! pending, so two calls in the same block cannot create two pools or deposit the graduation
//! USDC twice (the second deposit would take another curve's reserve). A step whose callback
//! never ran is retried after [`STEP_TIMEOUT`].

use near_sdk::json_types::U128;
use near_sdk::{env, near, require, serde_json, AccountId, IntoStorageKey, NearToken, Promise, PromiseError};
use tredio_common::now_secs;

use crate::{Coins, CoinsExt, Event, Key, Stage, GAS_CALLBACK, GAS_TRANSFER_CALL, HOLDER_STORAGE};

/// Seconds after which a graduation step still waiting on its callback counts as lost.
pub const STEP_TIMEOUT: u64 = 600;

fn step_key(trend: &str) -> Vec<u8> {
    let mut key = Key::StepInFlight.into_storage_key();
    key.extend_from_slice(trend.as_bytes());
    key
}

const POOL_DEPOSIT: NearToken = NearToken::from_millinear(100);
const LIQUIDITY_DEPOSIT: NearToken = NearToken::from_millinear(10);
const EXCHANGE_STORAGE: NearToken = NearToken::from_millinear(100);
const FT_STORAGE: NearToken = NearToken::from_micronear(1_250);

fn all_succeeded() -> bool {
    let n = env::promise_results_count();
    n > 0 && (0..n).all(|i| env::promise_result_checked(i, 16_384).is_ok())
}

impl Coins {
    /// When the graduation step in flight for `trend` started, unless there is none or it timed out.
    pub(crate) fn step_in_flight(trend: &str) -> Option<u64> {
        let at = env::storage_read(&step_key(trend))?;
        let at = u64::from_le_bytes(at.try_into().ok()?);
        (now_secs() < at + STEP_TIMEOUT).then_some(at)
    }

    fn begin_step(trend: &str) {
        require!(Self::step_in_flight(trend).is_none(), "a graduation step is in flight");
        env::storage_write(&step_key(trend), &now_secs().to_le_bytes());
    }

    fn end_step(trend: &str) {
        env::storage_remove(&step_key(trend));
    }

    fn call(
        &self,
        receiver: &AccountId,
        method: &str,
        args: serde_json::Value,
        deposit: NearToken,
    ) -> Promise {
        Promise::new(receiver.clone()).function_call(
            method,
            args.to_string().into_bytes(),
            deposit,
            GAS_TRANSFER_CALL,
        )
    }
}

#[near]
impl Coins {
    /// Registers the factory with the exchange and the exchange with USDC, once, before the first
    /// graduation. Owner only; the owner pays both deposits (0.10125 NEAR), so a function-call key,
    /// which cannot attach NEAR, cannot spend the factory's balance on them.
    #[payable]
    pub fn prepare_exchange(&mut self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(
            env::attached_deposit() >= EXCHANGE_STORAGE.saturating_add(FT_STORAGE),
            "attach the exchange's and USDC's storage deposits (0.10125 NEAR)"
        );
        self.call(&self.exchange, "storage_deposit", serde_json::json!({}), EXCHANGE_STORAGE).detach();
        self.call(
            &self.usdc,
            "storage_deposit",
            serde_json::json!({ "account_id": self.exchange }),
            FT_STORAGE,
        )
        .detach();
    }

    /// Advances a filled curve's graduation by one step. Permissionless; the keeper calls it
    /// until the curve reports `graduated`. Returns the stage reached.
    pub fn graduate(&mut self, trend: String) -> Promise {
        let c = self.get(&trend);
        if matches!(c.stage, Stage::Ready | Stage::Pooled) {
            Self::begin_step(&trend);
        }
        let me = env::current_account_id();
        let cb = Self::ext(me.clone()).with_static_gas(GAS_CALLBACK);
        match c.stage {
            Stage::Ready => self
                .call(
                    &self.exchange,
                    "register_tokens",
                    serde_json::json!({ "token_ids": [c.coin, self.usdc] }),
                    NearToken::from_yoctonear(1),
                )
                .then(self.call(
                    &self.exchange,
                    "add_simple_pool",
                    serde_json::json!({ "tokens": [c.coin, self.usdc], "fee": self.pool_fee_bps }),
                    POOL_DEPOSIT,
                ))
                .then(cb.on_pool_created(trend)),
            Stage::Pooled if !c.grad_minted => self
                .call(
                    &c.coin,
                    "mint",
                    serde_json::json!({ "account_id": me, "amount": c.grad_coins }),
                    HOLDER_STORAGE,
                )
                .and(self.call(
                    &c.coin,
                    "storage_deposit",
                    serde_json::json!({ "account_id": self.exchange }),
                    FT_STORAGE,
                ))
                .then(cb.on_grad_minted(trend)),
            Stage::Pooled if !c.coins_deposited => self
                .call(
                    &c.coin,
                    "ft_transfer_call",
                    serde_json::json!({ "receiver_id": self.exchange, "amount": c.grad_coins, "msg": "" }),
                    NearToken::from_yoctonear(1),
                )
                .then(cb.on_deposited(trend, true)),
            Stage::Pooled if !c.quote_deposited => self
                .call(
                    &self.usdc,
                    "ft_transfer_call",
                    serde_json::json!({ "receiver_id": self.exchange, "amount": c.grad_quote, "msg": "" }),
                    NearToken::from_yoctonear(1),
                )
                .then(cb.on_deposited(trend, false)),
            Stage::Pooled => self
                .call(
                    &self.exchange,
                    "add_liquidity",
                    serde_json::json!({ "pool_id": c.pool_id, "amounts": [c.grad_coins, c.grad_quote] }),
                    LIQUIDITY_DEPOSIT,
                )
                .then(cb.on_liquidity_added(trend)),
            Stage::Graduated => env::panic_str("already graduated"),
            _ => env::panic_str("not ready"),
        }
    }

    /// The pool exists: the curve closes and its USDC is frozen for graduation, paired with
    /// coins at the final spot price.
    #[private]
    pub fn on_pool_created(
        &mut self,
        trend: String,
        #[callback_result] pool_id: Result<u64, PromiseError>,
    ) -> Stage {
        Self::end_step(&trend);
        let mut c = self.get(&trend);
        let Ok(pool_id) = pool_id else {
            Event::GraduationStep { trend: &trend, step: "pool", ok: false }.emit();
            return c.stage;
        };
        if c.stage != Stage::Ready {
            return c.stage;
        }
        let (coins, quote) = c.math.graduation_amounts();
        c.grad_coins = U128(coins);
        c.grad_quote = U128(quote);
        c.math.reserve = 0;
        c.math.floor_reserve = 0;
        c.math.graduation_liquidity = 0;
        c.pool_id = Some(pool_id);
        c.stage = Stage::Pooled;
        Event::GraduationStep { trend: &trend, step: "pool", ok: true }.emit();
        self.curves.insert(trend, c);
        Stage::Pooled
    }

    #[private]
    pub fn on_grad_minted(&mut self, trend: String) -> bool {
        Self::end_step(&trend);
        let ok = all_succeeded();
        let mut c = self.get(&trend);
        // A mint that succeeded while registering the exchange failed is kept, and only the
        // registration is retried next time.
        let minted = env::promise_result_checked(0, 16_384).is_ok();
        c.grad_minted = c.grad_minted || minted;
        Event::GraduationStep { trend: &trend, step: "mint", ok }.emit();
        self.curves.insert(trend, c);
        ok
    }

    #[private]
    pub fn on_deposited(&mut self, trend: String, coins: bool) -> bool {
        Self::end_step(&trend);
        let mut c = self.get(&trend);
        let want = if coins { c.grad_coins.0 } else { c.grad_quote.0 };
        let used = env::promise_result_checked(0, 64)
            .ok()
            .and_then(|b| serde_json::from_slice::<U128>(&b).ok())
            .map_or(0, |u| u.0);
        let ok = used == want;
        if coins {
            c.coins_deposited = ok;
        } else {
            c.quote_deposited = ok;
        }
        Event::GraduationStep {
            trend: &trend,
            step: if coins { "deposit_coins" } else { "deposit_usdc" },
            ok,
        }
        .emit();
        self.curves.insert(trend, c);
        ok
    }

    #[private]
    pub fn on_liquidity_added(&mut self, trend: String) -> Stage {
        Self::end_step(&trend);
        let mut c = self.get(&trend);
        if !tredio_common::promise_succeeded() {
            Event::GraduationStep { trend: &trend, step: "liquidity", ok: false }.emit();
            return c.stage;
        }
        c.stage = Stage::Graduated;
        Event::Graduated {
            trend: &trend,
            exchange: &self.exchange,
            pool_id: c.pool_id.unwrap_or_default(),
            coins: c.grad_coins,
            usdc: c.grad_quote,
        }
        .emit();
        self.curves.insert(trend, c);
        Stage::Graduated
    }
}
