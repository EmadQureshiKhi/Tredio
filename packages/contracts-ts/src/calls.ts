/**
 * Call descriptors for every state-changing method the services and app use. A descriptor is
 * plain data, so any signer (near-kit, a wallet, the relayer) can send it.
 */
import type { Deployment } from "./deployments";
import type { OrderSpec, OwnerRequest, PasskeyProof, Report, SessionAction, Side, U128 } from "./types";

export interface Call {
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  /** yoctoNEAR as a decimal string. */
  deposit: string;
  /** Gas in units (1 Tgas = 1e12). */
  gas: string;
}

const TGAS = 10n ** 12n;
const gas = (t: number) => (BigInt(t) * TGAS).toString();
const ONE_YOCTO = "1";
const ZERO = "0";

/**
 * Gas a `session_call` attaches. Account v1 gives token calls 200 Tgas of static gas, so it needs
 * 300; account v2 gives them a small static amount plus all unused gas, so 150 is enough (it
 * refuses token calls under 120). A gas key reserves 0.001 NEAR per Tgas attached while the call
 * is in flight, so v2 halves the float a session needs.
 */
export const SESSION_CALL_TGAS_V1 = 300;
export const SESSION_CALL_TGAS_V2 = 150;
export const SESSION_CALL_MIN_TGAS_V2 = 120;
/** Account v2's daily cap on `top_up_gas`, per session (yoctoNEAR). */
export const GAS_TOP_UP_DAILY = (5n * 10n ** 23n).toString();
/** The account code version `version` reports; v1 has no such view. */
export const ACCOUNT_VERSION = 2;

const call = (receiverId: string, methodName: string, args: Record<string, unknown>, deposit = ZERO, tgas = 100): Call => ({
  receiverId,
  methodName,
  args,
  deposit,
  gas: gas(tgas),
});

export function calls(d: Deployment) {
  const c = d.contracts;
  return {
    registry: {
      submitReport: (reportJson: string, signatureB64: string) =>
        call(c.registry, "submit_report", { report_json: reportJson, signature: signatureB64 }, ZERO, 300),
      pokeLifecycle: (id: string) => call(c.registry, "poke_lifecycle", { id }, ZERO, 30),
    },
    outcomes: {
      openSeries: (trend: string, window: number) => call(c.outcomes, "open_series", { trend, window }, ZERO, 100),
      settle: (series: number) => call(c.outcomes, "settle", { series }, ZERO, 100),
      redeemSets: (series: number, amount: U128) => call(c.outcomes, "redeem_sets", { series, amount }, ZERO, 60),
      redeemWinnings: (series: number, up: U128, down: U128) => call(c.outcomes, "redeem_winnings", { series, up, down }, ZERO, 60),
      /** Mint complete sets by sending USDC. */
      mint: (series: number, amount: U128, receiver: string | null = null) =>
        call(c.usdc, "ft_transfer_call", { receiver_id: c.outcomes, amount, msg: JSON.stringify({ mint: { series, receiver } }) }, ONE_YOCTO, 150),
      /** Move tokens into the book as a trading balance (or with a placement or swap message). */
      toBook: (series: number, side: Side, amount: U128, msg = "") =>
        call(c.outcomes, "mt_transfer_call", { receiver_id: c.book, token_id: `${series}:${side}`, amount, msg }, ONE_YOCTO, 200),
    },
    book: {
      listSeries: (series: number) => call(c.book, "list_series", { series }, ZERO, 60),
      place: (order: OrderSpec) => call(c.book, "place_order", { order }, ZERO, 200),
      batchUpdate: (cancels: number[], places: OrderSpec[]) => call(c.book, "batch_update", { cancels, places }, ZERO, 300),
      cancel: (orderId: number) => call(c.book, "cancel_order", { order_id: orderId }, ZERO, 60),
      cancelExpired: (series: number, side: Side, max = 30) => call(c.book, "cancel_expired", { series, side, max }, ZERO, 300),
      withdraw: (asset: unknown, amount: U128) => call(c.book, "withdraw", { asset, amount }, ZERO, 60),
      depositUsdc: (amount: U128, msg = "") =>
        call(c.usdc, "ft_transfer_call", { receiver_id: c.book, amount, msg }, ONE_YOCTO, 200),
      sweepFees: () => call(c.book, "sweep_fees", {}, ZERO, 30),
    },
    perps: {
      open: (trend: string, isLong: boolean, margin: U128, leverageBps: number, acceptableIndex: number, owner: string | null = null) =>
        call(
          c.usdc,
          "ft_transfer_call",
          {
            receiver_id: c.perps,
            amount: margin,
            msg: JSON.stringify({ open: { trend, is_long: isLong, leverage_bps: leverageBps, acceptable_index: acceptableIndex, deadline: null, owner } }),
          },
          ONE_YOCTO,
          200,
        ),
      addMargin: (id: number, amount: U128) =>
        call(c.usdc, "ft_transfer_call", { receiver_id: c.perps, amount, msg: JSON.stringify({ add_margin: { id } }) }, ONE_YOCTO, 100),
      depositPool: (amount: U128) =>
        call(c.usdc, "ft_transfer_call", { receiver_id: c.perps, amount, msg: JSON.stringify("deposit_pool") }, ONE_YOCTO, 100),
      close: (id: number, acceptableIndex: number) => call(c.perps, "close", { id, acceptable_index: acceptableIndex }, ZERO, 200),
      liquidate: (id: number) => call(c.perps, "liquidate", { id }, ZERO, 200),
      settleRetired: (id: number) => call(c.perps, "settle_retired", { id }, ZERO, 200),
      // poke reads the registry (10 Tgas) and settles in a callback that reserves 60 Tgas, so it needs well over 70.
      poke: (trend: string) => call(c.perps, "poke", { trend }, ZERO, 120),
      sweepProtocolFees: () => call(c.perps, "sweep_protocol_fees", {}, ZERO, 60),
    },
    coins: {
      createCurve: (trend: string) => call(c.coins, "create_curve", { trend }, ZERO, 200),
      buy: (trend: string, usdc: U128, minOut: U128, receiver: string | null = null) =>
        call(c.usdc, "ft_transfer_call", { receiver_id: c.coins, amount: usdc, msg: JSON.stringify({ buy: { trend, min_out: minOut, receiver } }) }, ONE_YOCTO, 250),
      sell: (coin: string, amount: U128, minOut: U128) =>
        call(coin, "ft_transfer_call", { receiver_id: c.coins, amount, msg: JSON.stringify({ sell: { min_out: minOut, receiver: null } }) }, ONE_YOCTO, 200),
      syncFloor: (trend: string) => call(c.coins, "sync_floor", { trend }, ZERO, 100),
      graduate: (trend: string) => call(c.coins, "graduate", { trend }, ZERO, 300),
    },
    curation: {
      claim: () => call(c.curation, "claim", {}, ZERO, 60),
    },
    usdc: {
      faucet: () => call(c.usdc, "faucet", {}, ZERO, 30),
      mint: (accountId: string, amount: U128) => call(c.usdc, "mint", { account_id: accountId, amount }, ZERO, 30),
      /** A USDC transfer; the memo lands in the NEP-141 event, where paid signals read their commitments and purchases. */
      transfer: (receiverId: string, amount: U128, memo?: string) => call(c.usdc, "ft_transfer", memo === undefined ? { receiver_id: receiverId, amount } : { receiver_id: receiverId, amount, memo }, ONE_YOCTO, 30),
      storageDeposit: (accountId: string) =>
        call(c.usdc, "storage_deposit", { account_id: accountId, registration_only: true }, "1250000000000000000000", 30),
    },
    accounts: {
      /**
       * Creates (or tops up) a passkey's universal account; attach the funding as `deposit`. If
       * the creation fails the factory sends the deposit back (or, when it cannot yet, keeps it
       * for `claimRefund`). Accounts are born on the factory's fixed code; include an `upgrade`
       * to the latest code in the first request.
       */
      create: (ownerKey: string, deposit: string, first?: { request: string; proof: PasskeyProof }) =>
        call(c.accounts, "create_account", { owner_key: ownerKey, first_request: first?.request ?? null, first_proof: first?.proof ?? null }, deposit, 300),
      /** Sends the caller deposits of failed creations the factory could not refund at once. */
      claimRefund: () => call(c.accounts, "claim_refund", {}, ZERO, 30),
    },
    account: {
      ownerExecute: (account: string, request: string, proof: PasskeyProof) =>
        call(account, "owner_execute", { request, proof }, ZERO, 300),
      /** Pass `sessionCallTgas(version)` (account-version.ts); the default (v1's 300) suits v1 and v2. */
      sessionCall: (account: string, action: SessionAction, tgas = SESSION_CALL_TGAS_V1) => call(account, "session_call", { action }, ZERO, tgas),
    },
  };
}

export type Calls = ReturnType<typeof calls>;
export type { OwnerRequest, Report };
