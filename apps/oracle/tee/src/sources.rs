//! What the enclave reads, over HTTPS from inside the TEE: the backend's candidate queue and
//! collector readings, the registry's state through a NEAR RPC endpoint, and Hyperliquid's marks.

use crate::method::Readings;
use crate::plan::{Candidate, Trend};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;
use wasi_http_client::Client;

type Result<T> = std::result::Result<T, String>;

fn get(url: &str, token: Option<&str>) -> Result<Vec<u8>> {
    let mut req = Client::new().get(url).connect_timeout(Duration::from_secs(10));
    if let Some(t) = token {
        req = req.header("authorization", format!("Bearer {t}"));
    }
    let res = req.send().map_err(|e| format!("GET {url}: {e}"))?;
    if res.status() >= 300 {
        return Err(format!("GET {}: HTTP {}", url.split('?').next().unwrap_or(url), res.status()));
    }
    res.body().map_err(|e| e.to_string())
}

fn post(url: &str, body: &Value) -> Result<Vec<u8>> {
    let res = Client::new()
        .post(url)
        .header("content-type", "application/json")
        .connect_timeout(Duration::from_secs(10))
        .body(body.to_string().as_bytes())
        .send()
        .map_err(|e| format!("POST {url}: {e}"))?;
    if res.status() >= 300 {
        return Err(format!("POST {url}: HTTP {}", res.status()));
    }
    res.body().map_err(|e| e.to_string())
}

#[derive(Deserialize)]
pub struct Queue {
    #[serde(default)]
    pub candidates: Vec<Candidate>,
    #[serde(default)]
    pub rotating: Vec<String>,
}

pub fn candidates(backend: &str, token: &str) -> Result<Queue> {
    serde_json::from_slice(&get(&format!("{backend}/v1/oracle/candidates"), Some(token))?).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct Measured {
    trends: HashMap<String, MeasuredTrend>,
}

#[derive(Deserialize)]
struct MeasuredTrend {
    readings: Readings,
}

pub fn measurements(backend: &str, token: &str, bases: &[String]) -> Result<HashMap<String, Readings>> {
    if bases.is_empty() {
        return Ok(HashMap::new());
    }
    let ids: String = bases.join(",").bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
    let m: Measured = serde_json::from_slice(&get(&format!("{backend}/v1/oracle/measurements?ids={ids}"), Some(token))?).map_err(|e| e.to_string())?;
    Ok(m.trends.into_iter().map(|(k, v)| (k, v.readings)).collect())
}

/// A contract view through NEAR RPC (`call_function`), decoded as JSON.
pub fn view<T: serde::de::DeserializeOwned>(rpc: &str, contract: &str, method: &str, args: &Value) -> Result<T> {
    use base64::Engine;
    let body = json!({
        "jsonrpc": "2.0", "id": "tee", "method": "query",
        "params": { "request_type": "call_function", "finality": "final", "account_id": contract, "method_name": method,
                    "args_base64": base64::engine::general_purpose::STANDARD.encode(args.to_string()) }
    });
    let res: Value = serde_json::from_slice(&post(rpc, &body)?).map_err(|e| e.to_string())?;
    if let Some(err) = res.get("error").or_else(|| res.pointer("/result/error")) {
        return Err(format!("{method}: {err}"));
    }
    let bytes: Vec<u8> = serde_json::from_value(res.pointer("/result/result").cloned().ok_or("no result")?).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

pub fn trends(rpc: &str, registry: &str) -> Result<Vec<Trend>> {
    let mut out = Vec::new();
    loop {
        let page: Vec<Trend> = view(rpc, registry, "get_trends", &json!({ "from_index": out.len(), "limit": 100 }))?;
        let n = page.len();
        out.extend(page);
        if n < 100 {
            return Ok(out);
        }
    }
}

/// Hyperliquid perps listed on the network: symbol to mark price.
pub fn marks(hyperliquid: &str) -> Result<Vec<(String, f64)>> {
    let v: Value = serde_json::from_slice(&post(&format!("{hyperliquid}/info"), &json!({ "type": "metaAndAssetCtxs" }))?).map_err(|e| e.to_string())?;
    let universe = v.pointer("/0/universe").and_then(Value::as_array).ok_or("no universe")?;
    let ctxs = v.pointer("/1").and_then(Value::as_array).ok_or("no contexts")?;
    Ok(universe
        .iter()
        .zip(ctxs)
        .filter(|(u, _)| u.get("isDelisted").and_then(Value::as_bool) != Some(true))
        .filter_map(|(u, c)| Some((u.get("name")?.as_str()?.to_uppercase(), c.get("markPx")?.as_str()?.parse::<f64>().ok()?)))
        .collect())
}
