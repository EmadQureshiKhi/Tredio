//! WebAuthn assertion check for the passkey owner, in the proof format of the
//! `wallet-webauthn-p256` contract in github.com/near/intents: the challenge is the request hash,
//! and the P-256 signature covers SHA-256(authenticatorData || SHA-256(clientDataJSON)), checked
//! with NEAR's `p256_verify` host function.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use near_sdk::{env, near, serde_json};

/// A passkey assertion as the browser returns it, with the signature converted from DER to
/// 64-byte r || s (hex).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Proof {
    /// base64url (no padding) authenticator data.
    pub authenticator_data: String,
    /// The exact clientDataJSON text.
    pub client_data_json: String,
    /// 64-byte r || s, hex.
    pub signature: String,
}

#[near(serializers = [json])]
struct ClientData {
    #[serde(rename = "type")]
    kind: String,
    challenge: String,
}

const FLAG_USER_PRESENT: u8 = 0x01;
/// The authenticator verified the person (Face ID, a fingerprint or a PIN), not only their presence (v3).
const FLAG_USER_VERIFIED: u8 = 0x04;

/// True when `proof` is the owner's passkey signing `challenge`.
pub fn verify(challenge: &[u8; 32], proof: &Proof, owner_key: &[u8]) -> bool {
    let Ok(key) = <[u8; 33]>::try_from(owner_key) else { return false };
    let Ok(auth) = URL_SAFE_NO_PAD.decode(proof.authenticator_data.trim_end_matches('=')) else {
        return false;
    };
    let both = FLAG_USER_PRESENT | FLAG_USER_VERIFIED;
    if auth.len() < 37 || auth[32] & both != both {
        return false;
    }
    let Ok(client) = serde_json::from_str::<ClientData>(&proof.client_data_json) else { return false };
    if client.kind != "webauthn.get" || client.challenge != URL_SAFE_NO_PAD.encode(challenge) {
        return false;
    }
    let Ok(sig) = hex::decode(&proof.signature) else { return false };
    let Ok(sig) = <[u8; 64]>::try_from(sig.as_slice()) else { return false };
    let mut message = auth;
    message.extend_from_slice(&env::sha256_array(proof.client_data_json.as_bytes()));
    env::p256_verify(&sig, &env::sha256_array(&message), &key)
}
