//! # Tredio account
//!
//! Every Tredio user account runs this contract, referenced by global code hash from a NEP-655
//! universal account (`0u...`) whose address is derived from its initial state: the passkey's
//! public key and the protocol contracts. There are no seed phrases and no full-access keys.
//!
//! - **Owner (passkey).** `owner_execute` runs a request signed by the passkey (WebAuthn,
//!   P-256, verified on chain), bound to this account and network with a nonce and a time
//!   window. The owner adds and revokes sessions, freezes them, withdraws, makes any call
//!   (limit orders, coin trades, margin top-ups), upgrades the code and signs with Chain
//!   Signatures.
//! - **Sessions.** A session is a function-call key on this account that may only call
//!   `session_call`, usually a gas key funded from the account so the browser sends trades
//!   straight to RPC. `session_call` takes typed actions only, and checks the session's expiry,
//!   scope and a gross daily USDC outflow limit that inflows never offset. Session swaps are
//!   anchored to the attention-implied value by the book; Hyperliquid orders pass the guard
//!   below before the MPC network signs them.
//! - **Hyperliquid guard.** A session's order must be within 2% of the oracle's fresh mark and
//!   leverage changes at most 10x; the account then builds the exact EIP-712 digest on chain and
//!   asks Chain Signatures to sign it for the account's derived address.

pub mod hyperliquid;
#[cfg(test)]
mod tests;
pub mod webauthn;

use near_sdk::json_types::{Base58CryptoHash, Base64VecU8, U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::{
    env, near, require, AccountId, Allowance, Gas, GasWeight, NearToken, PanicOnDefault, Promise,
    PromiseError, PublicKey,
};
use tredio_common::account_state::{AccountCore, Protocol, Scope, Session};
use tredio_common::{now_secs, Side};

use crate::hyperliquid::HlOrder;
use crate::webauthn::Proof;

/// Signed owner requests are valid from 10 minutes before to 5 minutes after `created_at`
/// (passkey prompts take a while; block time can lag the client clock).
pub const REQUEST_WINDOW_SECS: u64 = 600;
pub const REQUEST_SKEW_SECS: u64 = 300;
pub const MAX_SESSION_SECS: u64 = 30 * 86_400;
pub const MAX_SESSIONS: u32 = 16;
pub const SESSION_NONCES: u32 = 4;
/// Hyperliquid guard: price within 2% of a mark no older than two minutes, leverage at most 10x.
pub const HL_MAX_DEVIATION_BPS: u128 = 200;
pub const HL_MARK_MAX_AGE: u64 = 120;
pub const HL_MAX_LEVERAGE: u32 = 10;
/// Chain Signatures derivation path of the account's Hyperliquid address.
pub const HL_PATH: &str = "hyperliquid";
const DOMAIN: &[u8] = b"tredio-account:v1:";

const GAS_TOKEN_CALL: Gas = Gas::from_tgas(200);
const GAS_SIMPLE: Gas = Gas::from_tgas(30);
const GAS_VIEW: Gas = Gas::from_tgas(10);
const GAS_SIGN: Gas = Gas::from_tgas(50);
const GAS_AFTER_SIGN: Gas = Gas::from_tgas(10);
const GAS_GUARD: Gas = Gas::from_tgas(90);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

/// What the passkey can do.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum OwnerAction {
    AddSession {
        public_key: PublicKey,
        label: String,
        scope: Scope,
        expires_at: u64,
        daily_limit: U128,
        /// Add it as a gas key and move this many yoctoNEAR into its gas balance.
        gas_key: bool,
        gas_funding: U128,
    },
    RevokeSession {
        public_key: PublicKey,
    },
    /// Tops up a session gas key from the account's balance.
    FundSession {
        public_key: PublicKey,
        amount: U128,
    },
    Freeze {
        frozen: bool,
    },
    /// Any call: withdrawals, limit orders, coin trades, margin top-ups, storage.
    Call {
        receiver_id: AccountId,
        method_name: String,
        args: Base64VecU8,
        deposit: U128,
        gas: U64,
    },
    Transfer {
        receiver_id: AccountId,
        amount: U128,
    },
    /// Signs a 32-byte payload with Chain Signatures for this account at `path` (for example a
    /// Hyperliquid `approveAgent` digest). Must be the only action of its request.
    MpcSign {
        path: String,
        payload: String,
        domain_id: u32,
    },
    /// Switches the account to another published global code hash.
    Upgrade {
        code_hash: Base58CryptoHash,
    },
    SetProtocol {
        protocol: Protocol,
    },
}

/// An owner request: what the passkey signs (as the exact JSON text).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct OwnerRequest {
    pub account: AccountId,
    pub network: String,
    pub nonce: u64,
    pub created_at: u64,
    pub actions: Vec<OwnerAction>,
}

/// What a session can do. Every variant is checked against the session's scope and limit.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum SessionAction {
    /// Anchored Up/Down swap on the book: `amount` is USDC in for a buy, tokens in for a sell.
    Swap {
        series: u64,
        side: Side,
        buy: bool,
        amount: U128,
        min_out: U128,
    },
    MintSets {
        series: u64,
        amount: U128,
    },
    RedeemSets {
        series: u64,
        amount: U128,
    },
    RedeemWinnings {
        series: u64,
        up: U128,
        down: U128,
    },
    BookWithdraw {
        asset: near_sdk::serde_json::Value,
        amount: U128,
    },
    PerpOpen {
        trend: String,
        is_long: bool,
        margin: U128,
        leverage_bps: u32,
        acceptable_index: u64,
    },
    PerpClose {
        id: u64,
        acceptable_index: u64,
    },
    ClaimCuration,
    /// Testnet only: draws from the test USDC faucet.
    Faucet,
    HlOrder {
        order: HlOrder,
        nonce: u64,
    },
    HlLeverage {
        asset_index: u32,
        is_cross: bool,
        leverage: u32,
        nonce: u64,
    },
}

/// An EVM-style signature from Chain Signatures: r, s (hex) and v (27 or 28).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvmSignature {
    pub r: String,
    pub s: String,
    pub v: u8,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct AffinePoint {
    pub affine_point: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Scalar {
    pub scalar: String,
}

/// The MPC contract's answer for a secp256k1 request.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SignatureResponse {
    pub scheme: String,
    pub big_r: AffinePoint,
    pub s: Scalar,
    pub recovery_id: u8,
}

/// A registry mark as `mark_of` returns it.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Mark {
    pub price: U128,
    pub at: u64,
}

#[near(event_json(standard = "tredio-account"))]
pub enum Event<'a> {
    #[event_version("1.0.0")]
    OwnerExecuted { nonce: u64, actions: u32 },
    #[event_version("1.0.0")]
    SessionAdded {
        public_key: &'a PublicKey,
        label: &'a str,
        scope: &'a Scope,
        expires_at: u64,
        daily_limit: U128,
        gas_key: bool,
    },
    #[event_version("1.0.0")]
    SessionRevoked { public_key: &'a PublicKey },
    #[event_version("1.0.0")]
    Frozen { frozen: bool },
    #[event_version("1.0.0")]
    SessionAction { public_key: &'a PublicKey, action: &'a str, outflow: U128, spent_today: U128 },
    #[event_version("1.0.0")]
    HyperliquidSigned { digest: String, kind: &'a str },
    #[event_version("1.0.0")]
    GuardRejected { action: &'a str, reason: &'a str },
    #[event_version("1.0.0")]
    Upgraded { code_hash: &'a Base58CryptoHash },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Account {
    core: AccountCore,
}

#[near]
impl Account {
    /// For deployments outside the factory (tests, a named account). Universal accounts get
    /// their state from the factory's state init instead.
    #[init]
    pub fn new(owner_key: String, network: String, protocol: Protocol) -> Self {
        Self { core: AccountCore::new(parse_p256_key(&owner_key), network, protocol) }
    }

    // ---------------------------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------------------------

    /// Runs a passkey-signed request. Anyone may relay it.
    #[payable]
    pub fn owner_execute(&mut self, request: String, proof: Proof) -> Option<Promise> {
        let challenge = request_hash(&request);
        require!(
            webauthn::verify(&challenge, &proof, &self.core.owner_key),
            "passkey signature does not verify"
        );
        let r: OwnerRequest =
            serde_json::from_str(&request).unwrap_or_else(|_| env::panic_str("bad request"));
        require!(r.account == env::current_account_id(), "request is for another account");
        require!(r.network == self.core.network, "request is for another network");
        self.use_nonce(r.nonce, r.created_at);
        require!(!r.actions.is_empty(), "no actions");
        let n = r.actions.len() as u32;
        let has_sign = r.actions.iter().any(|a| matches!(a, OwnerAction::MpcSign { .. }));
        require!(!has_sign || n == 1, "mpc_sign must be the only action");
        Event::OwnerExecuted { nonce: r.nonce, actions: n }.emit();
        let mut last = None;
        for a in r.actions {
            if let Some(p) = self.run_owner(a) {
                if let Some(prev) = last.replace(p) {
                    prev.detach();
                }
            }
        }
        last
    }

    /// Registers this account with the protocol contracts that hold per-user state. Runs once,
    /// right after creation, from the account's own balance.
    pub fn bootstrap(&mut self) {
        require!(!self.core.bootstrapped, "already bootstrapped");
        self.core.bootstrapped = true;
        let p = &self.core.protocol;
        // USDC needs only registration; outcomes and perps keep the deposit for the balances and
        // positions the account will hold.
        let deposit = |to: &AccountId, yocto: NearToken, registration_only: bool| {
            Promise::new(to.clone()).function_call(
                "storage_deposit",
                json!({ "account_id": env::current_account_id(), "registration_only": registration_only })
                    .to_string()
                    .into_bytes(),
                yocto,
                GAS_VIEW,
            )
        };
        deposit(&p.usdc, NearToken::from_micronear(1_250), true).detach();
        deposit(&p.outcomes, NearToken::from_millinear(20), false).detach();
        deposit(&p.perps, NearToken::from_millinear(10), false).detach();
    }

    // ---------------------------------------------------------------------------------------
    // Sessions
    // ---------------------------------------------------------------------------------------

    /// One typed action from a session key. The transaction must be signed by a key registered
    /// as a session on this account.
    pub fn session_call(&mut self, action: SessionAction) -> Promise {
        require!(env::predecessor_account_id() == env::current_account_id(), "session keys only");
        require!(!self.core.frozen, "sessions are frozen");
        let key = env::signer_account_pk();
        let mut s =
            self.core.sessions.get(&key).cloned().unwrap_or_else(|| env::panic_str("not a session key"));
        let now = now_secs();
        require!(now <= s.expires_at, "session expired");
        let (name, needs, outflow) = describe(&action);
        let allowed = match needs {
            Need::Outcomes => s.scope.outcomes,
            Need::Perps => s.scope.perps,
            Need::Hyperliquid => s.scope.hyperliquid,
        };
        require!(allowed, "action outside the session scope");
        let day = now / 86_400;
        if s.day != day {
            s.day = day;
            s.spent = U128(0);
        }
        let spent = s.spent.0 + outflow;
        require!(spent <= s.daily_limit.0, "daily limit exceeded");
        s.spent = U128(spent);
        Event::SessionAction { public_key: &key, action: name, outflow: U128(outflow), spent_today: s.spent }
            .emit();
        self.core.sessions.insert(key, s);
        self.run_session(action)
    }

    // ---------------------------------------------------------------------------------------
    // Callbacks
    // ---------------------------------------------------------------------------------------

    /// Checks a Hyperliquid order against the registry's mark, then asks for the signature.
    #[private]
    pub fn on_hl_mark(
        &mut self,
        order: HlOrder,
        nonce: u64,
        #[callback_result] mark: Result<Option<Mark>, PromiseError>,
    ) -> Promise {
        let reject = |reason: &str| -> ! {
            Event::GuardRejected { action: "hl_order", reason }.emit();
            env::panic_str(reason)
        };
        let Ok(Some(mark)) = mark else { reject("no mark for asset") };
        if now_secs().saturating_sub(mark.at) > HL_MARK_MAX_AGE {
            reject("stale mark");
        }
        let Some(price) = hyperliquid::parse_e8(&order.price) else { reject("bad price") };
        if hyperliquid::parse_e8(&order.size).is_none_or(|s| s == 0) {
            reject("bad size");
        }
        if price.abs_diff(mark.price.0) * 10_000 > HL_MAX_DEVIATION_BPS * mark.price.0 {
            reject("price outside 2% of the mark");
        }
        let cid = hyperliquid::action_hash(&hyperliquid::order_action(&order), nonce);
        self.sign_hl(cid, "order")
    }

    /// Turns the MPC answer into an EVM signature (r, s, v).
    #[private]
    pub fn on_signed(#[callback_result] r: Result<SignatureResponse, PromiseError>) -> EvmSignature {
        let r = r.unwrap_or_else(|_| env::panic_str("signature request failed"));
        require!(r.scheme == "Secp256k1" && r.big_r.affine_point.len() == 66, "unexpected signature");
        EvmSignature { r: r.big_r.affine_point[2..].to_string(), s: r.s.scalar, v: r.recovery_id + 27 }
    }

    // ---------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------

    pub fn owner_key(&self) -> String {
        format!("p256:{}", near_sdk::bs58::encode(&self.core.owner_key).into_string())
    }

    pub fn network(&self) -> String {
        self.core.network.clone()
    }

    pub fn protocol(&self) -> Protocol {
        self.core.protocol.clone()
    }

    pub fn frozen(&self) -> bool {
        self.core.frozen
    }

    pub fn bootstrapped(&self) -> bool {
        self.core.bootstrapped
    }

    pub fn sessions(&self) -> Vec<(PublicKey, Session)> {
        self.core.sessions.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    pub fn session(&self, public_key: PublicKey) -> Option<Session> {
        self.core.sessions.get(&public_key).cloned()
    }

    /// The challenge a passkey must sign for `request` (base64url of the hash).
    pub fn challenge_of(&self, request: String) -> String {
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(request_hash(&request))
    }

    /// Whether `nonce` was used in the current replay window.
    pub fn nonce_used(&self, nonce: u64) -> bool {
        self.core.recent_nonces.iter().any(|(n, _)| *n == nonce)
    }
}

/// SHA-256 of the domain-tagged request text: what the passkey signs.
pub fn request_hash(request: &str) -> [u8; 32] {
    let mut data = DOMAIN.to_vec();
    data.extend_from_slice(request.as_bytes());
    env::sha256_array(&data)
}

/// `p256:<base58 of 33 bytes>` or 66 hex characters.
pub fn parse_p256_key(key: &str) -> Vec<u8> {
    let bytes = match key.strip_prefix("p256:") {
        Some(b58) => near_sdk::bs58::decode(b58).into_vec().unwrap_or_default(),
        None => hex::decode(key).unwrap_or_default(),
    };
    require!(
        bytes.len() == 33 && (bytes[0] == 2 || bytes[0] == 3),
        "owner key must be a compressed P-256 key"
    );
    bytes
}

enum Need {
    Outcomes,
    Perps,
    Hyperliquid,
}

/// Name, scope and USDC outflow of a session action.
fn describe(a: &SessionAction) -> (&'static str, Need, u128) {
    match a {
        SessionAction::Swap { buy: true, amount, .. } => ("swap_buy", Need::Outcomes, amount.0),
        SessionAction::Swap { .. } => ("swap_sell", Need::Outcomes, 0),
        SessionAction::MintSets { amount, .. } => ("mint_sets", Need::Outcomes, amount.0),
        SessionAction::RedeemSets { .. } => ("redeem_sets", Need::Outcomes, 0),
        SessionAction::RedeemWinnings { .. } => ("redeem_winnings", Need::Outcomes, 0),
        SessionAction::BookWithdraw { .. } => ("book_withdraw", Need::Outcomes, 0),
        SessionAction::ClaimCuration => ("claim_curation", Need::Outcomes, 0),
        SessionAction::Faucet => ("faucet", Need::Outcomes, 0),
        SessionAction::PerpOpen { margin, .. } => ("perp_open", Need::Perps, margin.0),
        SessionAction::PerpClose { .. } => ("perp_close", Need::Perps, 0),
        SessionAction::HlOrder { .. } => ("hl_order", Need::Hyperliquid, 0),
        SessionAction::HlLeverage { .. } => ("hl_leverage", Need::Hyperliquid, 0),
    }
}

impl Account {
    fn use_nonce(&mut self, nonce: u64, created_at: u64) {
        let now = now_secs();
        require!(
            created_at + REQUEST_WINDOW_SECS >= now && created_at <= now + REQUEST_SKEW_SECS,
            "request expired or from the future"
        );
        self.core.recent_nonces.retain(|(_, at)| at + REQUEST_WINDOW_SECS + REQUEST_SKEW_SECS >= now);
        require!(!self.core.recent_nonces.iter().any(|(n, _)| *n == nonce), "nonce already used");
        self.core.recent_nonces.push((nonce, created_at));
    }

    fn call(
        &self,
        receiver: &AccountId,
        method: &str,
        args: serde_json::Value,
        deposit: NearToken,
        gas: Gas,
    ) -> Promise {
        Promise::new(receiver.clone()).function_call(method, args.to_string().into_bytes(), deposit, gas)
    }

    fn run_owner(&mut self, a: OwnerAction) -> Option<Promise> {
        let me = env::current_account_id();
        match a {
            OwnerAction::AddSession {
                public_key,
                label,
                scope,
                expires_at,
                daily_limit,
                gas_key,
                gas_funding,
            } => {
                require!(
                    expires_at > now_secs() && expires_at <= now_secs() + MAX_SESSION_SECS,
                    "bad session expiry"
                );
                require!(label.len() <= 32, "label too long");
                require!(
                    self.core.sessions.len() < MAX_SESSIONS || self.core.sessions.contains_key(&public_key),
                    "too many sessions"
                );
                Event::SessionAdded {
                    public_key: &public_key,
                    label: &label,
                    scope: &scope,
                    expires_at,
                    daily_limit,
                    gas_key,
                }
                .emit();
                self.core.sessions.insert(
                    public_key.clone(),
                    Session {
                        label,
                        scope,
                        created_at: now_secs(),
                        expires_at,
                        daily_limit,
                        spent: U128(0),
                        day: 0,
                        gas_key,
                    },
                );
                let p = Promise::new(me.clone());
                Some(if gas_key {
                    let p = p.add_gas_key_allowance_function_call(
                        public_key.clone(),
                        SESSION_NONCES,
                        Allowance::Unlimited,
                        me,
                        "session_call".to_string(),
                    );
                    if gas_funding.0 > 0 {
                        p.transfer_to_gas_key(public_key, NearToken::from_yoctonear(gas_funding.0))
                    } else {
                        p
                    }
                } else {
                    p.add_access_key_allowance(
                        public_key,
                        Allowance::Unlimited,
                        me,
                        "session_call".to_string(),
                    )
                })
            }
            OwnerAction::RevokeSession { public_key } => {
                require!(self.core.sessions.remove(&public_key).is_some(), "unknown session");
                Event::SessionRevoked { public_key: &public_key }.emit();
                Some(Promise::new(me).delete_key(public_key))
            }
            OwnerAction::FundSession { public_key, amount } => {
                let s =
                    self.core.sessions.get(&public_key).unwrap_or_else(|| env::panic_str("unknown session"));
                require!(s.gas_key, "not a gas key");
                Some(Promise::new(me).transfer_to_gas_key(public_key, NearToken::from_yoctonear(amount.0)))
            }
            OwnerAction::Freeze { frozen } => {
                self.core.frozen = frozen;
                Event::Frozen { frozen }.emit();
                None
            }
            OwnerAction::Call { receiver_id, method_name, args, deposit, gas } => {
                Some(Promise::new(receiver_id).function_call_weight(
                    method_name,
                    args.0,
                    NearToken::from_yoctonear(deposit.0),
                    Gas::from_gas(gas.0),
                    GasWeight(1),
                ))
            }
            OwnerAction::Transfer { receiver_id, amount } => {
                Some(Promise::new(receiver_id).transfer(NearToken::from_yoctonear(amount.0)))
            }
            OwnerAction::MpcSign { path, payload, domain_id } => {
                let bytes = hex::decode(&payload).unwrap_or_default();
                require!(bytes.len() == 32 || domain_id == 1, "payload must be a 32-byte hash");
                Some(self.mpc_sign(&path, &payload, domain_id))
            }
            OwnerAction::Upgrade { code_hash } => {
                Event::Upgraded { code_hash: &code_hash }.emit();
                Some(Promise::new(me).use_global_contract(code_hash))
            }
            OwnerAction::SetProtocol { protocol } => {
                self.core.protocol = protocol;
                None
            }
        }
    }

    fn mpc_sign(&self, path: &str, payload_hex: &str, domain_id: u32) -> Promise {
        let payload =
            if domain_id == 1 { json!({ "Eddsa": payload_hex }) } else { json!({ "Ecdsa": payload_hex }) };
        self.call(
            &self.core.protocol.signer,
            "sign",
            json!({ "request": { "path": path, "payload_v2": payload, "domain_id": domain_id } }),
            ONE_YOCTO,
            GAS_SIGN,
        )
        .then(Self::ext(env::current_account_id()).with_static_gas(GAS_AFTER_SIGN).on_signed())
    }

    fn sign_hl(&self, connection_id: [u8; 32], kind: &str) -> Promise {
        let digest = hyperliquid::agent_digest(&connection_id, self.core.network == "mainnet");
        let hex_digest = hex::encode(digest);
        Event::HyperliquidSigned { digest: hex_digest.clone(), kind }.emit();
        self.mpc_sign(HL_PATH, &hex_digest, 0)
    }

    fn run_session(&mut self, a: SessionAction) -> Promise {
        let p = self.core.protocol.clone();
        match a {
            SessionAction::Swap { series, side, buy, amount, min_out } => {
                let msg = json!({ "swap": { "series": series, "side": side, "limit_tick": null, "min_out": min_out, "anchored": true } })
                    .to_string();
                if buy {
                    self.call(&p.usdc, "ft_transfer_call", json!({ "receiver_id": p.book, "amount": amount, "msg": msg }), ONE_YOCTO, GAS_TOKEN_CALL)
                } else {
                    self.call(
                        &p.outcomes,
                        "mt_transfer_call",
                        json!({ "receiver_id": p.book, "token_id": format!("{series}:{}", side.as_str()), "amount": amount, "msg": msg }),
                        ONE_YOCTO,
                        GAS_TOKEN_CALL,
                    )
                }
            }
            SessionAction::MintSets { series, amount } => self.call(
                &p.usdc,
                "ft_transfer_call",
                json!({ "receiver_id": p.outcomes, "amount": amount, "msg": json!({ "mint": { "series": series, "receiver": null } }).to_string() }),
                ONE_YOCTO,
                GAS_TOKEN_CALL,
            ),
            SessionAction::RedeemSets { series, amount } => {
                self.call(&p.outcomes, "redeem_sets", json!({ "series": series, "amount": amount }), NearToken::from_yoctonear(0), GAS_SIMPLE)
            }
            SessionAction::RedeemWinnings { series, up, down } => self.call(
                &p.outcomes,
                "redeem_winnings",
                json!({ "series": series, "up": up, "down": down }),
                NearToken::from_yoctonear(0),
                GAS_SIMPLE,
            ),
            SessionAction::BookWithdraw { asset, amount } => {
                self.call(&p.book, "withdraw", json!({ "asset": asset, "amount": amount }), NearToken::from_yoctonear(0), GAS_SIMPLE)
            }
            SessionAction::PerpOpen { trend, is_long, margin, leverage_bps, acceptable_index } => self.call(
                &p.usdc,
                "ft_transfer_call",
                json!({
                    "receiver_id": p.perps,
                    "amount": margin,
                    "msg": json!({ "open": { "trend": trend, "is_long": is_long, "leverage_bps": leverage_bps, "acceptable_index": acceptable_index, "deadline": null, "owner": null } }).to_string(),
                }),
                ONE_YOCTO,
                GAS_TOKEN_CALL,
            ),
            SessionAction::PerpClose { id, acceptable_index } => self.call(
                &p.perps,
                "close",
                json!({ "id": id, "acceptable_index": acceptable_index }),
                NearToken::from_yoctonear(0),
                GAS_TOKEN_CALL,
            ),
            SessionAction::ClaimCuration => self.call(&p.curation, "claim", json!({}), NearToken::from_yoctonear(0), GAS_SIMPLE),
            SessionAction::Faucet => {
                require!(self.core.network == "testnet", "the faucet is testnet only");
                self.call(&p.usdc, "faucet", json!({}), NearToken::from_yoctonear(0), GAS_SIMPLE)
            }
            SessionAction::HlOrder { order, nonce } => self
                .call(&p.registry, "mark_of", json!({ "asset": order.asset }), NearToken::from_yoctonear(0), GAS_VIEW)
                .then(Self::ext(env::current_account_id()).with_static_gas(GAS_GUARD).with_unused_gas_weight(1).on_hl_mark(order, nonce)),
            SessionAction::HlLeverage { asset_index, is_cross, leverage, nonce } => {
                if leverage == 0 || leverage > HL_MAX_LEVERAGE {
                    Event::GuardRejected { action: "hl_leverage", reason: "leverage above 10x" }.emit();
                    env::panic_str("leverage above 10x");
                }
                let cid = hyperliquid::action_hash(&hyperliquid::leverage_action(asset_index, is_cross, leverage), nonce);
                self.sign_hl(cid, "leverage")
            }
        }
    }
}
