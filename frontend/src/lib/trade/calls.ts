import { type Call, calls, type HlOrder, type OrderSpec, type OwnerAction, type Scope, type SessionAction, type Side } from "@tredio/contracts";
import { base64Encode, utf8 } from "@/lib/chain/encoding";
import { DEPLOYMENT } from "@/lib/config";

/**
 * What the app asks the chain to do, as data:
 * - session actions: what the trading session sends to `session_call` (typed, scoped, capped);
 * - owner actions: what the passkey signs for the account (`owner_execute` through the relayer),
 *   including `call` actions for what sessions may not do;
 * - call descriptors: what a NEAR wallet sends itself.
 */

export const C = calls(DEPLOYMENT);
const c = DEPLOYMENT.contracts;
const s = (v: bigint | number) => v.toString();

export const TGAS = 10n ** 12n;

export const session = {
  /** Anchored Up/Down swap: `amount` is USDC in for a buy, tokens in for a sell. */
  swap: (series: number, side: Side, buy: boolean, amount: bigint, minOut: bigint): SessionAction => ({ swap: { series, side, buy, amount: s(amount), min_out: s(minOut) } }),
  mintSets: (series: number, amount: bigint): SessionAction => ({ mint_sets: { series, amount: s(amount) } }),
  redeemSets: (series: number, amount: bigint): SessionAction => ({ redeem_sets: { series, amount: s(amount) } }),
  redeemWinnings: (series: number, up: bigint, down: bigint): SessionAction => ({ redeem_winnings: { series, up: s(up), down: s(down) } }),
  /** Moves a balance held in the book (from limit orders) back to the account. */
  bookWithdraw: (asset: "usdc" | { token: { series: number; side: Side } }, amount: bigint): SessionAction => ({ book_withdraw: { asset, amount: s(amount) } }),
  perpOpen: (trend: string, isLong: boolean, margin: bigint, leverageBps: number, acceptableIndex: number): SessionAction => ({ perp_open: { trend, is_long: isLong, margin: s(margin), leverage_bps: leverageBps, acceptable_index: acceptableIndex } }),
  perpClose: (id: number, acceptableIndex: number): SessionAction => ({ perp_close: { id, acceptable_index: acceptableIndex } }),
  claimCuration: "claim_curation" as SessionAction,
  faucet: "faucet" as SessionAction,
  hlOrder: (order: HlOrder, nonce: number): SessionAction => ({ hl_order: { order, nonce } }),
  hlLeverage: (assetIndex: number, isCross: boolean, leverage: number, nonce: number): SessionAction => ({ hl_leverage: { asset_index: assetIndex, is_cross: isCross, leverage, nonce } }),
};

/** A contract call made by the account itself, approved by the passkey. */
export const ownerCall = (call: Call): OwnerAction => ({
  call: { receiver_id: call.receiverId, method_name: call.methodName, args: base64Encode(utf8(JSON.stringify(call.args))), deposit: call.deposit, gas: call.gas },
});

/** NEAR the account keeps with the book for its balances and orders (each entry about 0.0026 NEAR). */
export const BOOK_STORAGE = 20_000_000_000_000_000_000_000n;
export const OUTCOMES_STORAGE = 20_000_000_000_000_000_000_000n;
export const PERPS_STORAGE = 10_000_000_000_000_000_000_000n;
export const USDC_STORAGE = 1_250_000_000_000_000_000_000n;

const storageDeposit = (contract: string, account: string, deposit: bigint, registrationOnly = false): Call => ({
  receiverId: contract,
  methodName: "storage_deposit",
  args: { account_id: account, registration_only: registrationOnly },
  deposit: s(deposit),
  gas: s(30n * TGAS),
});

export const storage = {
  book: (account: string) => storageDeposit(c.book, account, BOOK_STORAGE),
  outcomes: (account: string) => storageDeposit(c.outcomes, account, OUTCOMES_STORAGE),
  perps: (account: string) => storageDeposit(c.perps, account, PERPS_STORAGE),
  usdc: (account: string) => storageDeposit(c.usdc, account, USDC_STORAGE, true),
};

/** Book fee on the USDC side of a fill (basis points), from the deployment. */
export const TAKER_FEE_BPS = BigInt(DEPLOYMENT.params.bookTakerFeeBps);

/** USDC (raw) a limit buy of `size` at `tick` may use, the taker fee included in case it crosses. */
export const limitBuyFunds = (size: bigint, tick: number) => {
  const cost = (size / 1000n) * BigInt(tick);
  return cost + (cost * TAKER_FEE_BPS + 9_999n) / 10_000n;
};

/** Calls the passkey makes: limit orders, coin trades, margin top-ups, withdrawals and session changes. */
export const owner = {
  /** A limit order: the funds move into the book and the order rests (or fills) against them. */
  limitOrder: (order: OrderSpec): Call =>
    order.dir === "buy"
      ? C.book.depositUsdc(s(limitBuyFunds(BigInt(order.size), order.tick)), JSON.stringify({ place: { order } }))
      : C.outcomes.toBook(order.series, order.side, order.size, JSON.stringify({ place: { order } })),
  cancelOrder: (id: number): Call => C.book.cancel(id),
  coinBuy: (trend: string, usdc: bigint, minOut: bigint): Call => C.coins.buy(trend, s(usdc), s(minOut)),
  coinSell: (coin: string, amount: bigint, minOut: bigint): Call => C.coins.sell(coin, s(amount), s(minOut)),
  createCurve: (trend: string): Call => C.coins.createCurve(trend),
  addMargin: (id: number, amount: bigint): Call => C.perps.addMargin(id, s(amount)),
  sendUsdc: (receiver: string, amount: bigint): Call => C.usdc.transfer(receiver, s(amount)),
};

export const ownerActions = {
  addSession: (a: { publicKey: string; label: string; scope: Scope; expiresAt: number; dailyLimit: bigint; gasFunding: bigint }): OwnerAction => ({
    add_session: { public_key: a.publicKey, label: a.label, scope: a.scope, expires_at: a.expiresAt, daily_limit: s(a.dailyLimit), gas_key: true, gas_funding: s(a.gasFunding) },
  }),
  revokeSession: (publicKey: string): OwnerAction => ({ revoke_session: { public_key: publicKey } }),
  freeze: (frozen: boolean): OwnerAction => ({ freeze: { frozen } }),
  transferNear: (receiver: string, yocto: bigint): OwnerAction => ({ transfer: { receiver_id: receiver, amount: s(yocto) } }),
};

/** What a NEAR wallet sends to do what a session action does (wallets have no session). */
export function walletCalls(action: SessionAction): Call[] {
  if (action === "faucet") return [C.usdc.faucet()];
  if (action === "claim_curation") return [C.curation.claim()];
  if ("swap" in action) {
    const a = action.swap;
    const msg = JSON.stringify({ swap: { series: a.series, side: a.side, limit_tick: null, min_out: a.min_out, anchored: true } });
    return [a.buy ? C.book.depositUsdc(a.amount, msg) : C.outcomes.toBook(a.series, a.side, a.amount, msg)];
  }
  if ("mint_sets" in action) return [C.outcomes.mint(action.mint_sets.series, action.mint_sets.amount)];
  if ("redeem_sets" in action) return [C.outcomes.redeemSets(action.redeem_sets.series, action.redeem_sets.amount)];
  if ("redeem_winnings" in action) return [C.outcomes.redeemWinnings(action.redeem_winnings.series, action.redeem_winnings.up, action.redeem_winnings.down)];
  if ("book_withdraw" in action) return [C.book.withdraw(action.book_withdraw.asset, action.book_withdraw.amount)];
  if ("perp_open" in action) {
    const p = action.perp_open;
    return [C.perps.open(p.trend, p.is_long, p.margin, p.leverage_bps, p.acceptable_index)];
  }
  if ("perp_close" in action) return [C.perps.close(action.perp_close.id, action.perp_close.acceptable_index)];
  throw new Error("Hyperliquid trades run through a passkey account's Chain Signatures key; a NEAR wallet cannot place them here.");
}

