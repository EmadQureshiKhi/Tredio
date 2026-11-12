//! Tredio's attention oracle inside an OutLayer TEE (Intel TDX).
//!
//! Each run reads the collector's readings and the candidate queue from the Tredio API, the
//! registry's live trends through NEAR RPC and Hyperliquid's marks (each with its asset index),
//! applies the published index method (the same as `apps/oracle`), and signs the report with
//! this project's enclave-held ed25519 key (`signing_keys`, caller "none": one key per project,
//! never visible to anyone).
//! The registry trusts only that key, so it accepts only reports this code computed. The
//! endpoints are compiled in, so the code hash pins what the enclave reads; the caller's input
//! is ignored. Output: `{report_json, signature, public_key}` (base64 signature over
//! SHA-256 of the report JSON, `ed25519:<base58>` key), or `{report_json: null}` when nothing
//! changed enough to report.

mod method;
mod plan;
mod sources;

use plan::{base_of, Candidate, LiveTrend};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::{self, Read, Write};

#[cfg(target_family = "wasm")]
#[used]
#[link_section = "outlayer.manifest"]
static MANIFEST: [u8; include_bytes!("../manifest.json").len()] = *include_bytes!("../manifest.json");

const BACKEND: &str = match option_env!("TREDIO_BACKEND_URL") { Some(v) => v, None => "https://api.tredio.bid" };
const RPC: &str = match option_env!("TREDIO_RPC_URL") { Some(v) => v, None => "https://test.rpc.fastnear.com" };
const REGISTRY: &str = match option_env!("TREDIO_REGISTRY") { Some(v) => v, None => "registry.tredio.testnet" };
const HYPERLIQUID: &str = match option_env!("TREDIO_HYPERLIQUID_URL") { Some(v) => v, None => "https://api.hyperliquid-testnet.xyz" };
const MARK_ASSETS: [&str; 5] = ["BTC", "ETH", "SOL", "NEAR", "HYPE"];
const MAX_SAMPLES: usize = 24;
const MAX_CANDIDATES: usize = 2;
const MAX_LIVE: usize = 24;
const HEARTBEAT_SEC: u64 = 420;
const DEVIATION_BPS: u64 = 100;
const MIN_CREATE_POINTS: f64 = 5.0;
const KEY_PATH: &str = "report";

/// A mark as the registry reads it. `asset_index` binds the ticker to the Hyperliquid asset index
/// orders sign (account v2's guard checks it); a registry deployed before it stored indexes
/// ignores the field.
#[derive(Serialize)]
struct Mark {
    asset: String,
    price: String,
    asset_index: u32,
}

#[derive(Serialize)]
struct Report {
    run_id: u64,
    observed_at: u64,
    new_trends: Vec<plan::NewTrend>,
    updates: Vec<plan::Update>,
    marks: Vec<Mark>,
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn base58(bytes: &[u8]) -> String {
    const A: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut digits: Vec<u8> = Vec::new();
    for &b in bytes {
        let mut carry = b as u32;
        for d in digits.iter_mut() {
            carry += (*d as u32) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let zeros = bytes.iter().take_while(|b| **b == 0).count();
    std::iter::repeat_n('1', zeros).chain(digits.iter().rev().map(|d| A[*d as usize] as char)).collect()
}

fn run() -> Result<serde_json::Value, String> {
    // The API token is a project secret only the enclave can read; without it the run still posts marks.
    let token = std::env::var("BACKEND_TOKEN").unwrap_or_default();
    let observed_at = now();
    let all = sources::trends(RPC, REGISTRY)?;
    let last_run: u64 = sources::view(RPC, REGISTRY, "last_run_id", &serde_json::json!({}))?;
    let mut warnings: Vec<String> = Vec::new();
    let queue = if token.is_empty() {
        warnings.push("no BACKEND_TOKEN secret: no candidates or readings".into());
        sources::Queue { candidates: vec![], rotating: vec![] }
    } else {
        sources::candidates(BACKEND, &token).unwrap_or_else(|e| {
            warnings.push(e);
            sources::Queue { candidates: vec![], rotating: vec![] }
        })
    };
    let marks = sources::marks(HYPERLIQUID).unwrap_or_default();
    let rotating: HashSet<&str> = queue.rotating.iter().map(String::as_str).collect();

    let mut live = Vec::new();
    for t in all.iter().filter(|t| t.status != "retired" && !rotating.contains(t.id.as_str())) {
        let pending: Vec<u64> = sources::view(RPC, REGISTRY, "pending_expiries", &serde_json::json!({ "id": t.id })).unwrap_or_default();
        live.push(LiveTrend { trend: t.clone(), pending_due: pending.iter().filter(|e| **e <= observed_at).count() });
    }
    let live_bases: HashSet<&str> = all.iter().filter(|t| t.status != "retired").map(|t| base_of(&t.id)).collect();
    let fresh: Vec<Candidate> = queue.candidates.into_iter().filter(|c| !live_bases.contains(base_of(&c.identifier))).map(|c| Candidate { identifier: base_of(&c.identifier).to_string(), ..c }).collect();
    let ordered: Vec<Candidate> = fresh.iter().filter(|c| c.pinned).chain(fresh.iter().filter(|c| !c.pinned && c.pick)).chain(fresh.iter().filter(|c| !c.pinned && !c.pick)).cloned().collect();
    let (sample, picked) = plan::allocate(&live, &ordered, MAX_SAMPLES, MAX_CANDIDATES, plan::free_slots(&all, &rotating, MAX_LIVE));
    let status_of = |id: &str| all.iter().find(|t| t.id == id).map(|t| t.status.clone());
    let listings: Vec<(Candidate, String)> = picked.into_iter().filter_map(|c| plan::free_listing(&c.identifier, status_of).map(|id| (c, id))).collect();
    let mut bases: Vec<String> = sample.iter().map(|t| base_of(&t.trend.id).to_string()).chain(listings.iter().map(|(c, _)| c.identifier.clone())).collect();
    bases.sort();
    bases.dedup();
    // Without readings nothing is updated (an old value is never re-reported); marks still go out.
    let readings = if token.is_empty() {
        Default::default()
    } else {
        sources::measurements(BACKEND, &token, &bases).unwrap_or_else(|e| {
            warnings.push(e);
            Default::default()
        })
    };
    let m = |id: &str| method::measure(&readings.get(base_of(id)).cloned().unwrap_or_default(), plan::asset_class_of(id) == "crypto", observed_at);

    let hl_assets: HashSet<String> = marks.iter().map(|m| m.asset.clone()).collect();
    let (new_trends, updates) = plan::decide(
        &sample.iter().map(|t| (t.clone(), m(&t.trend.id))).collect::<Vec<_>>(),
        &listings.iter().map(|(c, id)| (c.clone(), id.clone(), m(id))).collect::<Vec<_>>(),
        &plan::DecideParams { now: observed_at, heartbeat_sec: HEARTBEAT_SEC, deviation_bps: DEVIATION_BPS, min_create_index_points: MIN_CREATE_POINTS, hyperliquid_assets: &hl_assets },
    );
    let wanted: HashSet<String> = MARK_ASSETS
        .iter()
        .map(|s| s.to_string())
        .chain(all.iter().filter(|t| t.status != "retired").filter_map(|t| t.asset.clone()))
        .chain(new_trends.iter().filter_map(|n| n.asset.clone()))
        .collect();
    let marks: Vec<Mark> = marks
        .into_iter()
        .filter(|m| wanted.contains(&m.asset) && m.price > 0.0)
        .map(|m| Mark { asset: m.symbol, price: format!("{}", (m.price * 1e8).round() as u128), asset_index: m.asset_index })
        .collect();
    if new_trends.is_empty() && updates.is_empty() && marks.is_empty() {
        return Ok(serde_json::json!({ "report_json": null, "observed_at": observed_at, "warnings": warnings }));
    }
    let report = Report { run_id: observed_at.max(last_run + 1), observed_at, new_trends, updates, marks };
    let json = serde_json::to_string(&report).map_err(|e| e.to_string())?;
    let digest = Sha256::digest(json.as_bytes());
    let signature = outlayer::signing_keys::sign(KEY_PATH, None, &digest).map_err(|e| format!("sign: {e:?}"))?;
    let public_key = outlayer::signing_keys::public_key(KEY_PATH, None).map_err(|e| format!("public key: {e:?}"))?;
    use base64::Engine;
    Ok(serde_json::json!({
        "report_json": json,
        "signature": base64::engine::general_purpose::STANDARD.encode(signature),
        "public_key": format!("ed25519:{}", base58(&public_key)),
        "observed_at": observed_at,
        "warnings": warnings,
    }))
}

fn main() {
    // The caller's input is read and ignored: nothing a caller sends can change the report.
    let _ = io::stdin().read_to_string(&mut String::new());
    let out = run().unwrap_or_else(|e| serde_json::json!({ "error": e }));
    print!("{out}");
    let _ = io::stdout().flush();
}

#[cfg(test)]
mod tests {
    #[test]
    fn base58_matches_near() {
        assert_eq!(super::base58(&[0, 0, 1]), "112");
        assert_eq!(super::base58(&[255; 4]), "7YXq9G");
    }
}
