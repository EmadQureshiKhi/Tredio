//! # Tredio registry
//!
//! The single source of trends, attention index values, outcome settlement values and the
//! Hyperliquid marks the account guard reads. The only writer is the oracle: a report is
//! accepted only when it carries the TEE oracle's proof (see [`OracleConfig`]).
//!
//! A report holds new trends, index values for existing trends (all observed at one time) and
//! asset marks. Guards: strictly increasing run ids (replay protection), report age and
//! future-skew limits, strictly increasing per-trend observation times, index bounds, a maximum
//! move per update (larger moves are clamped and flagged), and a staleness limit consumers check
//! before taking new risk. Items that fail validation are skipped with an event, so one bad item
//! never blocks the rest of a report.
//!
//! Lifecycle: a trend whose index stays below the attention floor for `cooling_window` goes
//! Cooling (no new risk). A Cooling trend that recovers goes back to Active; one that stays
//! Cooling for `retire_window` is Retired, which is final. A trend whose index is not updated for
//! `stale_retire_window` can be retired by anyone. Perps settle at the last index of a retired
//! trend.
//!
//! Settlement: consumers (the outcomes contract) register a series expiry; the first observation
//! at or after it, if it lands within `settlement_tolerance`, is the settlement value. A trend
//! retired at or before an expiry settles at its final index, since no later observation can
//! arrive.

mod oracle;

use near_sdk::json_types::U128;
use near_sdk::store::{IterableSet, LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};
use tredio_common::pricing::fair_up_usdc;
use tredio_common::{
    is_normalized, now_secs, AssetClass, IndexSnapshot, Settlement, Status, BPS, MAX_INDEX, MIN_INDEX,
};

pub use oracle::OracleConfig;

/// Recent checkpoints kept on chain per trend (the indexer keeps the full history).
pub const HISTORY_LEN: usize = 96;
/// Expiries a trend can wait on at once (open series of every window).
pub const MAX_PENDING_EXPIRIES: usize = 64;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Params {
    /// Seconds after an observation before consumers treat the index as stale.
    pub staleness_limit: u64,
    /// Largest move per update in basis points of the previous index; larger moves are clamped.
    pub max_move_bps: u32,
    /// Index below which a trend starts cooling (6 decimals).
    pub attention_floor: u64,
    pub cooling_window: u64,
    pub retire_window: u64,
    pub stale_retire_window: u64,
    pub settlement_tolerance: u64,
    pub max_report_age: u64,
    pub max_future_skew: u64,
}

impl Params {
    fn assert_valid(&self) {
        let ok = (30..=86_400).contains(&self.staleness_limit)
            && (100..=9_000).contains(&self.max_move_bps)
            && (MIN_INDEX..=MAX_INDEX / 10).contains(&self.attention_floor)
            && (60..=30 * 86_400).contains(&self.cooling_window)
            && (60..=30 * 86_400).contains(&self.retire_window)
            && self.stale_retire_window >= self.staleness_limit
            && self.stale_retire_window <= 30 * 86_400
            && (30..=86_400).contains(&self.settlement_tolerance)
            && (30..=3_600).contains(&self.max_report_age)
            && self.max_future_skew <= 300;
        require!(ok, "invalid params");
    }
}

/// A trend as the registry stores it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Trend {
    pub asset_class: AssetClass,
    pub status: Status,
    pub created_at: u64,
    pub updated_at: u64,
    pub index: u64,
    pub peak_index: u64,
    /// When the index last went below the attention floor; 0 while above it.
    pub below_floor_since: u64,
    pub status_since: u64,
    /// The account that first surfaced the trend (earns the curation share).
    pub surfacer: Option<AccountId>,
    /// SHA-256 (hex) of the NEAR AI Cloud review bundle that approved the trend: the signed
    /// response and its attestation, which the backend serves at /v1/reviews/<hash>.
    pub review_hash: Option<String>,
    /// Ticker of the underlying asset on Hyperliquid, for trends about a listed asset.
    pub asset: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Checkpoint {
    pub at: u64,
    pub index: u64,
}

/// A Hyperliquid mark price (8 decimals) and when the oracle observed it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mark {
    pub price: U128,
    pub at: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct NewTrend {
    pub identifier: String,
    pub asset_class: AssetClass,
    pub index: u64,
    pub surfacer: Option<AccountId>,
    pub smart_money_confirmed: bool,
    pub review_hash: Option<String>,
    pub asset: Option<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct IndexUpdate {
    pub id: String,
    pub index: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct MarkUpdate {
    pub asset: String,
    pub price: U128,
}

/// One oracle run.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Report {
    pub run_id: u64,
    /// Unix seconds every index value and mark in the report was observed at.
    pub observed_at: u64,
    #[serde(default)]
    pub new_trends: Vec<NewTrend>,
    #[serde(default)]
    pub updates: Vec<IndexUpdate>,
    #[serde(default)]
    pub marks: Vec<MarkUpdate>,
}

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Rejection {
    BadIdentifier,
    IndexOutOfBounds,
    Duplicate,
    NoSmartMoneyConfirmation,
    UnknownTrend,
    Retired,
    NotNewer,
    BadReviewHash,
    BadMark,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct TrendView {
    pub id: String,
    #[serde(flatten)]
    pub trend: Trend,
    pub fresh: bool,
}

/// NEP-297 events (`standard: "tredio-registry"`), the indexer's input.
#[near(event_json(standard = "tredio-registry"))]
pub enum Event<'a> {
    #[event_version("1.0.0")]
    ReportProcessed { run_id: u64, observed_at: u64, created: u32, updated: u32, marks: u32, rejected: u32 },
    #[event_version("1.0.0")]
    TrendCreated {
        id: &'a str,
        asset_class: AssetClass,
        surfacer: &'a Option<AccountId>,
        index: u64,
        observed_at: u64,
        review_hash: &'a Option<String>,
        asset: &'a Option<String>,
    },
    #[event_version("1.0.0")]
    IndexUpdated { id: &'a str, index: u64, peak_index: u64, observed_at: u64, clamped: bool },
    #[event_version("1.0.0")]
    IndexClamped { id: &'a str, proposed: u64, applied: u64 },
    #[event_version("1.0.0")]
    StatusChanged { id: &'a str, from: Option<Status>, to: Status, at: u64 },
    #[event_version("1.0.0")]
    SettlementFinalized { id: &'a str, expiry: u64, value: u64 },
    #[event_version("1.0.0")]
    SettlementMissed { id: &'a str, expiry: u64, first_observation: u64 },
    #[event_version("1.0.0")]
    ItemRejected { id: &'a str, kind: &'a str, reason: Rejection },
    #[event_version("1.0.0")]
    MarkUpdated { asset: &'a str, price: U128, at: u64 },
    #[event_version("1.0.0")]
    OracleChanged { config: &'a OracleConfig },
}

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Trends,
    Ids,
    History,
    Settlements,
    Pending,
    Consumers,
    Marks,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    /// May rotate the oracle configuration and the consumer list; holds no other power.
    owner: AccountId,
    oracle: OracleConfig,
    params: Params,
    last_run_id: u64,
    trends: LookupMap<String, Trend>,
    ids: Vector<String>,
    history: LookupMap<String, Vec<Checkpoint>>,
    settlements: LookupMap<String, u64>,
    pending: LookupMap<String, Vec<u64>>,
    /// Contracts allowed to register series expiries (the outcomes contract).
    consumers: IterableSet<AccountId>,
    marks: LookupMap<String, Mark>,
}

fn settlement_key(id: &str, expiry: u64) -> String {
    format!("{id}@{expiry}")
}

#[near]
impl Registry {
    #[init]
    pub fn new(owner: AccountId, oracle: OracleConfig, params: Params) -> Self {
        params.assert_valid();
        oracle.assert_valid();
        Self {
            owner,
            oracle,
            params,
            last_run_id: 0,
            trends: LookupMap::new(Key::Trends),
            ids: Vector::new(Key::Ids),
            history: LookupMap::new(Key::History),
            settlements: LookupMap::new(Key::Settlements),
            pending: LookupMap::new(Key::Pending),
            consumers: IterableSet::new(Key::Consumers),
            marks: LookupMap::new(Key::Marks),
        }
    }

    // ---------------------------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------------------------

    pub fn set_oracle(&mut self, oracle: OracleConfig) {
        self.assert_owner();
        oracle.assert_valid();
        Event::OracleChanged { config: &oracle }.emit();
        self.oracle = oracle;
    }

    pub fn add_consumer(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.consumers.insert(account_id);
    }

    pub fn remove_consumer(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.consumers.remove(&account_id);
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    // ---------------------------------------------------------------------------------------
    // Consumers
    // ---------------------------------------------------------------------------------------

    /// Records `expiry` as a settlement time for trend `id`. Called by the outcomes contract when
    /// it opens a series; returns the trend's snapshot so the caller can take the opening index.
    pub fn register_expiry(&mut self, id: String, expiry: u64) -> IndexSnapshot {
        require!(self.consumers.contains(&env::predecessor_account_id()), "consumer only");
        let snapshot = self.snapshot(&id).unwrap_or_else(|| env::panic_str("unknown trend"));
        require!(snapshot.status == Status::Active, "trend not active");
        require!(snapshot.fresh, "index stale");
        require!(expiry > now_secs(), "expiry in the past");
        let mut pending = self.pending.get(&id).cloned().unwrap_or_default();
        if !pending.contains(&expiry) {
            require!(pending.len() < MAX_PENDING_EXPIRIES, "too many open expiries");
            pending.push(expiry);
            pending.sort_unstable();
            self.pending.insert(id, pending);
        }
        snapshot
    }

    // ---------------------------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------------------------

    /// Applies time-based lifecycle transitions without a new observation. Permissionless; the
    /// keeper calls it so a trend the oracle stopped updating can be retired.
    pub fn poke_lifecycle(&mut self, id: String) {
        let mut t = self.trends.get(&id).cloned().unwrap_or_else(|| env::panic_str("unknown trend"));
        require!(t.status != Status::Retired, "nothing to poke");
        let now = now_secs();
        let since = |ts: u64| now.saturating_sub(ts);
        if since(t.updated_at) >= self.params.stale_retire_window
            || (t.status == Status::Cooling && since(t.status_since) >= self.params.retire_window)
        {
            set_status(&id, &mut t, Status::Retired, now);
            self.trends.insert(id, t);
        } else {
            env::panic_str("nothing to poke");
        }
    }

    // ---------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------

    pub fn get_params(&self) -> Params {
        self.params.clone()
    }

    pub fn get_oracle(&self) -> OracleConfig {
        self.oracle.clone()
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn last_run_id(&self) -> u64 {
        self.last_run_id
    }

    pub fn trend_count(&self) -> u32 {
        self.ids.len()
    }

    pub fn get_trend(&self, id: String) -> Option<TrendView> {
        self.trends.get(&id).map(|t| TrendView { id: id.clone(), fresh: self.is_fresh(t), trend: t.clone() })
    }

    /// Up to `limit` trends in creation order starting at `from_index`.
    pub fn get_trends(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<TrendView> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(200);
        (from..self.ids.len().min(from.saturating_add(limit)))
            .filter_map(|i| self.ids.get(i).and_then(|id| self.get_trend(id.clone())))
            .collect()
    }

    /// The latest index and lifecycle state other contracts act on.
    pub fn index_of(&self, id: String) -> Option<IndexSnapshot> {
        self.snapshot(&id)
    }

    /// Recent observations, oldest first (at most [`HISTORY_LEN`]).
    pub fn history(&self, id: String) -> Vec<Checkpoint> {
        self.history.get(&id).cloned().unwrap_or_default()
    }

    /// Settlement value for a series of `id` expiring at `expiry`.
    pub fn settlement_of(&self, id: String, expiry: u64) -> Settlement {
        if let Some(value) = self.settlements.get(&settlement_key(&id, expiry)) {
            return Settlement { finalized: true, value: *value };
        }
        match self.trends.get(&id) {
            Some(t) if t.status == Status::Retired && t.status_since <= expiry => {
                Settlement { finalized: true, value: t.index }
            }
            _ => Settlement { finalized: false, value: 0 },
        }
    }

    /// Expiries of `id` still waiting on their settlement observation.
    pub fn pending_expiries(&self, id: String) -> Vec<u64> {
        self.pending.get(&id).cloned().unwrap_or_default()
    }

    /// The attention-implied value of one UP token (USDC, 6 decimals) for a series of `id` that
    /// opened at `opening` and expires at `expiry`.
    pub fn fair_up(&self, id: String, opening: u64, expiry: u64) -> U128 {
        let t = self.trends.get(&id).unwrap_or_else(|| env::panic_str("unknown trend"));
        U128(fair_up_usdc(t.index, opening, expiry.saturating_sub(now_secs())))
    }

    pub fn mark_of(&self, asset: String) -> Option<Mark> {
        self.marks.get(&asset).cloned()
    }

    pub fn is_consumer(&self, account_id: AccountId) -> bool {
        self.consumers.contains(&account_id)
    }
}

// -------------------------------------------------------------------------------------------
// Report processing (called by the oracle module once a report is proven)
// -------------------------------------------------------------------------------------------

impl Registry {
    pub(crate) fn apply_report(&mut self, r: Report) {
        require!(r.run_id > self.last_run_id, "stale run");
        let now = now_secs();
        require!(
            r.observed_at + self.params.max_report_age >= now
                && r.observed_at <= now + self.params.max_future_skew,
            "bad observation time"
        );
        self.last_run_id = r.run_id;
        let (mut created, mut updated, mut marks, mut rejected) = (0u32, 0u32, 0u32, 0u32);
        for n in r.new_trends {
            if self.create_trend(n, r.observed_at) {
                created += 1;
            } else {
                rejected += 1;
            }
        }
        for u in r.updates {
            if self.update_index(u, r.observed_at) {
                updated += 1;
            } else {
                rejected += 1;
            }
        }
        for m in r.marks {
            if m.asset.is_empty() || m.asset.len() > 16 || m.price.0 == 0 {
                Event::ItemRejected { id: &m.asset, kind: "mark", reason: Rejection::BadMark }.emit();
                rejected += 1;
                continue;
            }
            Event::MarkUpdated { asset: &m.asset, price: m.price, at: r.observed_at }.emit();
            self.marks.insert(m.asset, Mark { price: m.price, at: r.observed_at });
            marks += 1;
        }
        Event::ReportProcessed {
            run_id: r.run_id,
            observed_at: r.observed_at,
            created,
            updated,
            marks,
            rejected,
        }
        .emit();
    }

    fn create_trend(&mut self, n: NewTrend, observed_at: u64) -> bool {
        let reason = if !is_normalized(&n.identifier) {
            Some(Rejection::BadIdentifier)
        } else if !(MIN_INDEX..=MAX_INDEX).contains(&n.index) {
            Some(Rejection::IndexOutOfBounds)
        } else if self.trends.contains_key(&n.identifier) {
            Some(Rejection::Duplicate)
        } else if n.asset_class == AssetClass::Crypto && !n.smart_money_confirmed {
            Some(Rejection::NoSmartMoneyConfirmation)
        } else if n.review_hash.as_ref().is_some_and(|h| h.len() != 64 || hex::decode(h).is_err()) {
            Some(Rejection::BadReviewHash)
        } else {
            None
        };
        if let Some(reason) = reason {
            Event::ItemRejected { id: &n.identifier, kind: "new_trend", reason }.emit();
            return false;
        }
        let below = n.index < self.params.attention_floor;
        let t = Trend {
            asset_class: n.asset_class,
            status: Status::Active,
            created_at: observed_at,
            updated_at: observed_at,
            index: n.index,
            peak_index: n.index,
            below_floor_since: if below { observed_at } else { 0 },
            status_since: observed_at,
            surfacer: n.surfacer,
            review_hash: n.review_hash,
            asset: n.asset,
        };
        Event::TrendCreated {
            id: &n.identifier,
            asset_class: t.asset_class,
            surfacer: &t.surfacer,
            index: t.index,
            observed_at,
            review_hash: &t.review_hash,
            asset: &t.asset,
        }
        .emit();
        Event::StatusChanged { id: &n.identifier, from: None, to: Status::Active, at: observed_at }.emit();
        self.history.insert(n.identifier.clone(), vec![Checkpoint { at: observed_at, index: n.index }]);
        self.ids.push(n.identifier.clone());
        self.trends.insert(n.identifier, t);
        true
    }

    fn update_index(&mut self, u: IndexUpdate, observed_at: u64) -> bool {
        let Some(mut t) = self.trends.get(&u.id).cloned() else {
            Event::ItemRejected { id: &u.id, kind: "update", reason: Rejection::UnknownTrend }.emit();
            return false;
        };
        let reason = if t.status == Status::Retired {
            Some(Rejection::Retired)
        } else if observed_at <= t.updated_at {
            Some(Rejection::NotNewer)
        } else if !(MIN_INDEX..=MAX_INDEX).contains(&u.index) {
            Some(Rejection::IndexOutOfBounds)
        } else {
            None
        };
        if let Some(reason) = reason {
            Event::ItemRejected { id: &u.id, kind: "update", reason }.emit();
            return false;
        }
        let applied = clamp_move(t.index, u.index, self.params.max_move_bps);
        let clamped = applied != u.index;
        if clamped {
            Event::IndexClamped { id: &u.id, proposed: u.index, applied }.emit();
        }
        t.index = applied;
        t.updated_at = observed_at;
        t.peak_index = t.peak_index.max(applied);
        Event::IndexUpdated { id: &u.id, index: applied, peak_index: t.peak_index, observed_at, clamped }
            .emit();

        let mut history = self.history.get(&u.id).cloned().unwrap_or_default();
        history.push(Checkpoint { at: observed_at, index: applied });
        if history.len() > HISTORY_LEN {
            history.drain(..history.len() - HISTORY_LEN);
        }
        self.history.insert(u.id.clone(), history);

        self.capture_settlements(&u.id, observed_at, applied);
        self.evaluate_lifecycle(&u.id, &mut t, observed_at);
        self.trends.insert(u.id, t);
        true
    }

    /// The first observation at or after a pending expiry settles it, if it is within tolerance.
    fn capture_settlements(&mut self, id: &str, observed_at: u64, value: u64) {
        let Some(pending) = self.pending.get(id).cloned() else { return };
        let (due, rest): (Vec<u64>, Vec<u64>) = pending.into_iter().partition(|e| *e <= observed_at);
        if due.is_empty() {
            return;
        }
        for expiry in due {
            if observed_at <= expiry + self.params.settlement_tolerance {
                self.settlements.insert(settlement_key(id, expiry), value);
                Event::SettlementFinalized { id, expiry, value }.emit();
            } else {
                Event::SettlementMissed { id, expiry, first_observation: observed_at }.emit();
            }
        }
        if rest.is_empty() {
            self.pending.remove(id);
        } else {
            self.pending.insert(id.to_string(), rest);
        }
    }

    fn evaluate_lifecycle(&self, id: &str, t: &mut Trend, at: u64) {
        let below = t.index < self.params.attention_floor;
        if !below {
            t.below_floor_since = 0;
        } else if t.below_floor_since == 0 {
            t.below_floor_since = at;
        }
        match t.status {
            Status::Active if below && at - t.below_floor_since >= self.params.cooling_window => {
                set_status(id, t, Status::Cooling, at)
            }
            Status::Cooling if !below => set_status(id, t, Status::Active, at),
            Status::Cooling if at - t.status_since >= self.params.retire_window => {
                set_status(id, t, Status::Retired, at)
            }
            _ => {}
        }
    }

    fn is_fresh(&self, t: &Trend) -> bool {
        now_secs().saturating_sub(t.updated_at) <= self.params.staleness_limit
    }

    fn snapshot(&self, id: &str) -> Option<IndexSnapshot> {
        self.trends.get(id).map(|t| IndexSnapshot {
            id: id.to_string(),
            status: t.status,
            index: t.index,
            peak_index: t.peak_index,
            updated_at: t.updated_at,
            fresh: self.is_fresh(t),
            retired_at: (t.status == Status::Retired).then_some(t.status_since),
            surfacer: t.surfacer.clone(),
        })
    }
}

fn set_status(id: &str, t: &mut Trend, to: Status, at: u64) {
    Event::StatusChanged { id, from: Some(t.status), to, at }.emit();
    t.status = to;
    t.status_since = at;
}

/// Limits a move to `max_move_bps` of the previous value, never below [`MIN_INDEX`].
pub fn clamp_move(last: u64, proposed: u64, max_move_bps: u32) -> u64 {
    let max_delta = (last as u128 * max_move_bps as u128 / BPS) as u64;
    if proposed > last && proposed - last > max_delta {
        last + max_delta
    } else if proposed < last && last - proposed > max_delta {
        (last - max_delta).max(MIN_INDEX)
    } else {
        proposed
    }
}

#[cfg(test)]
mod tests;
