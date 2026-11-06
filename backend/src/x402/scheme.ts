import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58Encode, NEAR_CAIP2, type PaymentPayload, type PaymentRequirements, timeoutBlocks, X402_VERSION } from "@tredio/chain";
import { DELEGATE_ACTION_PREFIX, decodeSignedDelegateAction, encodeSignedDelegateAction } from "near-kit";

/**
 * Verification of x402's NEAR `exact` scheme (x402-foundation/x402,
 * `specs/schemes/exact/scheme_exact_near.md`, sections 1 to 9), with the reason codes of the
 * reference implementation (`@x402/near`). Every chain read goes through one `NearSnapshot`, pinned
 * to a final block, and any read that fails makes the payment invalid (fail closed).
 *
 * Keys: ed25519 and secp256k1 are verified; ML-DSA-65 keys (NEAR 2.13) are refused with
 * `invalid_exact_near_unsupported_key_type`, as the spec allows when it is documented.
 */

/** The NEP-366 nonce bound: a delegate nonce must stay under the final height times this. */
export const NONCE_RANGE_MULTIPLIER = 1_000_000n;
/** `view_account` code hash of an account without a contract. */
export const EMPTY_CODE_HASH = "11111111111111111111111111111111";
/** The most gas a payment may ask the relayer to prepay (the reference default, 100 Tgas). */
export const MAX_SPONSORED_GAS = 100n * 10n ** 12n;

export type AccessKeyKind = "FullAccess" | "FunctionCall" | "Unknown";

/** The chain reads the checks need, all at one final block (no read sees a different state). */
export interface NearSnapshot {
  height: bigint;
  /** Null when the key does not exist on the account. */
  accessKey(accountId: string, publicKey: string): Promise<{ nonce: bigint; kind: AccessKeyKind } | null>;
  /** Null when the account does not exist. */
  account(accountId: string): Promise<{ codeHash: string } | null>;
  ftBalance(token: string, accountId: string): Promise<bigint>;
  /** NEP-145: `supported` false when the token has no storage management. */
  storageBalance(token: string, accountId: string): Promise<{ supported: boolean; registered: boolean }>;
}

export interface NearState {
  /** Reads pinned to the newest final block. */
  final(): Promise<NearSnapshot>;
}

export interface DecodedDelegate {
  senderId: string;
  receiverId: string;
  publicKey: string;
  curve: "ed25519" | "secp256k1" | "ml-dsa-65";
  nonce: bigint;
  maxBlockHeight: bigint;
  actionCount: number;
  /** The single action when it is a function call, else null. */
  functionCall: { methodName: string; args: Uint8Array; gas: bigint; deposit: bigint } | null;
  /** SHA-256 (hex) of the exact payload bytes: one payment, one key. */
  payloadHash: string;
  /** NEP-366 signature check over the exact signed bytes. */
  verifySignature(): boolean;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const SIGNATURE_BYTES = { ed25519: 64, secp256k1: 65, "ml-dsa-65": 3309 } as const;

/**
 * Decodes a base64 Borsh `SignedDelegate`. The bytes must be canonical (re-encoding the decoded
 * value gives them back), so what is checked is exactly what the relayer will submit.
 */
export function decodeSignedDelegate(b64: string): DecodedDelegate {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error("not base64");
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  const decoded = decodeSignedDelegateAction(bytes);
  if (!Buffer.from(encodeSignedDelegateAction(decoded, "bytes")).equals(Buffer.from(bytes))) throw new Error("not a canonical SignedDelegate");
  const sd = decoded.signedDelegate;
  const da = sd.delegateAction;
  const pk = da.publicKey as { ed25519Key?: { data: number[] }; secp256k1Key?: { data: number[] }; mlDsa65Key?: { data: number[] } };
  const sig = sd.signature as { ed25519Signature?: { data: number[] }; secp256k1Signature?: { data: number[] }; mlDsa65Signature?: { data: number[] } };
  const [curve, keyData, prefix] = pk.ed25519Key
    ? (["ed25519", pk.ed25519Key.data, "ed25519"] as const)
    : pk.secp256k1Key
      ? (["secp256k1", pk.secp256k1Key.data, "secp256k1"] as const)
      : (["ml-dsa-65", pk.mlDsa65Key?.data ?? [], "mldsa65"] as const);
  const sigCurve = sig.ed25519Signature ? "ed25519" : sig.secp256k1Signature ? "secp256k1" : "ml-dsa-65";
  const sigData = new Uint8Array(sig.ed25519Signature?.data ?? sig.secp256k1Signature?.data ?? sig.mlDsa65Signature?.data ?? []);
  const key = new Uint8Array(keyData);
  const only = da.actions.length === 1 ? (da.actions[0] as { functionCall?: { methodName: string; args: Uint8Array; gas: bigint; deposit: bigint } }) : null;
  return {
    senderId: da.senderId,
    receiverId: da.receiverId,
    publicKey: `${prefix}:${base58Encode(key)}`,
    curve,
    nonce: BigInt(da.nonce),
    maxBlockHeight: BigInt(da.maxBlockHeight),
    actionCount: da.actions.length,
    functionCall: only?.functionCall
      ? { methodName: only.functionCall.methodName, args: new Uint8Array(only.functionCall.args), gas: BigInt(only.functionCall.gas), deposit: BigInt(only.functionCall.deposit) }
      : null,
    payloadHash: hex(sha256(bytes)),
    verifySignature(): boolean {
      if (sigCurve !== curve || curve === "ml-dsa-65") return false;
      // The SignedDelegate is the DelegateAction followed by the signature (a tag byte and its
      // bytes); NEP-366 signs SHA-256 of the u32 prefix 2^30 + 366 and the DelegateAction.
      const delegateBytes = bytes.subarray(0, bytes.length - 1 - SIGNATURE_BYTES[curve]);
      const message = new Uint8Array(4 + delegateBytes.length);
      new DataView(message.buffer).setUint32(0, DELEGATE_ACTION_PREFIX, true);
      message.set(delegateBytes, 4);
      const digest = sha256(message);
      try {
        if (curve === "ed25519") return sigData.length === 64 && ed25519.verify(sigData, digest, key);
        // secp256k1 on NEAR: r || s || v over the digest, checked by recovering the 64-byte key.
        if (sigData.length !== 65 || key.length !== 64 || sigData[64]! > 1) return false;
        const recovered = secp256k1.Signature.fromBytes(sigData.subarray(0, 64), "compact").addRecoveryBit(sigData[64]!).recoverPublicKey(digest).toBytes(false);
        return Buffer.from(recovered.subarray(1)).equals(Buffer.from(key));
      } catch {
        return false;
      }
    },
  };
}

export type Verification = { ok: true; payer: string; delegate: DecodedDelegate } | { ok: false; reason: string; payer?: string };

export interface VerifyPolicy {
  /** The facilitator's relayer accounts (never the payer). */
  relayers: readonly string[];
  maxGas?: bigint;
}

const bad = (reason: string, payer?: string): Verification => ({ ok: false, reason, ...(payer ? { payer } : {}) });

/** Runs a chain read; a failure becomes `reason` (fail closed). */
async function read<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await fn() };
  } catch {
    return { ok: false };
  }
}

/** Whether `payload` pays `required` exactly, checked against current final chain state. */
export async function verifyExact(payload: PaymentPayload, required: PaymentRequirements, state: NearState, policy: VerifyPolicy): Promise<Verification> {
  // 1. Version, scheme and network.
  if (payload.x402Version !== X402_VERSION) return bad("invalid_x402_version");
  if (payload.accepted?.scheme !== "exact" || required.scheme !== "exact") return bad("unsupported_scheme");
  if (required.network !== NEAR_CAIP2.testnet && required.network !== NEAR_CAIP2.mainnet) return bad("invalid_network");
  if (payload.accepted.network !== required.network) return bad("invalid_exact_near_network_mismatch");
  // 2. The accepted requirements are the ones asked.
  if (payload.accepted.asset !== required.asset) return bad("invalid_exact_near_asset_mismatch");
  if (payload.accepted.payTo !== required.payTo) return bad("invalid_exact_near_pay_to_mismatch");
  if (payload.accepted.amount !== required.amount) return bad("invalid_exact_near_amount_mismatch");
  if (!Number.isInteger(required.maxTimeoutSeconds) || required.maxTimeoutSeconds <= 0) return bad("invalid_exact_near_max_timeout");
  const b64 = (payload.payload as { signedDelegateAction?: unknown } | undefined)?.signedDelegateAction;
  if (typeof b64 !== "string") return bad("invalid_exact_near_payload_shape");
  // 4. A valid SignedDelegate whose signature verifies before anyone is named the payer.
  let d: DecodedDelegate;
  try {
    d = decodeSignedDelegate(b64);
  } catch {
    return bad("invalid_exact_near_payload_signed_delegate_action");
  }
  if (d.curve === "ml-dsa-65") return bad("invalid_exact_near_unsupported_key_type");
  if (!d.verifySignature()) return bad("invalid_exact_near_payload_signature");
  const payer = d.senderId;
  // 3. The relayer comes from local configuration and never pays for itself.
  if (policy.relayers.length === 0) return bad("invalid_exact_near_no_relayer_configured", payer);
  if (policy.relayers.includes(payer)) return bad("invalid_exact_near_relayer_cannot_be_payer", payer);
  // 6. Exactly one function call, `ft_transfer`.
  if (d.actionCount !== 1) return bad("invalid_exact_near_payload_action_count", payer);
  const fc = d.functionCall;
  if (!fc) return bad("invalid_exact_near_payload_action_kind", payer);
  if (fc.methodName !== "ft_transfer") return bad("invalid_exact_near_payload_method_name", payer);
  // 7. The transfer: this token, this recipient, this amount, 1 yoctoNEAR, bounded gas.
  if (d.receiverId !== required.asset) return bad("invalid_exact_near_payload_token_contract_mismatch", payer);
  let args: { receiver_id?: unknown; amount?: unknown };
  try {
    args = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fc.args)) as typeof args;
    if (typeof args.receiver_id !== "string" || typeof args.amount !== "string" || !/^\d+$/.test(args.amount)) throw new Error("bad args");
  } catch {
    return bad("invalid_exact_near_payload_ft_transfer_args", payer);
  }
  if (args.receiver_id !== required.payTo) return bad("invalid_exact_near_payload_recipient_mismatch", payer);
  if (args.amount !== required.amount) return bad("invalid_exact_near_payload_amount_mismatch", payer);
  if (fc.deposit !== 1n) return bad("invalid_exact_near_payload_attached_deposit", payer);
  if (fc.gas > (policy.maxGas ?? MAX_SPONSORED_GAS)) return bad("invalid_exact_near_payload_gas_limit_exceeded", payer);
  // 5. Expiry inside the timeout window and an unused nonce, against final state.
  const snap = await read(() => state.final());
  if (!snap.ok) return bad("invalid_exact_near_current_block_height_unavailable", payer);
  const chain = snap.value;
  const remaining = d.maxBlockHeight - chain.height;
  if (remaining <= 0n) return bad("invalid_exact_near_payload_delegate_action_expired", payer);
  if (remaining > timeoutBlocks(required.maxTimeoutSeconds)) return bad("invalid_exact_near_payload_delegate_action_timeout_window_exceeds_max_timeout", payer);
  if (d.nonce >= chain.height * NONCE_RANGE_MULTIPLIER) return bad("invalid_exact_near_payload_delegate_action_nonce_out_of_range", payer);
  const key = await read(() => chain.accessKey(d.senderId, d.publicKey));
  if (!key.ok) return bad("invalid_exact_near_access_key_lookup_failed", payer);
  if (!key.value) return bad("invalid_exact_near_access_key_not_found", payer);
  if (d.nonce <= key.value.nonce) return bad("invalid_exact_near_payload_delegate_action_nonce_already_used", payer);
  // 8. Only a full-access key can attach the yoctoNEAR.
  if (key.value.kind === "FunctionCall") return bad("invalid_exact_near_function_call_key_not_allowed", payer);
  if (key.value.kind !== "FullAccess") return bad("invalid_exact_near_unsupported_access_key_permission", payer);
  // 9. Preflight: the payer and the token exist, the payer holds the amount, the recipient is registered.
  const sender = await read(() => chain.account(d.senderId));
  if (!sender.ok) return bad("invalid_exact_near_account_lookup_failed", payer);
  if (!sender.value) return bad("invalid_exact_near_sender_account_not_found", payer);
  const token = await read(() => chain.account(required.asset));
  if (!token.ok) return bad("invalid_exact_near_token_account_lookup_failed", payer);
  if (!token.value) return bad("invalid_exact_near_token_account_not_found", payer);
  if (token.value.codeHash === EMPTY_CODE_HASH) return bad("invalid_exact_near_token_contract_no_code", payer);
  const balance = await read(() => chain.ftBalance(required.asset, d.senderId));
  if (!balance.ok) return bad("invalid_exact_near_balance_check_failed", payer);
  if (balance.value < BigInt(required.amount)) return bad("insufficient_funds", payer);
  const storage = await read(() => chain.storageBalance(required.asset, required.payTo));
  if (!storage.ok) return bad("invalid_exact_near_storage_check_failed", payer);
  if (storage.value.supported && !storage.value.registered) return bad("invalid_exact_near_recipient_not_registered_for_storage", payer);
  return { ok: true, payer, delegate: d };
}
