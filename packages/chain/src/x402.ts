/**
 * x402 on NEAR: the `exact` scheme of x402 v2 (x402-foundation/x402,
 * `specs/schemes/exact/scheme_exact_near.md`).
 *
 * A paid resource answers `402 Payment Required` with a `PAYMENT-REQUIRED` header. The client
 * signs a NEP-366 delegate action for exactly one NEP-141 `ft_transfer` of the asked amount to
 * `payTo` (with the 1 yoctoNEAR NEP-141 requires) and repeats the request with that signed action
 * in a `PAYMENT-SIGNATURE` header. The server checks it against the chain, serves the resource,
 * has its relayer submit the action (the relayer pays the gas and the yoctoNEAR) and answers with
 * a `PAYMENT-RESPONSE` header naming the transaction. The payer needs the token and a full-access
 * key, but no NEAR.
 *
 * This module holds the message shapes, the header codec and the paying client. The server side
 * (verification and settlement) lives in the backend (`backend/src/x402/`).
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { Near, parseKey, type PrivateKey } from "near-kit";
import { base58Decode, base58Encode } from "./proofs";

export const X402_VERSION = 2;

/** CAIP-2 network ids of the NEAR `exact` scheme. */
export const NEAR_CAIP2 = { testnet: "near:testnet", mainnet: "near:mainnet" } as const;

/** HTTP transport (v2) headers, each carrying base64 JSON. */
export const X402_HEADERS = {
  /** Server to client, with a 402: a `PaymentRequired`. */
  required: "PAYMENT-REQUIRED",
  /** Client to server: a `PaymentPayload`. */
  signature: "PAYMENT-SIGNATURE",
  /** Server to client: a `SettlementResponse`. */
  response: "PAYMENT-RESPONSE",
} as const;

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
}

export interface PaymentRequirements {
  scheme: string;
  network: string;
  /** Atomic units of `asset`, as a decimal string. */
  amount: string;
  /** The NEP-141 token contract. */
  asset: string;
  /** The account the transfer must reach. */
  payTo: string;
  maxTimeoutSeconds: number;
  /** Metadata only: it never changes what is verified. */
  extra?: Record<string, unknown>;
}

export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

/** The NEAR `exact` payload: a base64 Borsh `SignedDelegate` with one `ft_transfer`. */
export interface ExactNearPayload {
  signedDelegateAction: string;
}

export interface PaymentPayload {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: ExactNearPayload;
  extensions?: Record<string, unknown>;
}

export interface SettlementResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  /** The relayer's transaction hash; empty when nothing was broadcast. */
  transaction: string;
  network: string;
  amount?: string;
}

/** Base64 of the value's JSON (UTF-8), as every x402 header carries it. */
export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/** The JSON value of a base64 header; throws on anything that is not base64 JSON. */
export function decodeHeader<T>(header: string): T {
  const s = header.trim();
  if (s.length === 0 || s.length > 16_384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) throw new Error("not a base64 header");
  return JSON.parse(Buffer.from(s, "base64").toString("utf8")) as T;
}

/**
 * Blocks a delegate action may stay valid for (spec: one block a second on both networks):
 * `max(1, ceil(maxTimeoutSeconds))`. Verifiers reject a window longer than this.
 */
export const timeoutBlocks = (maxTimeoutSeconds: number): bigint => BigInt(Math.max(1, Math.ceil(maxTimeoutSeconds)));

/**
 * The client signs its window this many blocks under the budget, so a verifier whose RPC is a
 * block or two ahead of the client's still sees it inside the window.
 */
export const CLIENT_MARGIN_BLOCKS = 2n;

/** Gas the transfer attaches, which the relayer prepays; unused gas is refunded. */
export const FT_TRANSFER_GAS = 30n * 10n ** 12n;

/** A NEAR account that pays: it needs a full-access key, since `ft_transfer` attaches 1 yoctoNEAR. */
export interface X402Signer {
  accountId: string;
  /** `ed25519:<base58>` or `secp256k1:<base58>` secret key. */
  privateKey: string;
}

/** JSON-RPC access (the `Viewer` of this package fits). */
export interface RpcReader {
  rpc<T>(method: string, params: unknown): Promise<T>;
}

/** near-kit takes an ed25519 secret as 64 bytes (seed, then public key); a 32-byte seed is expanded. */
function fullSecret(secret: string): string {
  if (!secret.startsWith("ed25519:")) return secret;
  const raw = base58Decode(secret.slice("ed25519:".length));
  if (raw.length === 64) return secret;
  if (raw.length !== 32) throw new Error("an ed25519 secret key is 32 or 64 bytes");
  return `ed25519:${base58Encode(new Uint8Array([...raw, ...ed25519.getPublicKey(raw)]))}`;
}

const networkOf = (caip2: string): "testnet" | "mainnet" => {
  if (caip2 === NEAR_CAIP2.testnet) return "testnet";
  if (caip2 === NEAR_CAIP2.mainnet) return "mainnet";
  throw new Error(`not a NEAR network: ${caip2}`);
};

/**
 * Signs the payment for `requirements`: a delegate action from the signer to `asset` with one
 * `ft_transfer` of exactly `amount` to `payTo`, its nonce one past the key's newest nonce and its
 * expiry inside the requirements' timeout. Nothing is sent; the server's relayer submits it.
 */
export async function createPaymentPayload(o: { signer: X402Signer; rpc: RpcReader; requirements: PaymentRequirements; resource?: ResourceInfo; gas?: bigint }): Promise<PaymentPayload> {
  const r = o.requirements;
  if (r.scheme !== "exact") throw new Error(`unsupported scheme ${r.scheme}`);
  const network = networkOf(r.network);
  const secret = fullSecret(o.signer.privateKey);
  const publicKey = parseKey(secret).publicKey.toString();
  const nonceAt = (finality: "final" | "optimistic") =>
    o.rpc.rpc<{ nonce: number | string }>("query", { request_type: "view_access_key", finality, account_id: o.signer.accountId, public_key: publicKey }).then((k) => BigInt(String(k.nonce)));
  // The expiry counts from the final block (as verifiers do); the nonce follows the newest state,
  // so a transaction the key sent a moment ago (still short of final) does not take the same nonce.
  const [block, final, optimistic] = await Promise.all([o.rpc.rpc<{ header: { height: number } }>("block", { finality: "final" }), nonceAt("final"), nonceAt("optimistic")]);
  const nonce = (optimistic > final ? optimistic : final) + 1n;
  const window = timeoutBlocks(r.maxTimeoutSeconds) - CLIENT_MARGIN_BLOCKS;
  const maxBlockHeight = BigInt(block.header.height) + (window > 0n ? window : 1n);
  // With the nonce and expiry given, near-kit signs offline; the network only names the client.
  const near = new Near({ network, privateKey: secret as PrivateKey, defaultSignerId: o.signer.accountId });
  const gas = o.gas ?? FT_TRANSFER_GAS;
  const { payload } = await near
    .transaction(o.signer.accountId)
    .functionCall(r.asset, "ft_transfer", { receiver_id: r.payTo, amount: r.amount }, { gas: gas.toString() as never, attachedDeposit: "1 yocto" as never })
    .delegate({ nonce, maxBlockHeight });
  return { x402Version: X402_VERSION, ...(o.resource ? { resource: o.resource } : {}), accepted: r, payload: { signedDelegateAction: payload } };
}

/** The `PaymentRequired` of a 402: the header, or the JSON body when a server puts it only there. */
export async function readPaymentRequired(res: Response): Promise<PaymentRequired> {
  const header = res.headers.get(X402_HEADERS.required);
  const required = header ? decodeHeader<PaymentRequired>(header) : ((await res.clone().json()) as PaymentRequired);
  if (required?.x402Version !== X402_VERSION || !Array.isArray(required.accepts)) throw new Error("the 402 carries no x402 v2 payment requirements");
  return required;
}

/**
 * The first `exact` requirement on `network` the client accepts: at most `maxAmount` atomic units
 * and, when `assets` is given, one of those tokens. Throws when none qualifies.
 */
export function selectRequirements(required: PaymentRequired, network: "testnet" | "mainnet", limits: { maxAmount: bigint; assets?: readonly string[] }): PaymentRequirements {
  const fits = required.accepts.filter(
    (a) => a.scheme === "exact" && a.network === NEAR_CAIP2[network] && /^\d+$/.test(a.amount) && BigInt(a.amount) <= limits.maxAmount && (!limits.assets || limits.assets.includes(a.asset)),
  );
  const pick = fits[0];
  if (!pick) {
    const asked = required.accepts.map((a) => `${a.amount} of ${a.asset} on ${a.network}`).join(", ");
    throw new Error(`no payment option within the limit (${limits.maxAmount} atomic units${limits.assets ? ` of ${limits.assets.join(", ")}` : ""}); the server asks ${asked || "nothing"}`);
  }
  return pick;
}

export interface PaidResponse {
  response: Response;
  /** Null when the server did not ask for payment. */
  requirements: PaymentRequirements | null;
  /** The server's `PAYMENT-RESPONSE`, when it sent one. */
  settlement: SettlementResponse | null;
}

/**
 * Fetches `url`; on a 402, pays within `limits` and repeats the request once with the payment.
 * The request body must be repeatable (a string or bytes).
 */
export async function x402Fetch(
  url: string,
  init: RequestInit | undefined,
  o: { signer: X402Signer; rpc: RpcReader; network: "testnet" | "mainnet"; limits: { maxAmount: bigint; assets?: readonly string[] }; fetchImpl?: typeof fetch },
): Promise<PaidResponse> {
  const f = o.fetchImpl ?? fetch;
  const first = await f(url, init);
  if (first.status !== 402) return { response: first, requirements: null, settlement: null };
  const required = await readPaymentRequired(first);
  const requirements = selectRequirements(required, o.network, o.limits);
  const payment = await createPaymentPayload({ signer: o.signer, rpc: o.rpc, requirements, resource: required.resource });
  const headers = new Headers(init?.headers);
  headers.set(X402_HEADERS.signature, encodeHeader(payment));
  const response = await f(url, { ...init, headers });
  const settled = response.headers.get(X402_HEADERS.response);
  return { response, requirements, settlement: settled ? decodeHeader<SettlementResponse>(settled) : null };
}
