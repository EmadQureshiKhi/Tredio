//! Shared building blocks for the Tredio contracts: units, fixed-point math with explicit
//! rounding, the attention pricing model, trend identifiers and common types.

pub mod account_state;
pub mod math;
pub mod pricing;
pub mod storage;

use near_sdk::near;

/// USDC and outcome tokens carry 6 decimals.
pub const USDC_DECIMALS: u8 = 6;
pub const ONE_USDC: u128 = 1_000_000;
/// Index values carry 6 decimals: 1_000_000 is one index point.
pub const INDEX_SCALE: u64 = 1_000_000;
/// Smallest accepted index (0.01 points); keeps perp sizes and ratios well defined.
pub const MIN_INDEX: u64 = 10_000;
/// Largest accepted index (1,000 points).
pub const MAX_INDEX: u64 = 1_000 * INDEX_SCALE;
/// Trend coins carry 18 decimals.
pub const COIN_DECIMALS: u8 = 18;
pub const BPS: u128 = 10_000;
pub const MAX_IDENTIFIER_LENGTH: usize = 64;
/// Nanoseconds in a second, for converting `env::block_timestamp()`.
pub const NANOS: u64 = 1_000_000_000;

/// Block time in whole seconds.
pub fn now_secs() -> u64 {
    near_sdk::env::block_timestamp() / NANOS
}

/// True when the single promise this callback waits on succeeded.
pub fn promise_succeeded() -> bool {
    near_sdk::env::promise_results_count() == 1 && near_sdk::env::promise_result_checked(0, 16_384).is_ok()
}

/// True when `identifier` uses only lowercase letters, digits and `:._-`, 1 to 64 bytes.
/// Identifiers name trends (`crypto:btc`, `topic:openai`), with `.2` and so on for relistings.
pub fn is_normalized(identifier: &str) -> bool {
    !identifier.is_empty()
        && identifier.len() <= MAX_IDENTIFIER_LENGTH
        && identifier.bytes().all(|c| matches!(c, b'a'..=b'z' | b'0'..=b'9' | b':' | b'.' | b'_' | b'-'))
}

/// What a trend is about. Crypto trends list only with smart-money confirmation.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssetClass {
    Crypto,
    Equity,
    Commodity,
    Fx,
    Person,
    Politics,
    Topic,
}

/// A trend's lifecycle. Cooling takes no new risk; Retired is final and settles perps at the
/// last index.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Active,
    Cooling,
    Retired,
}

/// Up or Down side of an outcome series.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Up,
    Down,
}

impl Side {
    pub fn as_str(&self) -> &'static str {
        match self {
            Side::Up => "up",
            Side::Down => "down",
        }
    }
}

/// Latest index snapshot other contracts read from the registry.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexSnapshot {
    pub id: String,
    pub status: Status,
    /// Index with 6 decimals (at most 1e9, safe as a JSON number).
    pub index: u64,
    pub peak_index: u64,
    /// Observation time of `index`, unix seconds.
    pub updated_at: u64,
    /// True while the latest observation is younger than the registry's staleness limit.
    pub fresh: bool,
    /// Unix seconds the trend retired at, if it did.
    pub retired_at: Option<u64>,
    pub surfacer: Option<near_sdk::AccountId>,
}

/// Settlement value of a trend for an expiry, as the registry finalizes it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settlement {
    pub finalized: bool,
    pub value: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers() {
        for ok in ["crypto:btc", "topic:openai.2", "person:a_b-c", &"x".repeat(64)] {
            assert!(is_normalized(ok), "{ok}");
        }
        for bad in ["", "Crypto:BTC", "a b", "topic/x", &"x".repeat(65), "emoji:é"] {
            assert!(!is_normalized(bad), "{bad}");
        }
    }
}
