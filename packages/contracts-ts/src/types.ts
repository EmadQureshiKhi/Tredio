/**
 * JSON shapes of the Tredio contracts' views, arguments and events, mirroring the Rust types in
 * contracts/. Amounts that can exceed 2^53 are decimal strings (U128); the index (6 decimals,
 * at most 1e9) and unix-second times are plain numbers.
 */

export type AccountId = string;
/** A U128 as JSON: a decimal string. */
export type U128 = string;

export type AssetClass = "crypto" | "equity" | "commodity" | "fx" | "person" | "politics" | "topic";
export type TrendStatus = "active" | "cooling" | "retired";
export type Side = "up" | "down";
export type Dir = "buy" | "sell";
export type TimeInForce = "gtc" | "post_only" | "ioc";
export type Outcome = "open" | "up" | "down" | "void";
export type CurveStage = "creating" | "open" | "ready" | "pooled" | "graduated";

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

export interface Trend {
  id: string;
  asset_class: AssetClass;
  status: TrendStatus;
  created_at: number;
  updated_at: number;
  index: number;
  peak_index: number;
  below_floor_since: number;
  status_since: number;
  surfacer: AccountId | null;
  /** SHA-256 (hex) of the NEAR AI Cloud review bundle that approved the trend. */
  review_hash: string | null;
  /** Hyperliquid ticker of the underlying asset, if any. */
  asset: string | null;
  fresh: boolean;
}

export interface IndexSnapshot {
  id: string;
  status: TrendStatus;
  index: number;
  peak_index: number;
  updated_at: number;
  fresh: boolean;
  retired_at: number | null;
  surfacer: AccountId | null;
}

export interface Checkpoint {
  at: number;
  index: number;
}

export interface Settlement {
  finalized: boolean;
  value: number;
}

export interface Mark {
  /** Price with 8 decimals. */
  price: U128;
  at: number;
}

export interface RegistryParams {
  staleness_limit: number;
  max_move_bps: number;
  attention_floor: number;
  cooling_window: number;
  retire_window: number;
  stale_retire_window: number;
  settlement_tolerance: number;
  max_report_age: number;
  max_future_skew: number;
}

export type OracleConfig = { tee_signer: { public_key: string } };

export interface NewTrend {
  identifier: string;
  asset_class: AssetClass;
  index: number;
  surfacer: AccountId | null;
  smart_money_confirmed: boolean;
  review_hash: string | null;
  asset: string | null;
}

export interface Report {
  run_id: number;
  observed_at: number;
  new_trends: NewTrend[];
  updates: { id: string; index: number }[];
  marks: { asset: string; price: U128 }[];
}

// ---------------------------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------------------------

export interface Series {
  id: number;
  trend: string;
  window: number;
  number: number;
  opened_at: number;
  expiry: number;
  opening_index: number;
  settlement_index: number | null;
  outcome: Outcome;
  up_supply: U128;
  down_supply: U128;
  backing: U128;
}

// ---------------------------------------------------------------------------------------------
// Book
// ---------------------------------------------------------------------------------------------

export type BookAsset = "usdc" | { token: { series: number; side: Side } };

export interface Market {
  series: number;
  side: Side;
  trend: string;
  opening_index: number;
  expiry: number;
  last_tick: number | null;
  volume_usdc: U128;
  trades: number;
}

export interface Order {
  id: number;
  owner: AccountId;
  series: number;
  side: Side;
  dir: Dir;
  tick: number;
  remaining: U128;
  placed_at: number;
}

export interface OrderSpec {
  series: number;
  side: Side;
  dir: Dir;
  tick: number;
  size: U128;
  tif: TimeInForce;
}

export interface Placement {
  order_id: number | null;
  filled: U128;
  usdc: U128;
  skipped: boolean;
}

export interface Level {
  tick: number;
  price: U128;
  size: U128;
}

export interface Depth {
  series: number;
  side: Side;
  bids: Level[];
  asks: Level[];
  last_tick: number | null;
}

// ---------------------------------------------------------------------------------------------
// Perps
// ---------------------------------------------------------------------------------------------

export interface Position {
  id: number;
  owner: AccountId;
  trend: string;
  is_long: boolean;
  entry_index: number;
  /** Contracts, 18 decimals. */
  qty: U128;
  margin: U128;
  entry_funding: string;
  opened_at: number;
}

export interface PerpMarket {
  long_qty: U128;
  short_qty: U128;
  cum_long: string;
  cum_short: string;
  last_time: number;
  last_mark: number;
}

export interface PositionState {
  index: number;
  equity: string;
  pnl: string;
  funding: string;
  notional: U128;
  liquidatable: boolean;
  liquidation_index: number;
}

// ---------------------------------------------------------------------------------------------
// Coins
// ---------------------------------------------------------------------------------------------

export interface Curve {
  trend: string;
  coin: AccountId;
  stage: CurveStage;
  peak_at_creation: number;
  created_at: number;
  virtual_quote: U128;
  reserve: U128;
  sold: U128;
  floor_reserve: U128;
  graduation_liquidity: U128;
  pool_id: number | null;
  grad_coins: U128;
  grad_quote: U128;
  grad_minted: boolean;
  coins_deposited: boolean;
  quote_deposited: boolean;
}

export interface CurveQuote {
  out: U128;
  fee: U128;
  spot_after: U128;
}

// ---------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------

export interface Protocol {
  usdc: AccountId;
  registry: AccountId;
  outcomes: AccountId;
  book: AccountId;
  perps: AccountId;
  coins: AccountId;
  curation: AccountId;
  signer: AccountId;
  factory: AccountId;
}

export interface Scope {
  outcomes: boolean;
  perps: boolean;
  hyperliquid: boolean;
}

export interface Session {
  label: string;
  scope: Scope;
  created_at: number;
  expires_at: number;
  daily_limit: U128;
  spent: U128;
  day: number;
  gas_key: boolean;
}

export interface HlOrder {
  asset: string;
  asset_index: number;
  is_buy: boolean;
  price: string;
  size: string;
  reduce_only: boolean;
  tif: "Gtc" | "Ioc" | "Alo";
}

/** What a session key can ask its account to do. */
export type SessionAction =
  | { swap: { series: number; side: Side; buy: boolean; amount: U128; min_out: U128 } }
  | { mint_sets: { series: number; amount: U128 } }
  | { redeem_sets: { series: number; amount: U128 } }
  | { redeem_winnings: { series: number; up: U128; down: U128 } }
  | { book_withdraw: { asset: BookAsset; amount: U128 } }
  | { perp_open: { trend: string; is_long: boolean; margin: U128; leverage_bps: number; acceptable_index: number } }
  | { perp_close: { id: number; acceptable_index: number } }
  | "claim_curation"
  | "faucet"
  | { hl_order: { order: HlOrder; nonce: number } }
  | { hl_leverage: { asset_index: number; is_cross: boolean; leverage: number; nonce: number } };

/** What the passkey can ask its account to do. */
export type OwnerAction =
  | {
      add_session: {
        public_key: string;
        label: string;
        scope: Scope;
        expires_at: number;
        daily_limit: U128;
        gas_key: boolean;
        gas_funding: U128;
      };
    }
  | { revoke_session: { public_key: string } }
  | { fund_session: { public_key: string; amount: U128 } }
  | { freeze: { frozen: boolean } }
  | { call: { receiver_id: AccountId; method_name: string; args: string; deposit: U128; gas: string } }
  | { transfer: { receiver_id: AccountId; amount: U128 } }
  | { mpc_sign: { path: string; payload: string; domain_id: number } }
  | { upgrade: { code_hash: string } }
  | { set_protocol: { protocol: Protocol } };

export interface OwnerRequest {
  account: AccountId;
  network: "testnet" | "mainnet";
  nonce: number;
  created_at: number;
  actions: OwnerAction[];
}

/** A WebAuthn assertion with the signature as 64-byte r || s hex. */
export interface PasskeyProof {
  authenticator_data: string;
  client_data_json: string;
  signature: string;
}

export interface EvmSignature {
  r: string;
  s: string;
  v: number;
}
