/**
 * NEP-297 events (`EVENT_JSON:{...}` logs) and the shape of every event the derived tables read.
 * near-sdk's event macro logs `data` as an object; NEP-141 and NEP-245 log an array of objects.
 * Integers up to u64 are JSON numbers, U128 and i128 values are decimal strings.
 */
import { z } from "zod";

export interface NearEvent {
  standard: string;
  version: string;
  event: string;
  data: unknown;
}

const PREFIX = "EVENT_JSON:";

/** The events in one receipt's logs, each with the index of the log line it came from. */
export function parseEvents(logs: readonly string[]): Array<NearEvent & { logIndex: number }> {
  const out: Array<NearEvent & { logIndex: number }> = [];
  logs.forEach((log, logIndex) => {
    if (!log.startsWith(PREFIX)) return;
    try {
      const e = JSON.parse(log.slice(PREFIX.length)) as Partial<NearEvent>;
      if (typeof e.standard === "string" && typeof e.event === "string" && e.data !== undefined) {
        out.push({ standard: e.standard, version: typeof e.version === "string" ? e.version : "", event: e.event, data: e.data, logIndex });
      }
    } catch {
      // A malformed log is not an event.
    }
  });
  return out;
}

/** Integers the contracts log as JSON numbers, within what a JS number and Postgres hold. */
const u64 = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const u32 = z.number().int().nonnegative().max(2_147_483_647);
/** Unix seconds, within what a JS Date holds. */
const unix = z.number().int().nonnegative().max(8_640_000_000_000);
const u128 = z.string().regex(/^\d+$/);
const i128 = z.string().regex(/^-?\d+$/);
const account = z.string().min(2).max(64);
const side = z.enum(["up", "down"]);
const dir = z.enum(["buy", "sell"]);
const status = z.enum(["active", "cooling", "retired"]);
const outcome = z.enum(["open", "up", "down", "void"]);
const memo = z.string().nullish();

export const registry = {
  report_processed: z.object({ run_id: u64, observed_at: unix, created: u32, updated: u32, marks: u32, rejected: u32 }),
  trend_created: z.object({
    id: z.string().min(1),
    asset_class: z.string().min(1),
    surfacer: account.nullish(),
    index: u64,
    observed_at: unix,
    review_hash: z.string().nullish(),
    asset: z.string().nullish(),
  }),
  index_updated: z.object({ id: z.string().min(1), index: u64, peak_index: u64, observed_at: unix, clamped: z.boolean() }),
  index_clamped: z.object({ id: z.string(), proposed: u64, applied: u64 }),
  status_changed: z.object({ id: z.string().min(1), from: status.nullish(), to: status, at: unix }),
  settlement_finalized: z.object({ id: z.string().min(1), expiry: unix, value: u64 }),
  settlement_missed: z.object({ id: z.string().min(1), expiry: unix, first_observation: unix }),
  item_rejected: z.object({ id: z.string(), kind: z.string(), reason: z.string() }),
  mark_updated: z.object({ asset: z.string().min(1), price: u128, at: unix }),
  oracle_changed: z.object({ config: z.unknown() }),
};

export const outcomes = {
  series_opened: z.object({
    series: u64,
    trend: z.string().min(1),
    window: u32,
    number: u32,
    opened_at: unix,
    expiry: unix,
    opening_index: u64,
  }),
  sets_minted: z.object({ series: u64, payer: account, receiver: account, amount: u128 }),
  sets_redeemed: z.object({ series: u64, owner: account, amount: u128 }),
  series_settled: z.object({ series: u64, outcome, opening_index: u64, settlement_index: u64.nullish() }),
  winnings_redeemed: z.object({ series: u64, owner: account, up: u128, down: u128, payout: u128 }),
  payout_failed: z.object({ series: u64, owner: account, amount: u128 }),
};

const tokenAmounts = { token_ids: z.array(z.string()), amounts: z.array(u128), memo };
export const nep245 = {
  mt_mint: z.array(z.object({ owner_id: account, ...tokenAmounts })),
  mt_burn: z.array(z.object({ owner_id: account, authorized_id: account.nullish(), ...tokenAmounts })),
  mt_transfer: z.array(
    z.object({ authorized_id: account.nullish(), old_owner_id: account, new_owner_id: account, ...tokenAmounts }),
  ),
};

const asset = z.union([z.literal("usdc"), z.object({ token: z.object({ series: u64, side }) })]);
export const book = {
  market_listed: z.object({ series: u64, side, trend: z.string().min(1), expiry: unix }),
  deposit: z.object({ account, asset, amount: u128 }),
  withdraw: z.object({ account, asset, amount: u128 }),
  order_placed: z.object({ id: u64, owner: account, series: u64, side, dir, tick: u32, size: u128 }),
  order_cancelled: z.object({ id: u64, owner: account, remaining: u128 }),
  order_skipped: z.object({ owner: account, series: u64, side, dir, tick: u32, reason: z.string() }),
  trade: z.object({
    series: u64,
    side,
    maker_order: u64,
    maker: account,
    taker: account,
    taker_dir: dir,
    tick: u32,
    size: u128,
    usdc: u128,
    fee: u128,
  }),
  swap: z.object({
    account,
    series: u64,
    side,
    dir,
    anchored: z.boolean(),
    fair: u128.nullish(),
    amount_in: u128,
    amount_out: u128,
  }),
  delivery_failed: z.object({ account, asset, amount: u128 }),
};

export const perps = {
  poked: z.object({ trend: z.string().min(1), mark: u64, cum_long: i128, cum_short: i128, at: unix }),
  position_opened: z.object({
    id: u64,
    owner: account,
    trend: z.string().min(1),
    is_long: z.boolean(),
    qty: u128,
    margin: u128,
    entry_index: u64,
    fee: u128,
    payer: account,
  }),
  margin_added: z.object({ id: u64, payer: account, amount: u128 }),
  position_closed: z.object({
    id: u64,
    owner: account,
    trend: z.string().min(1),
    is_long: z.boolean(),
    entry_index: u64,
    exit_index: u64,
    qty: u128,
    margin: u128,
    pnl: i128,
    funding: i128,
    fee: u128,
    payout: u128,
    retired: z.boolean(),
  }),
  position_liquidated: z.object({ id: u64, owner: account, liquidator: account, exit_index: u64, equity: i128, reward: u128 }),
  socialized_loss: z.object({ id: u64, shortfall: u128 }),
  pool_deposit: z.object({ from: account, amount: u128 }),
  open_refused: z.object({ owner: account, trend: z.string(), reason: z.string(), amount: u128 }),
  payout_deferred: z.object({ account, amount: u128 }),
};

export const coins = {
  curve_created: z.object({ trend: z.string().min(1), coin: account, virtual_quote: u128, peak_at_creation: u64 }),
  curve_failed: z.object({ trend: z.string(), coin: account }),
  trade: z.object({
    trend: z.string().min(1),
    trader: account,
    is_buy: z.boolean(),
    usdc: u128,
    coins: u128,
    fee: u128,
    reserve: u128,
    sold: u128,
    spot: u128,
  }),
  floor_raised: z.object({ trend: z.string().min(1), virtual_quote: u128, cost: u128, ratchet_bps: u128 }),
  graduation_ready: z.object({ trend: z.string().min(1), reserve: u128 }),
  graduation_step: z.object({ trend: z.string().min(1), step: z.string(), ok: z.boolean() }),
  graduated: z.object({ trend: z.string().min(1), exchange: account, pool_id: u64, coins: u128, usdc: u128 }),
  trade_refused: z.object({ trend: z.string(), trader: account, reason: z.string(), amount: u128 }),
  delivery_deferred: z.object({ trend: z.string(), account, coins: u128, usdc: u128 }),
};

export const curation = {
  accrued: z.object({ trend: z.string().min(1), surfacer: account, source: account, amount: u128 }),
  claimed: z.object({ account, amount: u128 }),
  claim_refunded: z.object({ account, amount: u128 }),
};

const scope = z.object({ outcomes: z.boolean(), perps: z.boolean(), hyperliquid: z.boolean() });
export const userAccount = {
  owner_executed: z.object({ nonce: u64, actions: u32 }),
  session_added: z.object({
    public_key: z.string().min(1),
    label: z.string(),
    scope,
    expires_at: unix,
    daily_limit: u128,
    gas_key: z.boolean(),
  }),
  session_revoked: z.object({ public_key: z.string().min(1) }),
  frozen: z.object({ frozen: z.boolean() }),
  session_action: z.object({ public_key: z.string().min(1), action: z.string().min(1), outflow: u128, spent_today: u128 }),
  hyperliquid_signed: z.object({ digest: z.string().min(1), kind: z.string().min(1) }),
  guard_rejected: z.object({ action: z.string(), reason: z.string() }),
  upgraded: z.object({ code_hash: z.string().min(1) }),
};

export const accountsFactory = {
  account_created: z.object({ account, owner_key: z.string().min(1), funded: z.string() }),
  account_creation_failed: z.object({ account }),
};

export const nep141 = {
  ft_mint: z.array(z.object({ owner_id: account, amount: u128, memo })),
  ft_burn: z.array(z.object({ owner_id: account, amount: u128, memo })),
  ft_transfer: z.array(z.object({ old_owner_id: account, new_owner_id: account, amount: u128, memo })),
};

/** Every event shape, by standard and event name. */
export const SCHEMAS: Record<string, Record<string, z.ZodType>> = {
  "tredio-registry": registry,
  "tredio-outcomes": outcomes,
  "tredio-book": book,
  "tredio-perps": perps,
  "tredio-coins": coins,
  "tredio-curation": curation,
  "tredio-account": userAccount,
  "tredio-accounts": accountsFactory,
  nep245,
  nep141,
};

/** Validates an event's data against its known shape; null for an unknown event or a bad shape. */
export function parseData<T = unknown>(e: Pick<NearEvent, "standard" | "event" | "data">): { ok: true; data: T } | { ok: false; reason: string } {
  const schema = SCHEMAS[e.standard]?.[e.event];
  if (!schema) return { ok: false, reason: "unknown event" };
  const r = schema.safeParse(e.data);
  if (!r.success) return { ok: false, reason: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  return { ok: true, data: r.data as T };
}

/** Token ids of the outcomes contract: `<series>:up` and `<series>:down`. */
export function parseTokenId(id: string): { series: number; side: "up" | "down" } | null {
  const m = /^(\d{1,15}):(up|down)$/.exec(id);
  return m ? { series: Number(m[1]), side: m[2] as "up" | "down" } : null;
}

/** NEAR amounts as the accounts factory logs them (`exact_amount_display`): "1.5 NEAR", "500 yoctoNEAR". */
export function parseNearAmount(text: string): string | null {
  const yocto = /^(\d+) yoctoNEAR$/.exec(text);
  if (yocto) return BigInt(yocto[1]!).toString();
  const near = /^(\d+)(?:\.(\d{1,24}))? NEAR$/.exec(text);
  if (!near) return null;
  return (BigInt(near[1]!) * 10n ** 24n + BigInt((near[2] ?? "").padEnd(24, "0") || "0")).toString();
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = `1${s}`;
  }
  return s;
}

/**
 * A passkey's public key as the account contract shows it (`owner_key()`: `p256:<base58>`). The
 * factory logs the key as the caller passed it, which may also be hex or bare base58.
 */
export function canonicalOwnerKey(key: string): string {
  if (key.startsWith("p256:")) return key;
  if (/^0[23][0-9a-fA-F]{64}$/.test(key)) return `p256:${base58(Uint8Array.from(Buffer.from(key, "hex")))}`;
  if (/^[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(key)) return `p256:${key}`;
  return key;
}
