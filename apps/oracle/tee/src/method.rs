//! The attention index method (docs/index-method.md), the same as `apps/oracle/src/method.ts`
//! and `index-method.ts`: clip, deseasonalize (flat here), log-scale to saturation, weighted mean
//! over the sources that answered, smart money only beside attention, Hacker News only as a boost.

use serde::Deserialize;

pub const MAX_POINTS: f64 = 100.0;
pub const INDEX_SCALE: u64 = 1_000_000;
pub const MIN_INDEX_UNITS: u64 = 10_000;

pub struct CountSource {
    pub weight: f64,
    pub clip: f64,
    pub saturation: f64,
    pub max_age_sec: u64,
}

pub const ELFA: CountSource = CountSource { weight: 0.6, clip: 10_000.0, saturation: 5_000.0, max_age_sec: 43_200 };
pub const BLUESKY: CountSource = CountSource { weight: 0.35, clip: 10_000.0, saturation: 1_000.0, max_age_sec: 7_200 };
pub const GDELT: CountSource = CountSource { weight: 0.3, clip: 20_000.0, saturation: 3_000.0, max_age_sec: 7_200 };
pub const WIKIPEDIA: CountSource = CountSource { weight: 0.25, clip: 5_000_000.0, saturation: 150_000.0, max_age_sec: 172_800 };
pub const HN: CountSource = CountSource { weight: 0.15, clip: 5_000.0, saturation: 300.0, max_age_sec: 10_800 };
pub const NANSEN_WEIGHT: f64 = 0.2;
pub const NANSEN_SCALE_USD: f64 = 500_000.0;
pub const NANSEN_MAX_AGE_SEC: u64 = 43_200;
pub const MIN_CONFIRM_NETFLOW_USD: f64 = 100_000.0;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    pub value: f64,
    pub observed_at: u64,
}

#[derive(Deserialize, Default, Clone, Debug)]
pub struct Readings {
    pub elfa: Option<Reading>,
    pub bluesky: Option<Reading>,
    pub gdelt: Option<Reading>,
    pub wikipedia: Option<Reading>,
    pub hn: Option<Reading>,
    pub nansen: Option<Reading>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Measurement {
    pub points: Option<f64>,
    pub netflow_usd: Option<f64>,
}

struct Component {
    value: f64,
    weight: f64,
}

fn clamp01(x: f64) -> f64 {
    x.clamp(0.0, 1.0)
}

pub fn normalize_count(x: f64, clip: f64, saturation: f64) -> f64 {
    if !x.is_finite() || x <= 0.0 {
        return 0.0;
    }
    clamp01(x.min(clip).ln_1p() / saturation.ln_1p())
}

pub fn normalize_flow(netflow_usd: f64, scale_usd: f64) -> f64 {
    if !netflow_usd.is_finite() {
        return 0.5;
    }
    clamp01(0.5 + 0.5 * (netflow_usd / scale_usd).tanh())
}

fn attention_points(c: &[Component]) -> Option<f64> {
    let (mut w, mut sum) = (0.0, 0.0);
    for x in c {
        if !x.value.is_finite() || x.weight <= 0.0 {
            continue;
        }
        sum += clamp01(x.value) * x.weight;
        w += x.weight;
    }
    (w > 0.0).then(|| MAX_POINTS * sum / w)
}

fn boosted_points(mut components: Vec<Component>, mut boosts: Vec<Component>) -> Option<f64> {
    let mut points = attention_points(&components)?;
    boosts.sort_by(|a, b| b.value.partial_cmp(&a.value).unwrap_or(std::cmp::Ordering::Equal));
    for b in boosts {
        if !b.value.is_finite() || b.weight <= 0.0 || MAX_POINTS * clamp01(b.value) <= points {
            continue;
        }
        components.push(b);
        points = attention_points(&components).unwrap_or(points);
    }
    Some(points)
}

/// JavaScript's Math.round for the non-negative values used here.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// Points to registry units, rounded to 0.01 points and kept inside the registry bounds.
pub fn to_index_units(points: f64) -> u64 {
    let hundredths = js_round(points.clamp(0.0, MAX_POINTS) * 100.0) as u64;
    (hundredths * (INDEX_SCALE / 100)).max(MIN_INDEX_UNITS)
}

fn fresh(r: &Option<Reading>, now: u64, max_age: u64) -> Option<f64> {
    r.as_ref().filter(|r| r.value.is_finite() && now.saturating_sub(r.observed_at) <= max_age).map(|r| r.value)
}

pub fn measure(r: &Readings, crypto: bool, now: u64) -> Measurement {
    let mut components = Vec::new();
    for (reading, s) in [(&r.elfa, &ELFA), (&r.gdelt, &GDELT), (&r.wikipedia, &WIKIPEDIA), (&r.bluesky, &BLUESKY)] {
        if let Some(x) = fresh(reading, now, s.max_age_sec) {
            components.push(Component { value: normalize_count(x, s.clip, s.saturation), weight: s.weight });
        }
    }
    let flow = if crypto { fresh(&r.nansen, now, NANSEN_MAX_AGE_SEC) } else { None };
    if let Some(f) = flow {
        if !components.is_empty() {
            components.push(Component { value: normalize_flow(f, NANSEN_SCALE_USD), weight: NANSEN_WEIGHT });
        }
    }
    let mut boosts = Vec::new();
    if let Some(x) = fresh(&r.hn, now, HN.max_age_sec) {
        boosts.push(Component { value: normalize_count(x, HN.clip, HN.saturation), weight: HN.weight });
    }
    let points = boosted_points(components, boosts).map(|p| js_round(p * 100.0) / 100.0);
    Measurement { points, netflow_usd: flow }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_793_900_000;
    fn reading(value: f64, age: u64) -> Option<Reading> {
        Some(Reading { value, observed_at: NOW - age })
    }

    // The same vectors as apps/oracle/test/oracle.test.ts.
    #[test]
    fn matches_the_typescript_method() {
        assert_eq!(normalize_count(0.0, 10_000.0, 5_000.0), 0.0);
        assert!((normalize_count(5_000.0, 10_000.0, 5_000.0) - 1.0).abs() < 1e-12);
        assert_eq!(to_index_units(0.0), 10_000);
        assert_eq!(to_index_units(42.346), 42_350_000);
        let m = measure(&Readings { elfa: reading(5000.0, 60), bluesky: reading(1000.0, 99_999), ..Default::default() }, false, NOW);
        assert_eq!(m.points, Some(100.0));
        assert_eq!(measure(&Readings { nansen: reading(1e9, 60), ..Default::default() }, true, NOW).points, None);
        let with_flow = measure(&Readings { elfa: reading(5000.0, 60), nansen: reading(-1e9, 60), ..Default::default() }, true, NOW);
        assert!((with_flow.points.unwrap() - 75.0).abs() < 0.01);
        assert_eq!(with_flow.netflow_usd, Some(-1e9));
    }

    #[test]
    fn a_boost_only_lifts() {
        let base = || vec![Component { value: 0.5, weight: 1.0 }];
        assert_eq!(boosted_points(base(), vec![Component { value: 0.1, weight: 1.0 }]), Some(50.0));
        assert_eq!(boosted_points(base(), vec![Component { value: 0.9, weight: 1.0 }]), Some(70.0));
    }
}
