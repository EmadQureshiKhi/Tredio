//! How the registry knows a report came from the TEE oracle.

use near_sdk::json_types::Base64VecU8;
use near_sdk::{env, near, require};

use crate::{Registry, RegistryExt, Report};

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OracleConfig {
    /// Reports signed by an ed25519 key generated inside the TEE and never exported. The
    /// registry verifies the signature over SHA-256 of the exact report JSON bytes.
    TeeSigner {
        /// `ed25519:<base58>` public key the enclave published with its attestation.
        public_key: String,
    },
}

impl OracleConfig {
    pub fn assert_valid(&self) {
        match self {
            OracleConfig::TeeSigner { public_key } => {
                decode_ed25519(public_key);
            }
        }
    }
}

fn decode_ed25519(key: &str) -> [u8; 32] {
    let pk: near_sdk::PublicKey = key.parse().unwrap_or_else(|_| env::panic_str("bad public key"));
    require!(pk.curve_type() == near_sdk::CurveType::ED25519, "ed25519 key required");
    pk.as_bytes()[1..].try_into().unwrap_or_else(|_| env::panic_str("bad public key"))
}

#[near]
impl Registry {
    /// Applies a report signed by the TEE oracle's key. Anyone may relay it: the signature, the
    /// strictly increasing run id and the observation-time window are the guards.
    pub fn submit_report(&mut self, report_json: String, signature: Base64VecU8) {
        let OracleConfig::TeeSigner { public_key } = &self.oracle;
        let key = decode_ed25519(public_key);
        let sig: [u8; 64] =
            signature.0.as_slice().try_into().unwrap_or_else(|_| env::panic_str("bad signature"));
        let digest = env::sha256_array(report_json.as_bytes());
        require!(env::ed25519_verify(&sig, digest, &key), "signature does not verify");
        let report: Report =
            near_sdk::serde_json::from_str(&report_json).unwrap_or_else(|_| env::panic_str("bad report"));
        self.apply_report(report);
    }
}
