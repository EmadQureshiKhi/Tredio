import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { concat, domainSeparator, keccakText, typedDataDigest, word } from "./eip712";
import type { HlNetwork } from "./info";

// #mainnet: this file branches on the network (testnet or mainnet); MAINNET.md lists what changes.

/**
 * USDC out of a Hyperliquid account: `withdraw3` (through Hyperliquid's bridge to an address on
 * Arbitrum) and `usdSend` (to another Hyperliquid address's perps balance). These are
 * "user-signed" actions: unlike L1 actions (actions.ts) they are signed as plain EIP-712 typed data,
 * so a Tredio account signs one with an `mpc_sign` owner request over `userSignedDigest(action)`
 * (the passkey approves it, the account's Chain Signatures key signs) and the very same action
 * then goes to /exchange with `action.time` as the request's nonce.
 *
 * Checked against Hyperliquid's Python SDK (hyperliquid-python-sdk, hyperliquid/utils/signing.py:
 * `sign_withdraw_from_bridge_action`, `sign_usd_transfer_action`, `sign_user_signed_action`,
 * `user_signed_payload`; vectors from tests/signing_test.py) and the exchange endpoint docs
 * (hyperliquid-docs, for-developers/api/exchange-endpoint, "Initiate a withdrawal request" and
 * "Core USDC transfer"):
 * - Domain `HyperliquidSignTransaction`, version `1`, chainId = signatureChainId, zero verifying contract.
 * - `HyperliquidTransaction:Withdraw` and `HyperliquidTransaction:UsdSend`, both
 *   (string hyperliquidChain, string destination, string amount, uint64 time).
 * - `hyperliquidChain` ("Mainnet" or "Testnet") is what binds an action to one network.
 *   `signatureChainId` only names the chain the signer signed for and may be any chain: the SDK
 *   always uses 0x66eee (Arbitrum Sepolia), the docs' example is 0xa4b1 (Arbitrum One).
 * - The destination is a 42-character 0x address, sent and signed in lowercase (as Hyperliquid's
 *   own SDK vectors are), so the string the exchange checks is exactly the one signed.
 */

export type HyperliquidChain = "Mainnet" | "Testnet";

export const HYPERLIQUID_CHAIN: Record<HlNetwork, HyperliquidChain> = { mainnet: "Mainnet", testnet: "Testnet" };
/** The chain id each network's transfers are signed for: Arbitrum One on mainnet, Arbitrum Sepolia on testnet. */
export const SIGNATURE_CHAIN_ID: Record<HlNetwork, string> = { mainnet: "0xa4b1", testnet: "0x66eee" };
/** Hyperliquid's bridge keeps 1 USDC of every withdrawal to Arbitrum (exchange endpoint docs); a `usdSend` has no fee. */
export const WITHDRAW_FEE = 1_000_000n;

interface Transfer {
  hyperliquidChain: HyperliquidChain;
  signatureChainId: string;
  /** Lowercase 0x address. */
  destination: string;
  /** USD as a decimal string without trailing zeros ("12.5"). */
  amount: string;
  /** Milliseconds; also the request's nonce. */
  time: number;
}

export interface WithdrawAction extends Transfer {
  type: "withdraw3";
}

export interface UsdSendAction extends Transfer {
  type: "usdSend";
}

export type UserSignedAction = WithdrawAction | UsdSendAction;

const PRIMARY_TYPE: Record<UserSignedAction["type"], string> = { withdraw3: "HyperliquidTransaction:Withdraw", usdSend: "HyperliquidTransaction:UsdSend" };
const FIELDS = "(string hyperliquidChain,string destination,string amount,uint64 time)";
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const isEvmAddress = (s: string): boolean => EVM_ADDRESS.test(s.trim());

/** Raw USDC (6 decimals) as the decimal string Hyperliquid takes: 12_500_000n is "12.5". */
export function usdAmount(raw: bigint): string {
  if (raw <= 0n) throw new Error("amount must be positive");
  const whole = raw / 1_000_000n;
  const fraction = (raw % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function transfer(network: HlNetwork, destination: string, amount: bigint, time: number): Transfer {
  const to = destination.trim();
  if (!EVM_ADDRESS.test(to)) throw new Error("the destination must be a 0x address");
  if (!Number.isSafeInteger(time) || time <= 0) throw new Error("time must be a timestamp in milliseconds");
  return { hyperliquidChain: HYPERLIQUID_CHAIN[network], signatureChainId: SIGNATURE_CHAIN_ID[network], destination: to.toLowerCase(), amount: usdAmount(amount), time };
}

/** Withdraws `amount` raw USDC from the perps balance to `destination` on Arbitrum (Arbitrum Sepolia on testnet). */
export function withdrawAction(network: HlNetwork, destination: string, amount: bigint, time = Date.now()): WithdrawAction {
  return { type: "withdraw3", ...transfer(network, destination, amount, time) };
}

/** Sends `amount` raw USDC from the perps balance to another Hyperliquid address's perps balance. */
export function usdSendAction(network: HlNetwork, destination: string, amount: bigint, time = Date.now()): UsdSendAction {
  return { type: "usdSend", ...transfer(network, destination, amount, time) };
}

/** The 32-byte EIP-712 digest the account's Chain Signatures key signs for `action`. */
export function userSignedDigest(action: UserSignedAction): Uint8Array {
  const chainId = Number.parseInt(action.signatureChainId, 16);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("bad signatureChainId");
  const structHash = keccak_256(
    concat(keccakText(`${PRIMARY_TYPE[action.type]}${FIELDS}`), keccakText(action.hyperliquidChain), keccakText(action.destination), keccakText(action.amount), word(action.time)),
  );
  return typedDataDigest(domainSeparator("HyperliquidSignTransaction", "1", chainId), structHash);
}

/** The digest as the hex (no 0x) an `mpc_sign` owner action takes as its payload. */
export const userSignedDigestHex = (action: UserSignedAction): string => bytesToHex(userSignedDigest(action));
