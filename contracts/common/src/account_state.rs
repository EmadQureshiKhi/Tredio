//! The user account contract's state, shared with the accounts factory: the factory writes it as
//! the initial storage of a universal account (`STATE`), and the account contract reads it as
//! its single field, so both always agree byte for byte.

use near_sdk::json_types::U128;
use near_sdk::store::IterableMap;
use near_sdk::{near, AccountId, BorshStorageKey, PublicKey};

/// Storage key prefix of the session map inside a user account.
#[derive(BorshStorageKey)]
#[near]
pub enum AccountKey {
    Sessions,
}

/// The contracts a user account trades with, fixed when it is created (an owner upgrade can
/// replace them).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Protocol {
    pub usdc: AccountId,
    pub registry: AccountId,
    pub outcomes: AccountId,
    pub book: AccountId,
    pub perps: AccountId,
    pub coins: AccountId,
    pub curation: AccountId,
    /// Chain Signatures MPC contract (`v1.signer-prod.testnet`, `v1.signer`).
    pub signer: AccountId,
    pub factory: AccountId,
}

/// What a session may do.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Scope {
    /// Anchored Up/Down swaps, complete sets, redemptions, book withdrawals.
    pub outcomes: bool,
    /// Attention perps (open within the margin limit, close).
    pub perps: bool,
    /// Hyperliquid orders through the guard.
    pub hyperliquid: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Session {
    pub label: String,
    pub scope: Scope,
    pub created_at: u64,
    pub expires_at: u64,
    /// Gross USDC (6 decimals) the session may send out per UTC day; inflows never offset it.
    pub daily_limit: U128,
    pub spent: U128,
    /// UTC day (`unix / 86400`) `spent` belongs to.
    pub day: u64,
    /// True for a gas key funded from the account; false for a plain function-call key used
    /// through the relayer.
    pub gas_key: bool,
}

#[near(serializers = [borsh])]
pub struct AccountCore {
    /// The passkey's P-256 public key, 33-byte compressed SEC1.
    pub owner_key: Vec<u8>,
    /// `testnet` or `mainnet`: part of every signed request, so a signature never replays on the
    /// other network.
    pub network: String,
    pub protocol: Protocol,
    /// Sessions are refused while frozen; the passkey still works.
    pub frozen: bool,
    pub bootstrapped: bool,
    /// Owner request nonces seen recently, with their creation time.
    pub recent_nonces: Vec<(u64, u64)>,
    pub sessions: IterableMap<PublicKey, Session>,
}

impl AccountCore {
    pub fn new(owner_key: Vec<u8>, network: String, protocol: Protocol) -> Self {
        Self {
            owner_key,
            network,
            protocol,
            frozen: false,
            bootstrapped: false,
            recent_nonces: Vec::new(),
            sessions: IterableMap::new(AccountKey::Sessions),
        }
    }
}
