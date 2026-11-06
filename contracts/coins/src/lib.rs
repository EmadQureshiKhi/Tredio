//! # Tredio trend coins
//!
//! The launch layer: one trend coin per trend on a constant-product bonding curve priced in USDC,
//! with a floor that ratchets up with the trend's peak attention (see [`curve`]). Each coin is
//! its own NEP-141 account, `<trend slug>.coins.<root>`, created by this factory from the coin
//! code published once as a global contract.
//!
//! - Buy: send USDC with `ft_transfer_call` and `{"buy": {...}}`; the factory reads the registry
//!   (the trend must be active; its peak raises the floor), prices the trade and mints the coins
//!   to the buyer.
//! - Sell: send coins back with `ft_transfer_call` and `{"sell": {...}}`; the factory burns them
//!   and pays USDC.
//! - Fee: 1% of every trade: 30% to the floor reserve, 30% to graduation liquidity, 10% to the
//!   trend's curator, the rest to the treasury.
//! - Graduation: once the reserve reaches the threshold the curve stops selling coins and anyone
//!   can call `graduate` step by step: create a Rhea pool for the coin against USDC, deposit the
//!   reserve with coins at the final spot price, and add it as liquidity. The factory has no way
//!   to remove that liquidity, so it stays locked in the pool.

pub mod curve;
mod graduation;
#[cfg(test)]
mod tests;

use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::{Base58CryptoHash, U128};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, near, require, serde_json, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};
use tredio_common::{is_normalized, now_secs, IndexSnapshot, Status, ONE_USDC};

use crate::curve::{ratchet_bps, CurveError, CurveMath, Trade};

/// NEAR given to a new coin account for its state (the code itself is global).
pub const COIN_ACCOUNT_DEPOSIT: NearToken = NearToken::from_millinear(30);
/// Storage for a new coin holder, attached to each mint (unused part comes back).
pub const HOLDER_STORAGE: NearToken = NearToken::from_micronear(1_250);

pub(crate) const GAS_VIEW: Gas = Gas::from_tgas(10);
pub(crate) const GAS_CALLBACK: Gas = Gas::from_tgas(40);
pub(crate) const GAS_SMALL: Gas = Gas::from_tgas(10);
pub(crate) const GAS_TRANSFER: Gas = Gas::from_tgas(15);
pub(crate) const GAS_TRANSFER_CALL: Gas = Gas::from_tgas(60);

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    /// The coin account is being created.
    Creating,
    Open,
    /// Filled: waits for `graduate`; holders can still sell back.
    Ready,
    /// The Rhea pool exists; liquidity is being moved in.
    Pooled,
    Graduated,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Curve {
    pub trend: String,
    pub coin: AccountId,
    pub stage: Stage,
    pub peak_at_creation: u64,
    pub created_at: u64,
    #[serde(flatten)]
    pub math: CurveMath,
    pub pool_id: Option<u64>,
    /// Coins and USDC moved into the pool at graduation.
    pub grad_coins: U128,
    pub grad_quote: U128,
    pub grad_minted: bool,
    pub coins_deposited: bool,
    pub quote_deposited: bool,
}

/// What USDC or coin senders put in `msg`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum FtMsg {
    /// USDC in: buy `trend`'s coin, at least `min_out`, to `receiver` (default: sender).
    Buy { trend: String, min_out: U128, receiver: Option<AccountId> },
    /// Coins in: sell them for at least `min_out` USDC, to `receiver` (default: sender).
    Sell { min_out: U128, receiver: Option<AccountId> },
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Quote {
    pub out: U128,
    pub fee: U128,
    /// Spot price after the trade, USDC (6 decimals) per whole coin, WAD-scaled.
    pub spot_after: U128,
}

#[near(event_json(standard = "tredio-coins"))]
pub enum Event<'a> {
    #[event_version("1.0.0")]
    CurveCreated { trend: &'a str, coin: &'a AccountId, virtual_quote: U128, peak_at_creation: u64 },
    #[event_version("1.0.0")]
    CurveFailed { trend: &'a str, coin: &'a AccountId },
    #[event_version("1.0.0")]
    Trade {
        trend: &'a str,
        trader: &'a AccountId,
        is_buy: bool,
        usdc: U128,
        coins: U128,
        fee: U128,
        reserve: U128,
        sold: U128,
        spot: U128,
    },
    #[event_version("1.0.0")]
    FloorRaised { trend: &'a str, virtual_quote: U128, cost: U128, ratchet_bps: U128 },
    #[event_version("1.0.0")]
    GraduationReady { trend: &'a str, reserve: U128 },
    #[event_version("1.0.0")]
    GraduationStep { trend: &'a str, step: &'a str, ok: bool },
    #[event_version("1.0.0")]
    Graduated { trend: &'a str, exchange: &'a AccountId, pool_id: u64, coins: U128, usdc: U128 },
    #[event_version("1.0.0")]
    TradeRefused { trend: &'a str, trader: &'a AccountId, reason: &'a str, amount: U128 },
    #[event_version("1.0.0")]
    DeliveryDeferred { trend: &'a str, account: &'a AccountId, coins: U128, usdc: U128 },
}

#[derive(BorshStorageKey)]
#[near]
pub(crate) enum Key {
    Curves,
    Trends,
    ByCoin,
    OwedCoins,
    OwedUsdc,
    /// Graduation steps waiting on their callback, per trend (see `graduation`). Kept outside
    /// the root state so contracts deployed before it read their state unchanged.
    StepInFlight,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Coins {
    pub(crate) owner: AccountId,
    pub(crate) usdc: AccountId,
    pub(crate) registry: AccountId,
    pub(crate) curation: AccountId,
    pub(crate) treasury: AccountId,
    /// The Rhea exchange (`ref-finance-101.testnet`, `v2.ref-finance.near`).
    pub(crate) exchange: AccountId,
    pub(crate) pool_fee_bps: u32,
    pub(crate) coin_code: Base58CryptoHash,
    pub(crate) base_virtual_quote: u128,
    pub(crate) graduation_reserve: u128,
    pub(crate) curves: LookupMap<String, Curve>,
    pub(crate) trends: Vector<String>,
    pub(crate) by_coin: LookupMap<AccountId, String>,
    /// Coins a mint failed to deliver, per `<trend>|<account>`.
    pub(crate) owed_coins: LookupMap<String, u128>,
    /// USDC a sale failed to deliver.
    pub(crate) owed_usdc: LookupMap<AccountId, u128>,
    pub(crate) protocol_fees: u128,
}

/// `topic:openai.2` becomes `topic-openai-2`, a valid sub-account label.
pub fn slug(identifier: &str) -> String {
    identifier.chars().map(|c| if c == ':' || c == '.' || c == '_' { '-' } else { c }).collect()
}

/// `topic:openai.2` becomes `OPENAI`.
pub fn symbol(identifier: &str) -> String {
    let core = identifier.split(':').nth(1).unwrap_or(identifier).split('.').next().unwrap_or(identifier);
    core.chars().filter(|c| c.is_ascii_alphanumeric()).take(12).collect::<String>().to_uppercase()
}

#[near]
impl Coins {
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner: AccountId,
        usdc: AccountId,
        registry: AccountId,
        curation: AccountId,
        treasury: AccountId,
        exchange: AccountId,
        pool_fee_bps: u32,
        coin_code: Base58CryptoHash,
        base_virtual_quote: U128,
        graduation_reserve: U128,
    ) -> Self {
        require!(
            (100 * ONE_USDC..=1_000_000 * ONE_USDC).contains(&base_virtual_quote.0)
                && graduation_reserve.0 >= base_virtual_quote.0 / 10
                && graduation_reserve.0 <= 10 * base_virtual_quote.0,
            "invalid params"
        );
        require!((1..=100).contains(&pool_fee_bps), "invalid pool fee");
        Self {
            owner,
            usdc,
            registry,
            curation,
            treasury,
            exchange,
            pool_fee_bps,
            coin_code,
            base_virtual_quote: base_virtual_quote.0,
            graduation_reserve: graduation_reserve.0,
            curves: LookupMap::new(Key::Curves),
            trends: Vector::new(Key::Trends),
            by_coin: LookupMap::new(Key::ByCoin),
            owed_coins: LookupMap::new(Key::OwedCoins),
            owed_usdc: LookupMap::new(Key::OwedUsdc),
            protocol_fees: 0,
        }
    }

    /// Points future coins at a newly published global coin code. Existing coins keep theirs.
    pub fn set_coin_code(&mut self, coin_code: Base58CryptoHash) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        self.coin_code = coin_code;
    }

    // ---------------------------------------------------------------------------------------
    // Creation
    // ---------------------------------------------------------------------------------------

    /// Creates the trend's coin and curve. Permissionless while the trend is active.
    pub fn create_curve(&mut self, trend: String) -> Promise {
        require!(is_normalized(&trend), "bad trend identifier");
        require!(!self.curves.contains_key(&trend), "curve exists");
        self.read_index(&trend).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CALLBACK.saturating_mul(2))
                .with_unused_gas_weight(1)
                .on_create_checked(trend),
        )
    }

    #[private]
    pub fn on_create_checked(
        &mut self,
        trend: String,
        #[callback_result] snapshot: Result<Option<IndexSnapshot>, PromiseError>,
    ) -> Option<Promise> {
        let t = match snapshot {
            Ok(Some(t)) if t.status == Status::Active => t,
            _ => return None,
        };
        if self.curves.contains_key(&trend) {
            return None;
        }
        let coin: AccountId = format!("{}.{}", slug(&trend), env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("trend identifier too long for a coin account"));
        self.curves.insert(
            trend.clone(),
            Curve {
                trend: trend.clone(),
                coin: coin.clone(),
                stage: Stage::Creating,
                peak_at_creation: t.peak_index,
                created_at: now_secs(),
                math: CurveMath::new(self.base_virtual_quote),
                pool_id: None,
                grad_coins: U128(0),
                grad_quote: U128(0),
                grad_minted: false,
                coins_deposited: false,
                quote_deposited: false,
            },
        );
        let args = serde_json::json!({
            "minter": env::current_account_id(),
            "trend": trend,
            "name": format!("Tredio {trend}"),
            "symbol": symbol(&trend),
            "icon": null,
        });
        Some(
            Promise::new(coin)
                .create_account()
                .transfer(COIN_ACCOUNT_DEPOSIT)
                .use_global_contract(self.coin_code)
                .function_call("new", args.to_string().into_bytes(), NearToken::from_yoctonear(0), GAS_SMALL)
                .then(Self::ext(env::current_account_id()).with_static_gas(GAS_SMALL).on_coin_created(trend)),
        )
    }

    #[private]
    pub fn on_coin_created(&mut self, trend: String) -> bool {
        let mut c = self.get(&trend);
        if !tredio_common::promise_succeeded() {
            Event::CurveFailed { trend: &trend, coin: &c.coin }.emit();
            self.curves.remove(&trend);
            return false;
        }
        c.stage = Stage::Open;
        Event::CurveCreated {
            trend: &trend,
            coin: &c.coin,
            virtual_quote: U128(c.math.virtual_quote),
            peak_at_creation: c.peak_at_creation,
        }
        .emit();
        self.by_coin.insert(c.coin.clone(), trend.clone());
        self.trends.push(trend.clone());
        self.curves.insert(trend, c);
        true
    }

    // ---------------------------------------------------------------------------------------
    // Floor
    // ---------------------------------------------------------------------------------------

    /// Raises the trend's floor as far as its peak attention and floor reserve allow.
    /// Permissionless; buys do it automatically.
    pub fn sync_floor(&mut self, trend: String) -> Promise {
        require!(self.get(&trend).stage == Stage::Open, "curve closed");
        self.read_index(&trend)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_sync(trend))
    }

    #[private]
    pub fn on_sync(
        &mut self,
        trend: String,
        #[callback_result] snapshot: Result<Option<IndexSnapshot>, PromiseError>,
    ) {
        let Ok(Some(t)) = snapshot else { env::panic_str("registry unavailable") };
        let mut c = self.get(&trend);
        self.raise_floor(&mut c, t.peak_index);
        self.curves.insert(trend, c);
    }

    // ---------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------

    pub fn get_curve(&self, trend: String) -> Option<Curve> {
        self.curves.get(&trend).cloned()
    }

    pub fn get_curves(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Curve> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(200);
        (from..self.trends.len().min(from.saturating_add(limit)))
            .filter_map(|i| self.trends.get(i).and_then(|t| self.curves.get(t).cloned()))
            .collect()
    }

    pub fn trend_of_coin(&self, coin: AccountId) -> Option<String> {
        self.by_coin.get(&coin).cloned()
    }

    /// Spot price in USDC (6 decimals) per whole coin, WAD-scaled.
    pub fn spot_price(&self, trend: String) -> U128 {
        U128(self.get(&trend).math.spot_wad())
    }

    /// Coins out for `usdc_in` (fee included). A buy first raises the floor to the trend's peak
    /// attention, so pass the registry's `peak_index` (from `index_of`) to quote what a buy gets
    /// now; without it the quote is the stored state, which a peak that rose since the last trade
    /// prices too low.
    pub fn quote_buy(&self, trend: String, usdc_in: U128, peak_index: Option<u64>) -> Option<Quote> {
        let c = self.get(&trend);
        let mut m = c.math;
        if let Some(peak) = peak_index {
            m.raise_floor(self.base_virtual_quote, ratchet_bps(peak, c.peak_at_creation));
        }
        m.buy(usdc_in.0, 0).ok().map(|t| Quote {
            out: U128(t.out),
            fee: U128(t.fee),
            spot_after: U128(m.spot_wad()),
        })
    }

    /// USDC out for `coins_in` (fee deducted) at the current state.
    pub fn quote_sell(&self, trend: String, coins_in: U128) -> Option<Quote> {
        let mut m = self.get(&trend).math;
        m.sell(coins_in.0, 0).ok().map(|t| Quote {
            out: U128(t.out),
            fee: U128(t.fee),
            spot_after: U128(m.spot_wad()),
        })
    }

    pub fn graduation_reserve(&self) -> U128 {
        U128(self.graduation_reserve)
    }

    pub fn protocol_fees(&self) -> U128 {
        U128(self.protocol_fees)
    }

    pub fn owed(&self, trend: String, account_id: AccountId) -> (U128, U128) {
        (
            U128(self.owed_coins.get(&format!("{trend}|{account_id}")).copied().unwrap_or(0)),
            U128(self.owed_usdc.get(&account_id).copied().unwrap_or(0)),
        )
    }
}

impl Coins {
    pub(crate) fn get(&self, trend: &str) -> Curve {
        self.curves.get(trend).cloned().unwrap_or_else(|| env::panic_str("unknown curve"))
    }

    pub(crate) fn read_index(&self, trend: &str) -> Promise {
        Promise::new(self.registry.clone()).function_call(
            "index_of",
            serde_json::json!({ "id": trend }).to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            GAS_VIEW,
        )
    }

    fn raise_floor(&self, c: &mut Curve, peak: u64) {
        let ratchet = ratchet_bps(peak, c.peak_at_creation);
        if let Some(cost) = c.math.raise_floor(self.base_virtual_quote, ratchet) {
            Event::FloorRaised {
                trend: &c.trend,
                virtual_quote: U128(c.math.virtual_quote),
                cost: U128(cost),
                ratchet_bps: U128(ratchet),
            }
            .emit();
        }
    }

    fn book(&mut self, c: &Curve, t: &Trade, surfacer: Option<AccountId>) {
        self.protocol_fees += t.to_protocol;
        if t.to_curation > 0 {
            Promise::new(self.usdc.clone())
                .function_call(
                    "ft_transfer_call",
                    serde_json::json!({
                        "receiver_id": self.curation,
                        "amount": U128(t.to_curation),
                        "msg": serde_json::json!({ "trend": c.trend, "surfacer": surfacer }).to_string(),
                    })
                    .to_string()
                    .into_bytes(),
                    NearToken::from_yoctonear(1),
                    GAS_TRANSFER_CALL,
                )
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_SMALL)
                        .after_curation(U128(t.to_curation)),
                )
                .detach();
        }
    }

    fn mint_to(&self, c: &Curve, to: &AccountId, coins: u128) {
        Promise::new(c.coin.clone())
            .function_call(
                "mint",
                serde_json::json!({ "account_id": to, "amount": U128(coins) }).to_string().into_bytes(),
                HOLDER_STORAGE,
                GAS_SMALL,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_SMALL).after_mint(
                c.trend.clone(),
                to.clone(),
                U128(coins),
            ))
            .detach();
    }

    fn pay_usdc(&self, trend: &str, to: &AccountId, amount: u128) {
        Promise::new(self.usdc.clone())
            .function_call(
                "ft_transfer",
                serde_json::json!({ "receiver_id": to, "amount": U128(amount) }).to_string().into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_TRANSFER,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_SMALL).after_pay(
                trend.to_string(),
                to.clone(),
                U128(amount),
            ))
            .detach();
    }

    fn curve_error(e: CurveError) -> ! {
        env::panic_str(match e {
            CurveError::ZeroAmount => "amount too small",
            CurveError::Slippage => "slippage",
            CurveError::PriceImpact => "price impact above 20%",
            CurveError::InsufficientReserve => "insufficient reserve",
        })
    }

    /// Sells coins the factory just received from `seller`.
    fn sell(&mut self, trend: &str, seller: &AccountId, coins: u128, min_out: u128, receiver: &AccountId) {
        let mut c = self.get(trend);
        require!(matches!(c.stage, Stage::Open | Stage::Ready), "curve closed");
        // While the pool is being created a sale could drop the reserve under the threshold and
        // reopen the curve, orphaning the pool the factory just paid for.
        require!(c.stage != Stage::Ready || Self::step_in_flight(trend).is_none(), "graduation in progress");
        let t = c.math.sell(coins, min_out).unwrap_or_else(|e| Self::curve_error(e));
        if c.stage == Stage::Ready && c.math.reserve < self.graduation_reserve {
            c.stage = Stage::Open;
        }
        Promise::new(c.coin.clone())
            .function_call(
                "burn",
                serde_json::json!({ "amount": U128(coins) }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_SMALL,
            )
            .detach();
        self.book(&c, &t, None);
        self.pay_usdc(trend, receiver, t.out);
        Event::Trade {
            trend,
            trader: seller,
            is_buy: false,
            usdc: U128(t.out),
            coins: U128(coins),
            fee: U128(t.fee),
            reserve: U128(c.math.reserve),
            sold: U128(c.math.sold),
            spot: U128(c.math.spot_wad()),
        }
        .emit();
        self.curves.insert(trend.to_string(), c);
    }
}

#[near]
impl FungibleTokenReceiver for Coins {
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        let msg: FtMsg = serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("bad message"));
        match msg {
            FtMsg::Buy { trend, min_out, receiver } => {
                require!(token == self.usdc, "buy with USDC");
                require!(self.get(&trend).stage == Stage::Open, "curve closed");
                let receiver = receiver.unwrap_or_else(|| sender_id.clone());
                PromiseOrValue::Promise(
                    self.read_index(&trend).then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(GAS_CALLBACK.saturating_mul(2))
                            .with_unused_gas_weight(1)
                            .on_buy(sender_id, receiver, trend, amount, min_out),
                    ),
                )
            }
            FtMsg::Sell { min_out, receiver } => {
                let trend =
                    self.by_coin.get(&token).cloned().unwrap_or_else(|| env::panic_str("not a trend coin"));
                let receiver = receiver.unwrap_or_else(|| sender_id.clone());
                self.sell(&trend, &sender_id, amount.0, min_out.0, &receiver);
                PromiseOrValue::Value(U128(0))
            }
        }
    }
}

#[near]
impl Coins {
    /// Prices and settles a buy once the registry answered; refuses (returning the USDC) when
    /// the trend is not active or the curve has closed meanwhile.
    #[private]
    pub fn on_buy(
        &mut self,
        buyer: AccountId,
        receiver: AccountId,
        trend: String,
        amount: U128,
        min_out: U128,
        #[callback_result] snapshot: Result<Option<IndexSnapshot>, PromiseError>,
    ) -> U128 {
        let refuse = |reason: &str| {
            Event::TradeRefused { trend: &trend, trader: &buyer, reason, amount }.emit();
            amount
        };
        let t = match snapshot {
            Ok(Some(t)) if t.status == Status::Active => t,
            Ok(Some(_)) => return refuse("trend not active"),
            _ => return refuse("registry unavailable"),
        };
        let mut c = self.get(&trend);
        if c.stage != Stage::Open {
            return refuse("curve closed");
        }
        self.raise_floor(&mut c, t.peak_index);
        let trade = c.math.buy(amount.0, min_out.0).unwrap_or_else(|e| Self::curve_error(e));
        self.book(&c, &trade, t.surfacer.clone());
        self.mint_to(&c, &receiver, trade.out);
        Event::Trade {
            trend: &trend,
            trader: &buyer,
            is_buy: true,
            usdc: amount,
            coins: U128(trade.out),
            fee: U128(trade.fee),
            reserve: U128(c.math.reserve),
            sold: U128(c.math.sold),
            spot: U128(c.math.spot_wad()),
        }
        .emit();
        if c.math.reserve >= self.graduation_reserve {
            c.stage = Stage::Ready;
            Event::GraduationReady { trend: &trend, reserve: U128(c.math.reserve) }.emit();
        }
        self.curves.insert(trend, c);
        U128(0)
    }

    #[private]
    pub fn after_mint(&mut self, trend: String, to: AccountId, coins: U128) {
        if !tredio_common::promise_succeeded() {
            *self.owed_coins.entry(format!("{trend}|{to}")).or_insert(0) += coins.0;
            Event::DeliveryDeferred { trend: &trend, account: &to, coins, usdc: U128(0) }.emit();
        }
    }

    #[private]
    pub fn after_pay(&mut self, trend: String, to: AccountId, amount: U128) {
        if !tredio_common::promise_succeeded() {
            *self.owed_usdc.entry(to.clone()).or_insert(0) += amount.0;
            Event::DeliveryDeferred { trend: &trend, account: &to, coins: U128(0), usdc: amount }.emit();
        }
    }

    #[private]
    pub fn after_curation(&mut self, amount: U128) {
        let used = env::promise_result_checked(0, 64)
            .ok()
            .and_then(|b| serde_json::from_slice::<U128>(&b).ok())
            .map_or(0, |u| u.0.min(amount.0));
        self.protocol_fees += amount.0 - used;
    }

    /// Retries delivery of anything a mint or payment failed to deliver to the caller.
    pub fn claim_owed(&mut self, trend: String) {
        let who = env::predecessor_account_id();
        let key = format!("{trend}|{who}");
        let coins = self.owed_coins.remove(&key).unwrap_or(0);
        let usdc = self.owed_usdc.remove(&who).unwrap_or(0);
        require!(coins > 0 || usdc > 0, "nothing owed");
        let c = self.get(&trend);
        if coins > 0 {
            self.mint_to(&c, &who, coins);
        }
        if usdc > 0 {
            self.pay_usdc(&trend, &who, usdc);
        }
    }

    /// Sends accrued protocol fees to the treasury. Permissionless.
    pub fn sweep_protocol_fees(&mut self) {
        let amount = std::mem::take(&mut self.protocol_fees);
        require!(amount > 0, "nothing to sweep");
        let treasury = self.treasury.clone();
        self.pay_usdc("protocol", &treasury, amount);
    }
}
