import {
  decodeHeader,
  encodeHeader,
  NEAR_CAIP2,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type ResourceInfo,
  type SettlementResponse,
  X402_HEADERS,
  X402_VERSION,
} from "@tredio/chain";
import type { Context } from "hono";
import type { Log } from "../log";
import type { Settler } from "./near";
import { type NearState, verifyExact } from "./scheme";
import type { X402Payments } from "./store";

/**
 * The x402 paywall for one route, in the scheme's `authorization` flow: verify the payment
 * against the chain, produce the resource, settle, then answer. The resource is produced only
 * for a verified payment, and nobody pays for a request that produced nothing (an error answer).
 * The answer to a settled payment carries `PAYMENT-RESPONSE`; a refused or failed payment answers
 * 402 with `PAYMENT-REQUIRED` again (and `PAYMENT-RESPONSE` when settlement failed).
 */

/** The window a signed payment stays valid for: 60 blocks, about a minute. */
export const MAX_TIMEOUT_SECONDS = 60;

export interface Offer {
  /** What the call buys, shown in the 402. */
  description: string;
  /** Price in the asset's atomic units (USDC: 6 decimals). */
  amount: bigint;
}

export interface PaywallOptions {
  network: "testnet" | "mainnet";
  /** The NEP-141 token paid in. */
  asset: string;
  payTo: string;
  state: NearState;
  settler: Settler;
  payments: X402Payments;
  /** Read `X-Forwarded-Proto` for the resource URL (a proxy terminates TLS in front). */
  trustProxy: boolean;
  log: Log;
}

export class Paywall {
  constructor(private readonly o: PaywallOptions) {}

  get network(): string {
    return NEAR_CAIP2[this.o.network];
  }

  requirements(offer: Offer): PaymentRequirements {
    return {
      scheme: "exact",
      network: this.network,
      amount: offer.amount.toString(),
      asset: this.o.asset,
      payTo: this.o.payTo,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      extra: { symbol: "USDC", decimals: 6 },
    };
  }

  private resource(c: Context, offer: Offer): ResourceInfo {
    const url = new URL(c.req.url);
    const proto = this.o.trustProxy ? c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() : undefined;
    if (proto === "https" || proto === "http") url.protocol = `${proto}:`;
    return { url: url.toString(), description: offer.description, mimeType: "application/json", serviceName: "Tredio", tags: ["attention", "near", "markets"] };
  }

  /** A 402 asking for `offer`, with the reason a payment was refused when there is one. */
  private ask(c: Context, offer: Offer, error: string, settlement?: SettlementResponse): Response {
    const body: PaymentRequired = { x402Version: X402_VERSION, error, resource: this.resource(c, offer), accepts: [this.requirements(offer)] };
    const headers: Record<string, string> = { [X402_HEADERS.required]: encodeHeader(body) };
    if (settlement) headers[X402_HEADERS.response] = encodeHeader(settlement);
    return c.json(body, 402, headers);
  }

  /** Serves `produce` to a request that pays `offer`, and asks for payment otherwise. */
  async charge(c: Context, offer: Offer, produce: () => Promise<Response>): Promise<Response> {
    const header = c.req.header(X402_HEADERS.signature);
    if (!header) return this.ask(c, offer, `${X402_HEADERS.signature} header is required`);
    let payment: PaymentPayload;
    try {
      payment = decodeHeader<PaymentPayload>(header);
      if (typeof payment !== "object" || payment === null || typeof payment.accepted !== "object" || payment.accepted === null) throw new Error("not a payment payload");
    } catch {
      return c.json({ x402Version: X402_VERSION, error: "invalid_payload" }, 400);
    }
    const required = this.requirements(offer);
    const v = await verifyExact(payment, required, this.o.state, { relayers: this.o.settler.relayers });
    if (!v.ok) return this.ask(c, offer, v.reason);
    const d = v.delegate;
    const path = new URL(c.req.url).pathname;
    const resource = (() => {
      try {
        return decodeURIComponent(path);
      } catch {
        return path;
      }
    })();
    const claim = await this.o.payments.claim({
      payloadHash: d.payloadHash,
      resource,
      network: required.network,
      asset: required.asset,
      payTo: required.payTo,
      amount: offer.amount,
      payer: v.payer,
      publicKey: d.publicKey,
      nonce: d.nonce,
    });
    if (claim === null) return this.ask(c, offer, "duplicate_settlement", { success: false, errorReason: "duplicate_settlement", transaction: "", network: required.network });
    let res: Response;
    try {
      res = await produce();
    } catch (e) {
      await this.o.payments.release(claim);
      throw e;
    }
    if (res.status >= 400) {
      await this.o.payments.release(claim);
      return res;
    }
    const s = await this.o.settler.settle(payment.payload.signedDelegateAction, { asset: required.asset, payTo: required.payTo, amount: required.amount, payer: v.payer });
    // The chain has the last word: a ledger write that fails is logged, and a settled payment is still served.
    await this.o.payments.finish(claim, s.status, s.transaction, s.status === "settled" ? null : s.error).catch((e: Error) => this.o.log.error({ err: e.message, tx: s.transaction, status: s.status }, "x402 ledger write failed"));
    if (s.status !== "settled") {
      this.o.log.warn({ payer: v.payer, resource, tx: s.transaction || null, status: s.status, err: s.error }, "x402 settlement did not complete");
      const reason = s.status === "pending" ? "settlement_pending" : "settlement_failed";
      return this.ask(c, offer, reason, { success: false, errorReason: reason, transaction: s.transaction, network: required.network, payer: v.payer });
    }
    this.o.log.info({ payer: v.payer, resource, amount: required.amount, tx: s.transaction }, "x402 payment settled");
    const settled: SettlementResponse = { success: true, transaction: s.transaction, network: required.network, payer: v.payer, amount: required.amount };
    const out = new Response(res.body, res);
    out.headers.set(X402_HEADERS.response, encodeHeader(settled));
    return out;
  }
}
