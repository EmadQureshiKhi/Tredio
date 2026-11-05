//! Bonding curve math, pure and integer-only.
//!
//! Quote side = virtual_quote + reserve (USDC), token side = VIRTUAL_TOKENS - sold, k = quote x
//! tokens, spot price = quote / tokens. Rounding always favours the curve.
//!
//! Attention ratchet: the floor (price at zero supply, virtual_quote / VIRTUAL_TOKENS) rises one
//! way as the trend's peak attention grows past its peak at creation, by 5% per index point, up
//! to 5x. Raising virtual_quote by d raises every price on the curve, so it is paid for: d x sold
//! / tokens moves from the floor reserve into the reserve, which keeps the curve able to buy
//! back every coin it sold. Solvency invariant: reserve x (VIRTUAL_TOKENS - sold) >=
//! virtual_quote x sold.

use near_sdk::near;
use tredio_common::math::{mul_div_ceil, mul_div_floor};
use tredio_common::{BPS, INDEX_SCALE};

/// One billion coins (18 decimals) on the virtual token side.
pub const VIRTUAL_TOKENS: u128 = 1_000_000_000 * 1_000_000_000_000_000_000;
pub const FEE_BPS: u128 = 100;
pub const FLOOR_SHARE_BPS: u128 = 3_000;
pub const GRADUATION_SHARE_BPS: u128 = 3_000;
pub const CURATION_SHARE_BPS: u128 = 1_000;
/// Largest move of the spot price one trade may cause (20%).
pub const MAX_PRICE_IMPACT_BPS: u128 = 2_000;
/// Floor ratchet per index point of peak growth since creation (5%).
pub const RATCHET_BPS_PER_POINT: u128 = 500;
/// Highest floor relative to the base (5x).
pub const MAX_RATCHET_BPS: u128 = 50_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct CurveMath {
    #[serde(with = "u128s")]
    pub virtual_quote: u128,
    #[serde(with = "u128s")]
    pub reserve: u128,
    #[serde(with = "u128s")]
    pub sold: u128,
    #[serde(with = "u128s")]
    pub floor_reserve: u128,
    #[serde(with = "u128s")]
    pub graduation_liquidity: u128,
}

pub(crate) mod u128s {
    use near_sdk::serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &u128, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u128, D::Error> {
        String::deserialize(d)?.parse().map_err(near_sdk::serde::de::Error::custom)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum CurveError {
    ZeroAmount,
    Slippage,
    PriceImpact,
    InsufficientReserve,
}

/// A trade's result: coins or USDC out, the fee and the curation share of it.
#[derive(Debug, PartialEq, Eq, Default, Clone, Copy)]
pub struct Trade {
    pub out: u128,
    pub fee: u128,
    pub to_curation: u128,
    pub to_protocol: u128,
}

pub fn ratchet_bps(peak: u64, peak_at_creation: u64) -> u128 {
    if peak <= peak_at_creation {
        return BPS;
    }
    let boost = mul_div_floor((peak - peak_at_creation) as u128, RATCHET_BPS_PER_POINT, INDEX_SCALE as u128);
    (BPS + boost).min(MAX_RATCHET_BPS)
}

impl CurveMath {
    pub fn new(base_virtual_quote: u128) -> Self {
        Self { virtual_quote: base_virtual_quote, ..Default::default() }
    }

    fn quote(&self) -> u128 {
        self.virtual_quote + self.reserve
    }

    fn tokens(&self) -> u128 {
        VIRTUAL_TOKENS - self.sold
    }

    /// Spot price in USDC (6 decimals) per whole coin, WAD-scaled.
    pub fn spot_wad(&self) -> u128 {
        mul_div_floor(self.quote(), 1_000_000_000_000_000_000 * 1_000_000_000_000_000_000, self.tokens())
    }

    /// Books a fee: floor and graduation shares stay in the curve, curation and protocol shares
    /// are returned for sending.
    fn book_fee(&mut self, fee: u128) -> (u128, u128) {
        let to_floor = fee * FLOOR_SHARE_BPS / BPS;
        let to_graduation = fee * GRADUATION_SHARE_BPS / BPS;
        let to_curation = fee * CURATION_SHARE_BPS / BPS;
        self.floor_reserve += to_floor;
        self.graduation_liquidity += to_graduation;
        (to_curation, fee - to_floor - to_graduation - to_curation)
    }

    fn check_impact(q0: u128, t0: u128, q1: u128, t1: u128) -> Result<(), CurveError> {
        // The new price in units of the old token side: (q1 / t1) x t0, against q0.
        let after = mul_div_floor(q1, t0, t1);
        if after.abs_diff(q0) > q0 * MAX_PRICE_IMPACT_BPS / BPS {
            return Err(CurveError::PriceImpact);
        }
        Ok(())
    }

    /// Buys coins for `quote_in` USDC, fee included.
    pub fn buy(&mut self, quote_in: u128, min_out: u128) -> Result<Trade, CurveError> {
        if quote_in == 0 {
            return Err(CurveError::ZeroAmount);
        }
        let fee = mul_div_ceil(quote_in, FEE_BPS, BPS);
        let net = quote_in - fee;
        let (q0, t0) = (self.quote(), self.tokens());
        let q1 = q0 + net;
        let t1 = mul_div_ceil(q0, t0, q1);
        let out = t0 - t1;
        if out == 0 {
            return Err(CurveError::ZeroAmount);
        }
        if out < min_out {
            return Err(CurveError::Slippage);
        }
        Self::check_impact(q0, t0, q1, t1)?;
        self.reserve += net;
        self.sold += out;
        let (to_curation, to_protocol) = self.book_fee(fee);
        Ok(Trade { out, fee, to_curation, to_protocol })
    }

    /// Sells `coins_in` for USDC, fee deducted.
    pub fn sell(&mut self, coins_in: u128, min_out: u128) -> Result<Trade, CurveError> {
        if coins_in == 0 {
            return Err(CurveError::ZeroAmount);
        }
        let (q0, t0) = (self.quote(), self.tokens());
        let t1 = t0 + coins_in;
        let q1 = mul_div_ceil(q0, t0, t1);
        let gross = q0 - q1;
        if gross > self.reserve {
            return Err(CurveError::InsufficientReserve);
        }
        Self::check_impact(q0, t0, q1, t1)?;
        let fee = mul_div_ceil(gross, FEE_BPS, BPS);
        let out = gross - fee;
        if out == 0 {
            return Err(CurveError::ZeroAmount);
        }
        if out < min_out {
            return Err(CurveError::Slippage);
        }
        self.reserve -= gross;
        self.sold -= coins_in;
        let (to_curation, to_protocol) = self.book_fee(fee);
        Ok(Trade { out, fee, to_curation, to_protocol })
    }

    /// Raises the floor toward `ratchet` x base as far as the floor reserve pays for. Returns the
    /// cost moved into the reserve, if any.
    pub fn raise_floor(&mut self, base_virtual_quote: u128, ratchet: u128) -> Option<u128> {
        let target = mul_div_floor(base_virtual_quote, ratchet, BPS);
        if target <= self.virtual_quote {
            return None;
        }
        let mut delta = target - self.virtual_quote;
        let tokens = self.tokens();
        let mut cost = mul_div_ceil(delta, self.sold, tokens);
        if cost > self.floor_reserve {
            delta = mul_div_floor(self.floor_reserve, tokens, self.sold.max(1));
            if delta == 0 {
                return None;
            }
            cost = mul_div_ceil(delta, self.sold, tokens);
            if cost > self.floor_reserve {
                return None;
            }
        }
        self.virtual_quote += delta;
        self.floor_reserve -= cost;
        self.reserve += cost;
        Some(cost)
    }

    /// Coins priced at the final spot that pair with the graduation USDC (reserve, floor reserve
    /// and graduation liquidity).
    pub fn graduation_amounts(&self) -> (u128, u128) {
        let quote = self.reserve + self.floor_reserve + self.graduation_liquidity;
        (mul_div_floor(quote, self.tokens(), self.quote()), quote)
    }

    /// reserve x tokens >= virtual_quote x sold: selling every coin back never pays out more
    /// than the reserve.
    pub fn is_solvent(&self) -> bool {
        self.sold == 0 || mul_div_floor(self.reserve, self.tokens(), self.virtual_quote) >= self.sold
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const USDC: u128 = 1_000_000;

    #[test]
    fn buys_then_sells_back_less_the_fees() {
        let mut c = CurveMath::new(1_000 * USDC);
        let b = c.buy(10 * USDC, 0).unwrap();
        assert_eq!(b.fee, USDC / 10);
        let s = c.sell(b.out, 0).unwrap();
        assert!(s.out < 10 * USDC && s.out > 9_700_000, "{}", s.out);
        assert_eq!(c.sold, 0);
        assert!(c.is_solvent());
    }

    #[test]
    fn guards() {
        let mut c = CurveMath::new(1_000 * USDC);
        assert_eq!(c.buy(0, 0), Err(CurveError::ZeroAmount));
        assert_eq!(c.buy(10 * USDC, u128::MAX), Err(CurveError::Slippage));
        assert_eq!(c.buy(500 * USDC, 0), Err(CurveError::PriceImpact));
        assert_eq!(c.sell(1, 0), Err(CurveError::ZeroAmount));
        assert_eq!(c.sell(1_000_000_000_000_000_000_000_000, 0), Err(CurveError::InsufficientReserve));
    }

    #[test]
    fn ratchet_raises_the_floor_and_stays_solvent() {
        assert_eq!(ratchet_bps(40_000_000, 40_000_000), BPS);
        assert_eq!(ratchet_bps(42_000_000, 40_000_000), BPS + 1_000);
        assert_eq!(ratchet_bps(400_000_000, 40_000_000), MAX_RATCHET_BPS);
        let mut c = CurveMath::new(1_000 * USDC);
        for _ in 0..40 {
            c.buy(50 * USDC, 0).unwrap();
        }
        let floor_before = c.virtual_quote;
        let cost = c.raise_floor(1_000 * USDC, ratchet_bps(45_000_000, 40_000_000));
        assert!(cost.is_some());
        assert!(c.virtual_quote > floor_before);
        assert!(c.is_solvent());
        // Everyone can still sell back.
        let sold = c.sold;
        let mut left = sold;
        while left > 0 {
            let chunk = left.min(sold / 20 + 1);
            c.sell(chunk, 0).unwrap();
            left -= chunk;
        }
        assert_eq!(c.sold, 0);
    }

    #[test]
    fn graduation_pairs_at_the_spot_price() {
        let mut c = CurveMath::new(1_000 * USDC);
        for _ in 0..30 {
            c.buy(50 * USDC, 0).unwrap();
        }
        let (coins, quote) = c.graduation_amounts();
        let pool_price = quote as f64 / coins as f64;
        let spot = c.quote() as f64 / c.tokens() as f64;
        assert!((pool_price / spot - 1.0).abs() < 1e-9);
    }
}
