//! Hyperliquid L1 actions built and hashed on chain, so the guard checks exactly what Chain
//! Signatures will sign.
//!
//! Hyperliquid signs an L1 action as an EIP-712 "phantom agent": the action is MessagePack
//! encoded (key order as Hyperliquid's own SDK writes it), followed by the nonce (8 bytes, big
//! endian) and a zero byte for "no vault"; its keccak256 is the agent's `connectionId`, and the
//! digest is EIP-712 over `Agent(string source, bytes32 connectionId)` in the `Exchange` domain
//! (chain id 1337, zero verifying contract). `source` is "a" on mainnet and "b" on testnet.

use near_sdk::{env, near, require};

/// One order, with price and size as the decimal strings Hyperliquid expects (no trailing zeros).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct HlOrder {
    /// Hyperliquid asset ticker (`BTC`), for the mark lookup.
    pub asset: String,
    /// Hyperliquid asset index (`a`).
    pub asset_index: u32,
    pub is_buy: bool,
    pub price: String,
    pub size: String,
    pub reduce_only: bool,
    /// `Gtc`, `Ioc` or `Alo`.
    pub tif: String,
}

struct Writer(Vec<u8>);

impl Writer {
    fn map(&mut self, n: u8) {
        self.0.push(0x80 | n);
    }
    fn array(&mut self, n: u8) {
        self.0.push(0x90 | n);
    }
    fn str(&mut self, s: &str) {
        let b = s.as_bytes();
        if b.len() < 32 {
            self.0.push(0xa0 | b.len() as u8);
        } else {
            self.0.push(0xd9);
            self.0.push(b.len() as u8);
        }
        self.0.extend_from_slice(b);
    }
    fn bool(&mut self, v: bool) {
        self.0.push(if v { 0xc3 } else { 0xc2 });
    }
    fn uint(&mut self, v: u64) {
        if v < 128 {
            self.0.push(v as u8);
        } else if v <= u8::MAX as u64 {
            self.0.extend_from_slice(&[0xcc, v as u8]);
        } else if v <= u16::MAX as u64 {
            self.0.push(0xcd);
            self.0.extend_from_slice(&(v as u16).to_be_bytes());
        } else if v <= u32::MAX as u64 {
            self.0.push(0xce);
            self.0.extend_from_slice(&(v as u32).to_be_bytes());
        } else {
            self.0.push(0xcf);
            self.0.extend_from_slice(&v.to_be_bytes());
        }
    }
}

/// `{"type":"order","orders":[{"a","b","p","s","r","t":{"limit":{"tif"}}}],"grouping":"na"}`.
pub fn order_action(o: &HlOrder) -> Vec<u8> {
    require!(matches!(o.tif.as_str(), "Gtc" | "Ioc" | "Alo"), "bad time in force");
    let mut w = Writer(Vec::with_capacity(96));
    w.map(3);
    w.str("type");
    w.str("order");
    w.str("orders");
    w.array(1);
    w.map(6);
    w.str("a");
    w.uint(o.asset_index as u64);
    w.str("b");
    w.bool(o.is_buy);
    w.str("p");
    w.str(&o.price);
    w.str("s");
    w.str(&o.size);
    w.str("r");
    w.bool(o.reduce_only);
    w.str("t");
    w.map(1);
    w.str("limit");
    w.map(1);
    w.str("tif");
    w.str(&o.tif);
    w.str("grouping");
    w.str("na");
    w.0
}

/// `{"type":"updateLeverage","asset","isCross","leverage"}`.
pub fn leverage_action(asset_index: u32, is_cross: bool, leverage: u32) -> Vec<u8> {
    let mut w = Writer(Vec::with_capacity(48));
    w.map(4);
    w.str("type");
    w.str("updateLeverage");
    w.str("asset");
    w.uint(asset_index as u64);
    w.str("isCross");
    w.bool(is_cross);
    w.str("leverage");
    w.uint(leverage as u64);
    w.0
}

/// keccak256(msgpack(action) || nonce (BE) || 0x00).
pub fn action_hash(action: &[u8], nonce: u64) -> [u8; 32] {
    let mut data = action.to_vec();
    data.extend_from_slice(&nonce.to_be_bytes());
    data.push(0);
    env::keccak256_array(&data)
}

fn word_u64(v: u64) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&v.to_be_bytes());
    w
}

/// The EIP-712 digest of the phantom agent for `connection_id`.
pub fn agent_digest(connection_id: &[u8; 32], mainnet: bool) -> [u8; 32] {
    let domain_type = env::keccak256_array(
        b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    );
    let mut domain = Vec::with_capacity(160);
    domain.extend_from_slice(&domain_type);
    domain.extend_from_slice(&env::keccak256_array(b"Exchange"));
    domain.extend_from_slice(&env::keccak256_array(b"1"));
    domain.extend_from_slice(&word_u64(1337));
    domain.extend_from_slice(&[0u8; 32]);
    let separator = env::keccak256_array(&domain);

    let agent_type = env::keccak256_array(b"Agent(string source,bytes32 connectionId)");
    let mut agent = Vec::with_capacity(96);
    agent.extend_from_slice(&agent_type);
    agent.extend_from_slice(&env::keccak256_array(if mainnet { b"a" } else { b"b" }));
    agent.extend_from_slice(connection_id);
    let hash = env::keccak256_array(&agent);

    let mut msg = Vec::with_capacity(66);
    msg.extend_from_slice(&[0x19, 0x01]);
    msg.extend_from_slice(&separator);
    msg.extend_from_slice(&hash);
    env::keccak256_array(&msg)
}

/// Parses a positive decimal string ("65000.5") into an integer scaled by 1e8.
pub fn parse_e8(s: &str) -> Option<u128> {
    if s.is_empty() || s.len() > 30 || s.starts_with('.') || s.ends_with('.') {
        return None;
    }
    let (int, frac) = s.split_once('.').unwrap_or((s, ""));
    if frac.len() > 8 || !int.bytes().all(|c| c.is_ascii_digit()) || !frac.bytes().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    let int: u128 = int.parse().ok()?;
    let mut frac_padded = frac.to_string();
    while frac_padded.len() < 8 {
        frac_padded.push('0');
    }
    let frac: u128 = frac_padded.parse().ok()?;
    int.checked_mul(100_000_000)?.checked_add(frac)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_like_the_reference_sdk() {
        let o = HlOrder {
            asset: "BTC".into(),
            asset_index: 0,
            is_buy: true,
            price: "65000".into(),
            size: "0.001".into(),
            reduce_only: false,
            tif: "Ioc".into(),
        };
        // msgpack.packb({"type":"order","orders":[{"a":0,"b":True,"p":"65000","s":"0.001","r":False,
        // "t":{"limit":{"tif":"Ioc"}}}],"grouping":"na"})
        let want = "83a474797065a56f72646572a66f72646572739186a161\
                    00a162c3a170a53635303030a173a5302e303031a172c2a174\
                    81a56c696d697481a3746966a3496f63a867726f7570696e67a26e61";
        assert_eq!(hex::encode(order_action(&o)), want);
        assert_eq!(
            hex::encode(leverage_action(3, false, 10)),
            "84a474797065ae7570646174654c65766572616765a5617373657403a7697343726f7373c2a86c65766572616765 0a"
                .replace(' ', "")
        );
    }

    #[test]
    fn parses_decimals() {
        assert_eq!(parse_e8("65000"), Some(6_500_000_000_000));
        assert_eq!(parse_e8("0.001"), Some(100_000));
        assert_eq!(parse_e8("1.23456789"), Some(123_456_789));
        for bad in ["", ".5", "5.", "1.234567891", "-1", "1e3", "1,5"] {
            assert_eq!(parse_e8(bad), None, "{bad}");
        }
    }

    #[test]
    fn digest_matches_an_independent_eip712_implementation() {
        // Computed in Python (msgpack + keccak) for the order above, nonce 1700000000000, testnet.
        let o = HlOrder {
            asset: "BTC".into(),
            asset_index: 0,
            is_buy: true,
            price: "65000".into(),
            size: "0.001".into(),
            reduce_only: false,
            tif: "Ioc".into(),
        };
        let cid = action_hash(&order_action(&o), 1_700_000_000_000);
        assert_eq!(hex::encode(cid), "3da5943d2d9f1ea6c0dbb3b01f6bbde493957855410e9a7a4dd5c766146a1883");
        assert_eq!(
            hex::encode(agent_digest(&cid, false)),
            "b2537461185e0995f837c1e35d7e8a19244a13383f2e5a7013e1572cd25543ba"
        );
        assert_ne!(agent_digest(&cid, true), agent_digest(&cid, false));
    }
}
