//! Which trends a run measures and what it reports: the same rules as `apps/oracle/src/plan.ts`.

use crate::method::{to_index_units, Measurement, MIN_CONFIRM_NETFLOW_USD};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const MAX_VERSION: u32 = 9;
const ASSET_CLASSES: [&str; 7] = ["crypto", "equity", "commodity", "fx", "person", "politics", "topic"];

#[derive(Deserialize, Clone, Debug)]
pub struct Trend {
    pub id: String,
    pub status: String,
    pub updated_at: u64,
    pub index: u64,
    pub asset: Option<String>,
}

#[derive(Clone, Debug)]
pub struct LiveTrend {
    pub trend: Trend,
    pub pending_due: usize,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub identifier: String,
    pub surfacer: Option<String>,
    pub ticker: Option<String>,
    pub review_hash: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub pick: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct NewTrend {
    pub identifier: String,
    pub asset_class: String,
    pub index: u64,
    pub surfacer: Option<String>,
    pub smart_money_confirmed: bool,
    pub review_hash: Option<String>,
    pub asset: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Update {
    pub id: String,
    pub index: u64,
}

pub fn base_of(identifier: &str) -> &str {
    let b = identifier.as_bytes();
    if b.len() > 2 && b[b.len() - 2] == b'.' && (b'2'..=b'9').contains(&b[b.len() - 1]) {
        &identifier[..identifier.len() - 2]
    } else {
        identifier
    }
}

pub fn versioned(base: &str, n: u32) -> String {
    if n == 1 { base.to_string() } else { format!("{base}.{n}") }
}

pub fn asset_class_of(identifier: &str) -> &'static str {
    match identifier.split_once(':') {
        Some((prefix, _)) => ASSET_CLASSES.iter().find(|c| **c == prefix).copied().unwrap_or("topic"),
        None => "topic",
    }
}

fn named_account(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() >= 2
        && s.len() >= 2
        && s.len() <= 64
        && parts.iter().all(|p| {
            !p.is_empty()
                && p.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_')
                && !p.starts_with(['-', '_'])
                && !p.ends_with(['-', '_'])
        })
}

/// A surfacer the curation contract can pay: a named account, a universal account or an implicit one.
pub fn payable_surfacer(s: Option<&str>) -> Option<String> {
    let s = s?;
    let universal = s.starts_with("0u") && (52..=64).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let implicit = s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c));
    (named_account(s) || universal || implicit).then(|| s.to_string())
}

pub fn free_listing(base: &str, status_of: impl Fn(&str) -> Option<String>) -> Option<String> {
    for n in 1..=MAX_VERSION {
        let id = versioned(base, n);
        match status_of(&id) {
            None => return Some(id),
            Some(s) if s != "retired" => return None,
            _ => {}
        }
    }
    None
}

pub fn allocate(live: &[LiveTrend], candidates: &[Candidate], slots: usize, max_candidates: usize, free_slots: usize) -> (Vec<LiveTrend>, Vec<Candidate>) {
    let by_age = |a: &&LiveTrend, b: &&LiveTrend| a.trend.updated_at.cmp(&b.trend.updated_at).then(a.trend.id.cmp(&b.trend.id));
    let mut pending: Vec<&LiveTrend> = live.iter().filter(|t| t.pending_due > 0).collect();
    pending.sort_by(by_age);
    let mut rest: Vec<&LiveTrend> = live.iter().filter(|t| t.pending_due == 0).collect();
    rest.sort_by(by_age);
    let mut trends: Vec<LiveTrend> = pending.into_iter().take(slots).cloned().collect();
    let picked: Vec<Candidate> = if free_slots > 0 { candidates.iter().take(max_candidates.min(free_slots).min(slots - trends.len())).cloned().collect() } else { vec![] };
    let take = slots - trends.len() - picked.len();
    trends.extend(rest.into_iter().take(take).cloned());
    (trends, picked)
}

pub struct DecideParams<'a> {
    pub now: u64,
    pub heartbeat_sec: u64,
    pub deviation_bps: u64,
    pub min_create_index_points: f64,
    pub hyperliquid_assets: &'a HashSet<String>,
}

pub fn decide(sampled: &[(LiveTrend, Measurement)], listings: &[(Candidate, String, Measurement)], p: &DecideParams) -> (Vec<NewTrend>, Vec<Update>) {
    let mut updates = Vec::new();
    let mut riders = Vec::new();
    for (t, m) in sampled {
        let Some(points) = m.points else { continue };
        let index = to_index_units(points);
        let age = p.now.saturating_sub(t.trend.updated_at);
        let moved_enough = if t.trend.index > 0 { index.abs_diff(t.trend.index) as u128 * 10_000 >= p.deviation_bps as u128 * t.trend.index as u128 } else { true };
        if age >= p.heartbeat_sec || moved_enough || t.pending_due > 0 {
            updates.push(Update { id: t.trend.id.clone(), index });
        } else if age * 2 >= p.heartbeat_sec {
            riders.push(Update { id: t.trend.id.clone(), index });
        }
    }
    let mut new_trends = Vec::new();
    for (c, identifier, m) in listings {
        let Some(points) = m.points else { continue };
        if points < p.min_create_index_points {
            continue;
        }
        let class = asset_class_of(identifier);
        let crypto = class == "crypto";
        let confirmed = c.pinned || m.netflow_usd.is_some_and(|f| f >= MIN_CONFIRM_NETFLOW_USD);
        if crypto && !confirmed {
            continue;
        }
        let ticker = c.ticker.as_ref().map(|t| t.to_uppercase());
        new_trends.push(NewTrend {
            identifier: identifier.clone(),
            asset_class: class.to_string(),
            index: to_index_units(points),
            surfacer: payable_surfacer(c.surfacer.as_deref()),
            smart_money_confirmed: crypto && confirmed,
            review_hash: c.review_hash.clone().filter(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))),
            asset: ticker.filter(|t| p.hyperliquid_assets.contains(t)),
        });
    }
    if !updates.is_empty() || !new_trends.is_empty() {
        updates.extend(riders);
    }
    (new_trends, updates)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_793_900_000;
    fn trend(id: &str, updated_ago: u64, index: u64, pending: usize) -> LiveTrend {
        LiveTrend { trend: Trend { id: id.into(), status: "active".into(), updated_at: NOW - updated_ago, index, asset: None }, pending_due: pending }
    }
    fn m(points: Option<f64>, flow: Option<f64>) -> Measurement {
        Measurement { points, netflow_usd: flow }
    }

    // The same cases as apps/oracle/test/oracle.test.ts.
    #[test]
    fn plans_like_the_typescript_oracle() {
        let live = vec![trend("a", 10, 50_000_000, 0), trend("b", 500, 50_000_000, 0), trend("c", 60, 50_000_000, 1)];
        let (t, c) = allocate(&live, &[Candidate { identifier: "topic:x".into(), ..Default::default() }, Candidate { identifier: "topic:y".into(), ..Default::default() }], 3, 1, 5);
        assert_eq!(t.iter().map(|x| x.trend.id.as_str()).collect::<Vec<_>>(), ["c", "b"]);
        assert_eq!(c.len(), 1);

        assert_eq!(free_listing("topic:a", |id| (id == "topic:a").then(|| "retired".to_string())), Some("topic:a.2".into()));
        assert_eq!(free_listing("topic:b", |id| (id == "topic:b").then(|| "active".to_string())), None);
        assert_eq!(base_of("topic:a.2"), "topic:a");

        let assets: HashSet<String> = ["BTC".to_string()].into();
        let p = DecideParams { now: NOW, heartbeat_sec: 420, deviation_bps: 100, min_create_index_points: 5.0, hyperliquid_assets: &assets };
        let (_, updates) = decide(
            &[(trend("quiet", 60, 50_000_000, 0), m(Some(50.2), None)), (trend("moved", 60, 50_000_000, 0), m(Some(60.0), None)), (trend("half", 300, 50_000_000, 0), m(Some(50.0), None)), (trend("due", 30, 50_000_000, 1), m(Some(50.0), None))],
            &[],
            &p,
        );
        assert_eq!(updates.iter().map(|u| u.id.as_str()).collect::<Vec<_>>(), ["moved", "due", "half"]);

        let btc = Candidate { identifier: "crypto:btc".into(), ticker: Some("btc".into()), review_hash: Some("a".repeat(64)), surfacer: Some("alice.testnet".into()), ..Default::default() };
        let doge = Candidate { identifier: "crypto:doge".into(), ticker: Some("doge".into()), pinned: true, surfacer: Some("radar".into()), ..Default::default() };
        let pepe = Candidate { identifier: "crypto:pepe".into(), ticker: Some("pepe".into()), ..Default::default() };
        let (new_trends, _) = decide(&[], &[(btc, "crypto:btc".into(), m(Some(40.0), Some(200_000.0))), (pepe, "crypto:pepe".into(), m(Some(40.0), Some(0.0))), (doge, "crypto:doge.2".into(), m(Some(40.0), None))], &p);
        assert_eq!(new_trends.len(), 2);
        assert_eq!(new_trends[0].asset.as_deref(), Some("BTC"));
        assert_eq!(new_trends[0].surfacer.as_deref(), Some("alice.testnet"));
        assert_eq!(new_trends[1].surfacer, None);
        assert_eq!(payable_surfacer(Some(&format!("0u{}", "a".repeat(52)))), Some(format!("0u{}", "a".repeat(52))));
    }
}
