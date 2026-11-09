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
//! - **Hyperliquid guard.** A session's order must be within 2% of the oracle's mark for the
//!   very asset index it signs, no older than five minutes, and leverage changes at most 10x; the
//!   account then builds the exact EIP-712 digest on chain and asks Chain Signatures to sign it
//!   for the account's derived address.
//!
//! ## v2
//!
//! - Adding a session for a key the account already has renews it in place (no new key), so a
//!   gas key keeps its prepaid gas. Revoking a gas key's session keeps the key, since deleting a
//!   gas key burns its balance, but the key can no longer act: `session_call` refuses keys
//!   without a session, and the key may call nothing else. Adding a session for such a dormant
//!   key reactivates it. `delete_key` removes a key for good.
//! - Token calls attach a small static gas plus all unused gas, so session transactions need
//!   about 150 Tgas instead of 300 (and a gas key half the float).
//! - A session can move NEAR from the account into its own gas key (`top_up_gas`), within a
//!   daily cap.
//! - State: `STATE` keeps the v1 layout (the factory writes it; v1 code reads it). What v2 adds
//!   lives under its own key and starts empty, so an account upgraded from v1 needs no
//!   migration.

pub mod hyperliquid;
#[cfg(test)]
mod tests;
pub mod webauthn;

use near_sdk::json_types::{Base58CryptoHash, Base64VecU8, U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::{
    env, near, require, AccountId, Allowance, CurveType, Gas, GasWeight, IntoStorageKey, NearToken,
    PanicOnDefault, Promise, PromiseError, PublicKey,
};
use tredio_common::account_state::{AccountCore, AccountKey, Protocol, Scope, Session};
use tredio_common::{now_secs, Side};

use crate::hyperliquid::HlOrder;
use crate::webauthn::Proof;

/// Signed owner requests are valid from 10 minutes before to 5 minutes after `created_at`
/// (passkey prompts take a while; block time can lag the client clock).
pub const REQUEST_WINDOW_SECS: u64 = 600;
pub const REQUEST_SKEW_SECS: u64 = 300;
/// The account code's version, as `version` reports it (v1 has no such view). v3 lets a session
/// act as the implicit account of its own key, for policy wallets (see `session_call`).
pub const VERSION: u32 = 3;
pub const MAX_SESSION_SECS: u64 = 30 * 86_400;
/// Most keys the account tracks: sessions plus dormant gas keys (every one is an access key).
pub const MAX_SESSIONS: u32 = 16;
pub const SESSION_NONCES: u32 = 4;
/// NEAR a session may move into its own gas key per UTC day with `top_up_gas`.
pub const GAS_TOP_UP_DAILY: NearToken = NearToken::from_millinear(500);
/// Liquid NEAR (beyond storage) a gas top-up always leaves on the account.
pub const ACCOUNT_RESERVE: NearToken = NearToken::from_millinear(50);
/// Least gas a session transaction that moves tokens or closes a position must attach, so an
/// underfunded one fails here, before it counts against the daily limit. An anchored sale needs
/// about 110 Tgas; 150 leaves room for a swap that fills several levels.
pub const MIN_TOKEN_CALL_GAS: Gas = Gas::from_tgas(120);
/// Hyperliquid guard: price within 2% of a mark no older than five minutes (the oracle reports
/// every five minutes), leverage at most 10x.
pub const HL_MAX_DEVIATION_BPS: u128 = 200;
pub const HL_MARK_MAX_AGE: u64 = 300;
pub const HL_MAX_LEVERAGE: u32 = 10;
/// Chain Signatures derivation path of the account's Hyperliquid address.
pub const HL_PATH: &str = "hyperliquid";
const DOMAIN: &[u8] = b"tredio-account:v1:";

/// Static gas of a call a session makes; each also gets all gas the transaction leaves unused.
const GAS_TOKEN_CALL: Gas = Gas::from_tgas(20);
const GAS_SIMPLE: Gas = Gas::from_tgas(20);
const GAS_VIEW: Gas = Gas::from_tgas(10);
const GAS_KEY_CALLBACK: Gas = Gas::from_tgas(5);
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
    /// Ends a session. A gas key stays on the account, dormant, unless `delete_key` (deleting a
    /// gas key burns its balance); a plain key is deleted. `delete_key` also removes a dormant key.
    RevokeSession {
        public_key: PublicKey,
        #[serde(default)]
        delete_key: bool,
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
    /// Moves `amount` yoctoNEAR from the account into the signing session's own gas key, within
    /// [`GAS_TOP_UP_DAILY`] per UTC day.
    TopUpGas {
        amount: U128,
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
    /// The asset's Hyperliquid index the oracle reported with the mark; a registry that does
    /// not report it yields none, and the guard then refuses the order.
    #[serde(default)]
    pub asset_index: Option<u32>,
}

/// What v2 keeps besides [`AccountCore`], under [`AccountKey::Extension`]. Absent on accounts
/// created or last written by v1 code, where it reads as empty.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct Extension {
    /// Gas keys whose session was revoked: still on the account, unable to act.
    pub dormant: Vec<PublicKey>,
    /// NEAR each session moved into its gas key today.
    pub top_ups: Vec<GasTopUp>,
}

/// NEAR a session moved into its own gas key on one UTC day.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GasTopUp {
    pub public_key: PublicKey,
    pub day: u64,
    pub amount: U128,
}

fn extension_key() -> Vec<u8> {
    AccountKey::Extension.into_storage_key()
}

fn load_extension() -> Extension {
    env::storage_read(&extension_key())
        .map(|b| near_sdk::borsh::from_slice(&b).unwrap_or_else(|_| env::panic_str("bad extension state")))
        .unwrap_or_default()
}

fn save_extension(e: &Extension) {
    if e.dormant.is_empty() && e.top_ups.is_empty() {
        env::storage_remove(&extension_key());
    } else {
        let bytes =
            near_sdk::borsh::to_vec(e).unwrap_or_else(|_| env::panic_str("extension encoding failed"));
        env::storage_write(&extension_key(), &bytes);
    }
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
    /// A revoked session's gas key stays on the account, unable to act.
    #[event_version("1.0.0")]
    SessionKeyKept { public_key: &'a PublicKey },
    #[event_version("1.0.0")]
    SessionKeyDeleted { public_key: &'a PublicKey },
    /// The key of a new session could not be added, so the session was dropped.
    #[event_version("1.0.0")]
    SessionKeyFailed { public_key: &'a PublicKey },
    #[event_version("1.0.0")]
    GasToppedUp { public_key: &'a PublicKey, amount: U128, today: U128 },
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
    /// right after creation, from the account's own balance; later calls do nothing.
    pub fn bootstrap(&mut self) {
        // A no-op afterwards, so the factory can top up an existing account.
        if self.core.bootstrapped {
            return;
        }
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
        let key = env::signer_account_pk();
        let caller = env::predecessor_account_id();
        // A session acts through its key on this account, or as the implicit account of that same
        // key calling directly: custody enclaves (OutLayer policy wallets, the Agent API) sign only as
        // their own account. Either way the session below bounds the call, so only whoever holds a
        // session's key can use it, and the passkey alone adds sessions.
        let from_wallet = caller != env::current_account_id()
            && caller == env::signer_account_id()
            && is_implicit_of(&caller, &key);
        require!(caller == env::current_account_id() || from_wallet, "session keys only");
        require!(!self.core.frozen, "sessions are frozen");
        let mut s =
            self.core.sessions.get(&key).cloned().unwrap_or_else(|| env::panic_str("not a session key"));
        // A gas key prepays its calls from the account; it never signs from elsewhere.
        require!(!from_wallet || !s.gas_key, "a gas key session signs as the account");
        let now = now_secs();
        require!(now <= s.expires_at, "session expired");
        let (name, needs, outflow) = describe(&action);
        let allowed = match needs {
            Need::Outcomes => s.scope.outcomes,
            Need::Perps => s.scope.perps,
            Need::Hyperliquid => s.scope.hyperliquid,
            Need::Any => true,
        };
        require!(allowed, "action outside the session scope");
        if moves_tokens(&action) {
            require!(env::prepaid_gas() >= MIN_TOKEN_CALL_GAS, "attach at least 120 Tgas");
        }
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
        if matches!(action, SessionAction::TopUpGas { .. }) {
            require!(s.gas_key, "not a gas key");
        }
        self.core.sessions.insert(key.clone(), s);
        self.run_session(action, key, day)
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
        // The mark was looked up by ticker, but the order signs an asset index: they must match,
        // or a mark of one asset would vouch for a price on another.
        if mark.asset_index != Some(order.asset_index) {
            reject("mark is for another asset");
        }
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

    /// Drops a new session whose key batch failed (for example the account could not cover
    /// the key's storage), so no session is left without a key. Returns whether the key landed.
    #[private]
    pub fn on_session_key(&mut self, public_key: PublicKey, created_at: u64) -> bool {
        if tredio_common::promise_succeeded() {
            return true;
        }
        if self.core.sessions.get(&public_key).is_some_and(|s| s.created_at == created_at) {
            self.core.sessions.remove(&public_key);
            Event::SessionKeyFailed { public_key: &public_key }.emit();
        }
        false
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

    /// The account code's version (2). v1 code has no such view.
    pub fn version(&self) -> u32 {
        VERSION
    }

    /// Gas keys whose session was revoked: on the account, unable to act.
    pub fn dormant_keys(&self) -> Vec<PublicKey> {
        load_extension().dormant
    }

    /// NEAR `public_key`'s session moved into its gas key today (UTC), and the daily cap.
    pub fn gas_top_up_of(&self, public_key: PublicKey) -> (U128, U128) {
        let day = now_secs() / 86_400;
        let today = load_extension()
            .top_ups
            .into_iter()
            .find(|t| t.public_key == public_key && t.day == day)
            .map_or(0, |t| t.amount.0);
        (U128(today), U128(GAS_TOP_UP_DAILY.as_yoctonear()))
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
    /// Allowed in every scope (the session's own gas).
    Any,
}

/// Actions whose calls carry tokens or settle positions down a chain of cross-contract calls.
fn moves_tokens(a: &SessionAction) -> bool {
    matches!(
        a,
        SessionAction::Swap { .. }
            | SessionAction::MintSets { .. }
            | SessionAction::PerpOpen { .. }
            | SessionAction::PerpClose { .. }
    )
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
        SessionAction::TopUpGas { .. } => ("top_up_gas", Need::Any, 0),
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

    /// A session's call: `gas` static plus every gas unit the transaction leaves unused.
    fn session_call_to(
        &self,
        receiver: &AccountId,
        method: &str,
        args: serde_json::Value,
        deposit: NearToken,
        gas: Gas,
    ) -> Promise {
        Promise::new(receiver.clone()).function_call_weight(
            method,
            args.to_string().into_bytes(),
            deposit,
            gas,
            GasWeight(1),
        )
    }

    /// Moves `amount` from the account into `key`'s gas balance, within the daily cap and
    /// leaving the account its storage and a reserve.
    fn top_up_gas(&mut self, key: PublicKey, amount: u128, day: u64) -> Promise {
        require!(amount > 0, "zero amount");
        let mut ext = load_extension();
        ext.top_ups.retain(|t| t.day == day && self.core.sessions.contains_key(&t.public_key));
        let today = ext.top_ups.iter().find(|t| t.public_key == key).map_or(0, |t| t.amount.0) + amount;
        require!(today <= GAS_TOP_UP_DAILY.as_yoctonear(), "daily gas top-up cap exceeded");
        let storage = env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear();
        let free = env::account_balance().as_yoctonear().saturating_sub(storage);
        require!(free >= amount + ACCOUNT_RESERVE.as_yoctonear(), "not enough NEAR on the account");
        match ext.top_ups.iter_mut().find(|t| t.public_key == key) {
            Some(t) => t.amount = U128(today),
            None => ext.top_ups.push(GasTopUp { public_key: key.clone(), day, amount: U128(today) }),
        }
        save_extension(&ext);
        Event::GasToppedUp { public_key: &key, amount: U128(amount), today: U128(today) }.emit();
        Promise::new(env::current_account_id()).transfer_to_gas_key(key, NearToken::from_yoctonear(amount))
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
                let now = now_secs();
                require!(expires_at > now && expires_at <= now + MAX_SESSION_SECS, "bad session expiry");
                require!(label.len() <= 32, "label too long");
                Event::SessionAdded {
                    public_key: &public_key,
                    label: &label,
                    scope: &scope,
                    expires_at,
                    daily_limit,
                    gas_key,
                }
                .emit();
                let funding =
                    (gas_key && gas_funding.0 > 0).then_some(NearToken::from_yoctonear(gas_funding.0));
                let mut ext = load_extension();
                if let Some(s) = self.core.sessions.get(&public_key).cloned() {
                    // Renewal: the key is already on the account (a gas key keeps its prepaid
                    // gas). Today's spending carries over; the new terms apply from now.
                    require!(
                        s.gas_key == gas_key,
                        "a session key cannot change type; revoke and delete it first"
                    );
                    self.core
                        .sessions
                        .insert(public_key.clone(), Session { label, scope, expires_at, daily_limit, ..s });
                    return funding.map(|f| Promise::new(me).transfer_to_gas_key(public_key, f));
                }
                let session = Session {
                    label,
                    scope,
                    created_at: now,
                    expires_at,
                    daily_limit,
                    spent: U128(0),
                    day: 0,
                    gas_key,
                };
                if let Some(i) = ext.dormant.iter().position(|k| k == &public_key) {
                    // A revoked gas key comes back with its remaining balance.
                    require!(gas_key, "this key is a gas key");
                    ext.dormant.remove(i);
                    save_extension(&ext);
                    self.core.sessions.insert(public_key.clone(), session);
                    return funding.map(|f| Promise::new(me).transfer_to_gas_key(public_key, f));
                }
                require!(
                    self.core.sessions.len() + (ext.dormant.len() as u32) < MAX_SESSIONS,
                    "too many sessions"
                );
                self.core.sessions.insert(public_key.clone(), session);
                let p = Promise::new(me.clone());
                let p = if gas_key {
                    let p = p.add_gas_key_allowance_function_call(
                        public_key.clone(),
                        SESSION_NONCES,
                        Allowance::Unlimited,
                        me.clone(),
                        "session_call".to_string(),
                    );
                    match funding {
                        Some(f) => p.transfer_to_gas_key(public_key.clone(), f),
                        None => p,
                    }
                } else {
                    // Unlimited: an allowance is charged the attached gas at 1e9 yocto per gas
                    // (a 300 Tgas call takes 0.3 NEAR of it), so a cap small enough to matter
                    // would stop the key. Plain keys are meant for meta transactions, where the
                    // relayer pays.
                    p.add_access_key_allowance(
                        public_key.clone(),
                        Allowance::Unlimited,
                        me.clone(),
                        "session_call".to_string(),
                    )
                };
                Some(p.then(Self::ext(me).with_static_gas(GAS_KEY_CALLBACK).on_session_key(public_key, now)))
            }
            OwnerAction::RevokeSession { public_key, delete_key } => {
                let mut ext = load_extension();
                ext.top_ups.retain(|t| t.public_key != public_key);
                if let Some(s) = self.core.sessions.remove(&public_key) {
                    Event::SessionRevoked { public_key: &public_key }.emit();
                    if s.gas_key && !delete_key {
                        // Deleting a gas key burns its balance: keep it, unable to act.
                        ext.dormant.push(public_key.clone());
                        save_extension(&ext);
                        Event::SessionKeyKept { public_key: &public_key }.emit();
                        return None;
                    }
                } else {
                    let i = ext.dormant.iter().position(|k| k == &public_key);
                    let Some(i) = i.filter(|_| delete_key) else { env::panic_str("unknown session") };
                    ext.dormant.remove(i);
                }
                save_extension(&ext);
                Event::SessionKeyDeleted { public_key: &public_key }.emit();
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

    fn run_session(&mut self, a: SessionAction, key: PublicKey, day: u64) -> Promise {
        let p = self.core.protocol.clone();
        match a {
            SessionAction::Swap { series, side, buy, amount, min_out } => {
                let msg = json!({ "swap": { "series": series, "side": side, "limit_tick": null, "min_out": min_out, "anchored": true } })
                    .to_string();
                if buy {
                    self.session_call_to(&p.usdc, "ft_transfer_call", json!({ "receiver_id": p.book, "amount": amount, "msg": msg }), ONE_YOCTO, GAS_TOKEN_CALL)
                } else {
                    self.session_call_to(
                        &p.outcomes,
                        "mt_transfer_call",
                        json!({ "receiver_id": p.book, "token_id": format!("{series}:{}", side.as_str()), "amount": amount, "msg": msg }),
                        ONE_YOCTO,
                        GAS_TOKEN_CALL,
                    )
                }
            }
            SessionAction::MintSets { series, amount } => self.session_call_to(
                &p.usdc,
                "ft_transfer_call",
                json!({ "receiver_id": p.outcomes, "amount": amount, "msg": json!({ "mint": { "series": series, "receiver": null } }).to_string() }),
                ONE_YOCTO,
                GAS_TOKEN_CALL,
            ),
            SessionAction::RedeemSets { series, amount } => {
                self.session_call_to(&p.outcomes, "redeem_sets", json!({ "series": series, "amount": amount }), NearToken::from_yoctonear(0), GAS_SIMPLE)
            }
            SessionAction::RedeemWinnings { series, up, down } => self.session_call_to(
                &p.outcomes,
                "redeem_winnings",
                json!({ "series": series, "up": up, "down": down }),
                NearToken::from_yoctonear(0),
                GAS_SIMPLE,
            ),
            SessionAction::BookWithdraw { asset, amount } => {
                self.session_call_to(&p.book, "withdraw", json!({ "asset": asset, "amount": amount }), NearToken::from_yoctonear(0), GAS_SIMPLE)
            }
            SessionAction::PerpOpen { trend, is_long, margin, leverage_bps, acceptable_index } => self.session_call_to(
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
            SessionAction::PerpClose { id, acceptable_index } => self.session_call_to(
                &p.perps,
                "close",
                json!({ "id": id, "acceptable_index": acceptable_index }),
                NearToken::from_yoctonear(0),
                GAS_TOKEN_CALL,
            ),
            SessionAction::ClaimCuration => self.session_call_to(&p.curation, "claim", json!({}), NearToken::from_yoctonear(0), GAS_SIMPLE),
            SessionAction::Faucet => {
                require!(self.core.network == "testnet", "the faucet is testnet only");
                self.session_call_to(&p.usdc, "faucet", json!({}), NearToken::from_yoctonear(0), GAS_SIMPLE)
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
            SessionAction::TopUpGas { amount } => self.top_up_gas(key, amount.0, day),
        }
    }
}

/// Whether `account` is the implicit account of the ed25519 `key` (its 32 bytes as 64 hex characters).
fn is_implicit_of(account: &AccountId, key: &PublicKey) -> bool {
    key.curve_type() == CurveType::ED25519 && hex::encode(&key.as_bytes()[1..]) == account.as_str()
}
