/**
 * A small neardata-shaped block stream (heights 1000 to 1005) that touches every derived table:
 * a registry report with several events in one receipt, a failed receipt and an untracked
 * executor (both ignored), a skipped height (1001), account creation, complete sets, a book swap
 * and a limit-order fill, perps, trend coins, curation and USDC, then settlement, redemptions, a
 * failed payout, liquidation, graduation and a retirement. Alice's account also does what account
 * code v2 logs: a session renewed in place, a key that could not be added, a gas top-up, revoked
 * gas keys kept dormant, one deleted later, and a revoked session reactivated; the factory refunds
 * a failed creation.
 */
import type { Deployment } from "../../src/deployments";
import type { Block, ReceiptOutcome } from "../../src/neardata";

export const DEPLOYMENT: Deployment = {
  network: "testnet",
  root: "tredio.testnet",
  contracts: {
    usdc: "usdc.tredio.testnet",
    registry: "registry.tredio.testnet",
    outcomes: "outcomes.tredio.testnet",
    book: "book.tredio.testnet",
    perps: "perps.tredio.testnet",
    curation: "curation.tredio.testnet",
    coins: "coins.tredio.testnet",
    accounts: "accounts.tredio.testnet",
  },
  params: { curveGraduationReserve: "2000000000" },
};

const C = DEPLOYMENT.contracts;
export const ALICE = `0u${"a".repeat(52)}`;
/** A universal account of some other app: its events are never stored. */
export const STRANGER = `0u${"b".repeat(52)}`;
export const MM = "tredio-mm.testnet";
export const KEEPER = "tredio-keeper.testnet";
export const OPENAI_COIN = `topic-openai.${C.coins}`;
export const BTC_COIN = `crypto-btc.${C.coins}`;
export const SESSION_KEY = "ed25519:5Fq5mbXX2rZ5d8x2sbzWfMn5A3ZCBBvVHZ9ZhqJx8Yzk";
/** Account v2 keys: a second device's (revoked, kept, deleted later), Autopilot's (never added), a third (revoked and kept). */
export const KEY_2 = "ed25519:8Hn4tWbQZm3oZYVjGw5eT9p1XKd2CzRr6sLfAqUu7NvB";
export const KEY_3 = "ed25519:3Jr7yPcVhXo2Kq9SdUeWm4ZbN6tLgF1aRwCxTnHv5MiE";
export const KEY_4 = "ed25519:6Tq2wZxRb8KjNo5HyUcVe3PmL9dGs4FaWr7CtXnJh1Qk";
/** An account whose creation failed (its deposit is refunded). */
export const BOB = `0u${"c".repeat(52)}`;

/** Block times (unix seconds). Series 1 opens at 1002 and expires before 1004. */
export const T: Record<number, number> = { 1000: 1793902800, 1002: 1793902802, 1003: 1793902803, 1004: 1793903704, 1005: 1793903705 };
export const EXPIRY = T[1002]! + 900;

export function ev(standard: string, event: string, data: unknown): string {
  return `EVENT_JSON:${JSON.stringify({ standard, version: "1.0.0", event, data })}`;
}

const reg = (event: string, data: unknown) => ev("tredio-registry", event, data);
const out = (event: string, data: unknown) => ev("tredio-outcomes", event, data);
const mt = (event: string, data: unknown) => ev("nep245", event, data);
const book = (event: string, data: unknown) => ev("tredio-book", event, data);
const perp = (event: string, data: unknown) => ev("tredio-perps", event, data);
const coin = (event: string, data: unknown) => ev("tredio-coins", event, data);
const ft = (event: string, data: unknown) => ev("nep141", event, data);
const acct = (event: string, data: unknown) => ev("tredio-account", event, data);

let receiptSeq = 0;
function receipt(executor: string, logs: string[], status: unknown = { SuccessValue: "" }): ReceiptOutcome {
  const id = `R${String(++receiptSeq).padStart(4, "0")}`;
  return {
    execution_outcome: {
      id,
      outcome: { executor_id: executor, logs, status },
    },
    receipt: { receipt_id: id, receiver_id: executor, predecessor_id: "tredio.testnet" },
    tx_hash: `TX${id}`,
  };
}

function block(height: number, shards: ReceiptOutcome[][]): Block {
  const t = T[height]!;
  return {
    block: { header: { height, timestamp: t * 1e9, timestamp_nanosec: `${t}000000000`, hash: `H${height}`, prev_height: height - 1 } },
    shards: shards.map((receipt_execution_outcomes, shard_id) => ({ shard_id, receipt_execution_outcomes })),
  };
}

const sets = (owner: string, amount: string) => [
  mt("mt_mint", [{ owner_id: owner, token_ids: ["1:up"], amounts: [amount] }]),
  mt("mt_mint", [{ owner_id: owner, token_ids: ["1:down"], amounts: [amount] }]),
  out("sets_minted", { series: 1, payer: owner, receiver: owner, amount }),
];

export function scenario(): Map<number, Block | null> {
  receiptSeq = 0;
  const blocks = new Map<number, Block | null>();

  blocks.set(
    1000,
    block(1000, [
      [
        receipt(C.registry, [
          "processing report 1",
          reg("trend_created", {
            id: "topic:openai",
            asset_class: "topic",
            surfacer: ALICE,
            index: 40_000_000,
            observed_at: T[1000],
            review_hash: "ab".repeat(32),
            asset: null,
          }),
          reg("status_changed", { id: "topic:openai", from: null, to: "active", at: T[1000] }),
          reg("trend_created", {
            id: "crypto:btc",
            asset_class: "crypto",
            surfacer: null,
            index: 60_000_000,
            observed_at: T[1000],
            review_hash: null,
            asset: "BTC",
          }),
          reg("status_changed", { id: "crypto:btc", from: null, to: "active", at: T[1000] }),
          reg("item_rejected", { id: "Bad Id", kind: "new_trend", reason: "bad_identifier" }),
          reg("mark_updated", { asset: "BTC", price: "6512345000000", at: T[1000] }),
          reg("asset_index_set", { asset: "BTC", asset_index: 0 }),
          reg("report_processed", { run_id: 1, observed_at: T[1000], created: 2, updated: 0, marks: 1, rejected: 1 }),
        ]),
        // A failed receipt: its logs never count.
        receipt(
          C.registry,
          [reg("trend_created", { id: "topic:failed", asset_class: "topic", surfacer: null, index: 1, observed_at: T[1000], review_hash: null, asset: null })],
          { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: stale run" } } } } },
        ),
      ],
      [receipt("someone.testnet", [ft("ft_mint", [{ owner_id: "someone.testnet", amount: "1" }])])],
    ]),
  );

  blocks.set(1001, null);

  blocks.set(
    1002,
    block(1002, [
      [
        receipt(C.outcomes, [
          out("series_opened", { series: 1, trend: "topic:openai", window: 900, number: 1, opened_at: T[1002], expiry: EXPIRY, opening_index: 40_000_000 }),
        ]),
        receipt(C.book, [
          book("market_listed", { series: 1, side: "up", trend: "topic:openai", expiry: EXPIRY }),
          book("market_listed", { series: 1, side: "down", trend: "topic:openai", expiry: EXPIRY }),
        ]),
        receipt(C.usdc, [ft("ft_mint", [{ owner_id: ALICE, amount: "1000000000", memo: "faucet" }])]),
        receipt(C.usdc, [ft("ft_mint", [{ owner_id: MM, amount: "50000000000", memo: "mint" }])]),
      ],
      [
        receipt(ALICE, [
          acct("owner_executed", { nonce: 1, actions: 1 }),
          acct("session_added", {
            public_key: SESSION_KEY,
            label: "This iPhone",
            scope: { outcomes: true, perps: true, hyperliquid: false },
            expires_at: T[1002]! + 7 * 86_400,
            daily_limit: "250000000",
            gas_key: true,
          }),
        ]),
        receipt(STRANGER, [ft("ft_transfer", [{ old_owner_id: STRANGER, new_owner_id: ALICE, amount: "5" }])]),
        receipt(C.accounts, [ev("tredio-accounts", "account_created", { account: ALICE, owner_key: "p256:23xYz", funded: "0.05 NEAR" })]),
      ],
    ]),
  );

  blocks.set(
    1003,
    block(1003, [
      [
        receipt(C.usdc, [ft("ft_transfer", [{ old_owner_id: ALICE, new_owner_id: C.outcomes, amount: "10000000" }])]),
        receipt(C.outcomes, sets(ALICE, "10000000")),
        receipt(C.outcomes, sets(MM, "5000000")),
        // The market maker deposits 3 UP and rests a sell at 0.52.
        receipt(C.outcomes, [mt("mt_transfer", [{ old_owner_id: MM, new_owner_id: C.book, token_ids: ["1:up"], amounts: ["3000000"] }])]),
        receipt(C.book, [
          book("deposit", { account: MM, asset: { token: { series: 1, side: "up" } }, amount: "3000000" }),
          book("order_placed", { id: 1, owner: MM, series: 1, side: "up", dir: "sell", tick: 520, size: "3000000" }),
        ]),
        receipt(C.book, [
          book("deposit", { account: MM, asset: "usdc", amount: "1200000" }),
          book("order_placed", { id: 2, owner: MM, series: 1, side: "down", dir: "buy", tick: 400, size: "3000000" }),
        ]),
        // Alice's session buys 2 UP with an anchored swap: the trade and the swap share a receipt.
        receipt(ALICE, [acct("session_action", { public_key: SESSION_KEY, action: "swap", outflow: "1042080", spent_today: "1042080" })]),
        receipt(C.book, [
          book("trade", {
            series: 1,
            side: "up",
            maker_order: 1,
            maker: MM,
            taker: ALICE,
            taker_dir: "buy",
            tick: 520,
            size: "2000000",
            usdc: "1040000",
            fee: "2080",
          }),
          book("swap", {
            account: ALICE,
            series: 1,
            side: "up",
            dir: "buy",
            anchored: true,
            fair: "500000",
            amount_in: "1042080",
            amount_out: "2000000",
          }),
        ]),
        receipt(C.outcomes, [mt("mt_transfer", [{ old_owner_id: C.book, new_owner_id: ALICE, token_ids: ["1:up"], amounts: ["2000000"] }])]),
        // Alice deposits 3 DOWN and sells them into the market maker's bid (a plain fill).
        receipt(C.outcomes, [mt("mt_transfer", [{ old_owner_id: ALICE, new_owner_id: C.book, token_ids: ["1:down"], amounts: ["3000000"] }])]),
        receipt(C.book, [
          book("deposit", { account: ALICE, asset: { token: { series: 1, side: "down" } }, amount: "3000000" }),
          book("trade", {
            series: 1,
            side: "down",
            maker_order: 2,
            maker: MM,
            taker: ALICE,
            taker_dir: "sell",
            tick: 400,
            size: "3000000",
            usdc: "1200000",
            fee: "2400",
          }),
        ]),
      ],
      [
        receipt(C.perps, [
          perp("poked", { trend: "topic:openai", mark: 40_000_000, cum_long: "0", cum_short: "0", at: T[1003] }),
          perp("position_opened", {
            id: 1,
            owner: ALICE,
            trend: "topic:openai",
            is_long: true,
            qty: "747756729810568295",
            margin: "9970089",
            entry_index: 40_000_000,
            fee: "29911",
            payer: ALICE,
          }),
        ]),
        receipt(C.perps, [
          perp("position_opened", {
            id: 2,
            owner: MM,
            trend: "topic:openai",
            is_long: false,
            qty: "500000000000000000",
            margin: "2000000",
            entry_index: 40_000_000,
            fee: "6000",
            payer: MM,
          }),
        ]),
        receipt(C.perps, [
          perp("position_opened", {
            id: 3,
            owner: ALICE,
            trend: "crypto:btc",
            is_long: true,
            qty: "100000000000000000",
            margin: "5000000",
            entry_index: 60_000_000,
            fee: "15000",
            payer: ALICE,
          }),
          perp("margin_added", { id: 3, payer: ALICE, amount: "1000000" }),
        ]),
        receipt(C.coins, [coin("curve_created", { trend: "topic:openai", coin: OPENAI_COIN, virtual_quote: "2000000000", peak_at_creation: 40_000_000 })]),
        receipt(C.coins, [coin("curve_created", { trend: "crypto:btc", coin: BTC_COIN, virtual_quote: "2000000000", peak_at_creation: 60_000_000 })]),
        receipt(C.coins, [
          coin("trade", {
            trend: "topic:openai",
            trader: ALICE,
            is_buy: true,
            usdc: "1000000",
            coins: "494752041000000000000000",
            fee: "10000",
            reserve: "990000",
            sold: "494752041000000000000000",
            spot: "2000990489000000000",
          }),
        ]),
        receipt(OPENAI_COIN, [ft("ft_mint", [{ owner_id: ALICE, amount: "494752041000000000000000" }])]),
        receipt(C.usdc, [ft("ft_transfer", [{ old_owner_id: C.coins, new_owner_id: C.curation, amount: "1000" }])]),
        receipt(C.curation, [ev("tredio-curation", "accrued", { trend: "topic:openai", surfacer: ALICE, source: C.coins, amount: "1000" })]),
        // Account v2: the session renews in place (same key, a later expiry) and three keys are added.
        receipt(ALICE, [
          acct("owner_executed", { nonce: 2, actions: 4 }),
          acct("session_added", {
            public_key: SESSION_KEY,
            label: "This iPhone",
            scope: { outcomes: true, perps: true, hyperliquid: false },
            expires_at: T[1003]! + 7 * 86_400,
            daily_limit: "250000000",
            gas_key: true,
          }),
          acct("session_added", { public_key: KEY_2, label: "app", scope: { outcomes: true, perps: true, hyperliquid: true }, expires_at: T[1003]! + 86_400, daily_limit: "500000000", gas_key: true }),
          acct("session_added", { public_key: KEY_3, label: "autopilot", scope: { outcomes: false, perps: false, hyperliquid: true }, expires_at: T[1003]! + 86_400, daily_limit: "100000000", gas_key: true }),
          acct("session_added", { public_key: KEY_4, label: "app", scope: { outcomes: true, perps: false, hyperliquid: false }, expires_at: T[1003]! + 86_400, daily_limit: "50000000", gas_key: true }),
        ]),
        // KEY_3's key batch failed, so the account dropped its session.
        receipt(ALICE, [acct("session_key_failed", { public_key: KEY_3 })]),
        // The session moves 0.1 NEAR from the account into its own gas key.
        receipt(ALICE, [
          acct("session_action", { public_key: SESSION_KEY, action: "top_up_gas", outflow: "0", spent_today: "1042080" }),
          acct("gas_topped_up", { public_key: SESSION_KEY, amount: "100000000000000000000000", today: "100000000000000000000000" }),
        ]),
      ],
    ]),
  );

  blocks.set(
    1004,
    block(1004, [
      [
        receipt(C.registry, [
          reg("index_updated", { id: "topic:openai", index: 45_000_000, peak_index: 45_000_000, observed_at: T[1004], clamped: false }),
          reg("settlement_finalized", { id: "topic:openai", expiry: EXPIRY, value: 45_000_000 }),
          reg("index_clamped", { id: "crypto:btc", proposed: 10_000_000, applied: 30_000_000 }),
          reg("index_updated", { id: "crypto:btc", index: 30_000_000, peak_index: 60_000_000, observed_at: T[1004], clamped: true }),
          reg("report_processed", { run_id: 2, observed_at: T[1004], created: 0, updated: 2, marks: 0, rejected: 0 }),
        ]),
        receipt(C.outcomes, [out("series_settled", { series: 1, outcome: "up", opening_index: 40_000_000, settlement_index: 45_000_000 })]),
        receipt(C.outcomes, [
          mt("mt_burn", [{ owner_id: ALICE, token_ids: ["1:up"], amounts: ["12000000"] }]),
          mt("mt_burn", [{ owner_id: ALICE, token_ids: ["1:down"], amounts: ["7000000"] }]),
          out("winnings_redeemed", { series: 1, owner: ALICE, up: "12000000", down: "7000000", payout: "12000000" }),
        ]),
        receipt(C.outcomes, [
          mt("mt_burn", [{ owner_id: MM, token_ids: ["1:up"], amounts: ["1000000"] }]),
          mt("mt_burn", [{ owner_id: MM, token_ids: ["1:down"], amounts: ["1000000"] }]),
          out("sets_redeemed", { series: 1, owner: MM, amount: "1000000" }),
        ]),
        // The redemption's USDC transfer failed: the tokens come back.
        receipt(C.outcomes, [
          mt("mt_mint", [{ owner_id: MM, token_ids: ["1:up"], amounts: ["1000000"] }]),
          mt("mt_mint", [{ owner_id: MM, token_ids: ["1:down"], amounts: ["1000000"] }]),
          out("payout_failed", { series: 1, owner: MM, amount: "1000000" }),
        ]),
        receipt(C.book, [book("order_cancelled", { id: 1, owner: MM, remaining: "1000000" })]),
      ],
      [
        receipt(C.perps, [
          perp("poked", { trend: "topic:openai", mark: 45_000_000, cum_long: "1200000000000", cum_short: "-1200000000000", at: T[1004] }),
          perp("position_closed", {
            id: 1,
            owner: ALICE,
            trend: "topic:openai",
            is_long: true,
            entry_index: 40_000_000,
            exit_index: 45_000_000,
            qty: "747756729810568295",
            margin: "9970089",
            pnl: "3738783",
            funding: "1",
            fee: "33649",
            payout: "13675222",
            retired: false,
          }),
        ]),
        receipt(C.perps, [
          perp("socialized_loss", { id: 2, shortfall: "0" }),
          perp("position_liquidated", { id: 2, owner: MM, liquidator: KEEPER, exit_index: 45_000_000, equity: "-500000", reward: "0" }),
        ]),
        receipt(C.coins, [
          coin("trade", {
            trend: "topic:openai",
            trader: ALICE,
            is_buy: false,
            usdc: "490000",
            coins: "200000000000000000000000",
            fee: "4950",
            reserve: "495050",
            sold: "294752041000000000000000",
            spot: "2000495100000000000",
          }),
          coin("floor_raised", { trend: "topic:openai", virtual_quote: "2100000000", cost: "500", ratchet_bps: "10500" }),
        ]),
        receipt(OPENAI_COIN, [ft("ft_transfer", [{ old_owner_id: ALICE, new_owner_id: C.coins, amount: "200000000000000000000000" }])]),
        receipt(OPENAI_COIN, [ft("ft_burn", [{ owner_id: C.coins, amount: "200000000000000000000000", memo: "curve sell" }])]),
        receipt(ALICE, [
          acct("hyperliquid_signed", { digest: "cd".repeat(32), kind: "order" }),
          acct("session_revoked", { public_key: SESSION_KEY }),
          acct("session_key_kept", { public_key: SESSION_KEY }),
          acct("frozen", { frozen: true }),
          acct("upgraded", { code_hash: "J1GvtY5xj7QuNwmdDFM56EYxmTvwp1wHqkPZjY7CNK9x" }),
        ]),
        receipt(ALICE, [
          acct("owner_executed", { nonce: 3, actions: 2 }),
          acct("session_revoked", { public_key: KEY_2 }),
          acct("session_key_kept", { public_key: KEY_2 }),
          acct("session_revoked", { public_key: KEY_4 }),
          acct("session_key_kept", { public_key: KEY_4 }),
        ]),
        receipt(C.curation, [ev("tredio-curation", "claimed", { account: ALICE, amount: "1000" })]),
        receipt(C.usdc, [
          ft("ft_transfer", [
            { old_owner_id: C.curation, new_owner_id: ALICE, amount: "1000" },
            { old_owner_id: C.outcomes, new_owner_id: ALICE, amount: "12000000", memo: "winnings" },
          ]),
        ]),
      ],
    ]),
  );

  blocks.set(
    1005,
    block(1005, [
      [
        receipt(C.registry, [
          reg("status_changed", { id: "crypto:btc", from: "active", to: "retired", at: T[1005] }),
          reg("settlement_missed", { id: "crypto:btc", expiry: T[1003]! + 900, first_observation: T[1005] }),
        ]),
        // The revoked session comes back with its kept key; KEY_2's dormant key is deleted for good.
        receipt(ALICE, [
          acct("owner_executed", { nonce: 4, actions: 2 }),
          acct("session_added", {
            public_key: SESSION_KEY,
            label: "This iPhone",
            scope: { outcomes: true, perps: true, hyperliquid: false },
            expires_at: T[1005]! + 7 * 86_400,
            daily_limit: "250000000",
            gas_key: true,
          }),
          acct("session_key_deleted", { public_key: KEY_2 }),
        ]),
        receipt(C.accounts, [
          ev("tredio-accounts", "account_creation_failed", { account: BOB }),
          ev("tredio-accounts", "deposit_refunded", { account: BOB, payer: "tredio-relayer.testnet", amount: "400000000000000000000000", claimable: false }),
        ]),
        receipt(C.coins, [coin("graduation_ready", { trend: "crypto:btc", reserve: "2000100000" })]),
        receipt(C.coins, [coin("graduation_step", { trend: "crypto:btc", step: "pool", ok: true })]),
        receipt(C.coins, [coin("graduation_step", { trend: "crypto:btc", step: "mint", ok: true })]),
        receipt(C.coins, [coin("graduated", { trend: "crypto:btc", exchange: "ref-finance-101.testnet", pool_id: 7, coins: "1000", usdc: "2000" })]),
        receipt(C.perps, [
          perp("poked", { trend: "crypto:btc", mark: 30_000_000, cum_long: "0", cum_short: "0", at: T[1005] }),
          perp("position_closed", {
            id: 3,
            owner: ALICE,
            trend: "crypto:btc",
            is_long: true,
            entry_index: 60_000_000,
            exit_index: 30_000_000,
            qty: "100000000000000000",
            margin: "6000000",
            pnl: "-3000000",
            funding: "0",
            fee: "0",
            payout: "3000000",
            retired: true,
          }),
        ]),
      ],
    ]),
  );
  return blocks;
}

export const HEIGHTS = [1000, 1001, 1002, 1003, 1004, 1005];
