/**
 * NEAR Intents through the 1Click API: any-chain deposits into a Tredio account, withdrawals out
 * of it, and funding a Hyperliquid perps balance and back, each one quote with its own deposit address.
 * With a partner JWT every quote asks for Confidential Intents (`confidentiality: "basic"`), so
 * the origin and route of a deposit cannot be linked to the account it lands in; the destination
 * transfer itself stays public. 1Click refuses that flag without the JWT ("User authentication is
 * required for confidential intent quotes", checked 2026-11-09), so without one quotes go out public.
 * 1Click's fee is the same with or without it (0.2% on an ETH route, 0.01% on USDC to USDC,
 * measured 2026-11-10). It comes from the Partner Dashboard, https://partners.near-intents.org/home,
 * as a distribution channel key, and travels as `X-API-Key`. When 1Click refuses it (revoked or
 * expired), it rests for ten minutes and quotes go out public meanwhile.
 *
 * 1Click runs on NEAR mainnet only. On testnet the app shows dry quotes (`dry: true`, no deposit
 * address) at mainnet prices, so the flow is visible without moving funds, and testnet USDC comes
 * from the faucet.
 */

export const ONECLICK_API = "https://1click.chaindefuser.com";
export const EXPLORER = "https://explorer.near-intents.org";

/** Native USDC on NEAR mainnet as a 1Click asset. */
export const NEAR_USDC_ASSET = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
/** USDC in a Hyperliquid perps balance (8 decimals); it arrives in perps, not spot. */
export const HYPERLIQUID_USDC_ASSET = "1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054";

export interface Token {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  priceUpdatedAt: string;
  contractAddress?: string;
}

export type Confidentiality = "public" | "basic" | "advanced";

export interface QuoteRequest {
  dry: boolean;
  swapType: "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT";
  /** Basis points: 100 is 1%. */
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN" | "INTENTS";
  destinationAsset: string;
  /** In the origin asset's smallest unit for EXACT_INPUT, the destination's for EXACT_OUTPUT. */
  amount: string;
  refundTo: string;
  refundType: "ORIGIN_CHAIN" | "INTENTS";
  recipient: string;
  recipientType: "DESTINATION_CHAIN" | "INTENTS";
  /** ISO time after which the deposit address stops accepting funds. */
  deadline: string;
  confidentiality?: Confidentiality;
  referral?: string;
  quoteWaitingTimeMs?: number;
}

export interface Quote {
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn?: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  deadline?: string;
  timeWhenInactive?: string;
  /** Seconds. */
  timeEstimate: number;
}

export interface QuoteResponse {
  correlationId: string;
  timestamp: string;
  /** 1Click's signature over the quote; kept with the quote to settle disputes. */
  signature: string;
  quoteRequest: QuoteRequest;
  quote: Quote;
}

export type SwapStatus = "KNOWN_DEPOSIT_TX" | "PENDING_DEPOSIT" | "INCOMPLETE_DEPOSIT" | "PROCESSING" | "SUCCESS" | "REFUNDED" | "FAILED";

export interface StatusResponse {
  correlationId: string;
  status: SwapStatus;
  updatedAt: string;
  quoteResponse?: QuoteResponse;
  swapDetails?: {
    intentHashes?: string[];
    nearTxHashes?: string[];
    amountInFormatted?: string;
    amountOutFormatted?: string;
    originChainTxHashes?: Array<{ hash: string; explorerUrl: string }>;
    destinationChainTxHashes?: Array<{ hash: string; explorerUrl: string }>;
    refundedAmountFormatted?: string;
    refundReason?: string;
  };
}

export class OneClickError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface OneClickOptions {
  baseUrl?: string;
  /** A partner JWT from https://partners.near-intents.org/home (a distribution channel key): confidential quotes. */
  jwt?: string | null;
  fetchImpl?: Fetch;
  timeoutMs?: number;
  now?: () => number;
}

/** How long a partner JWT 1Click refused sits out before it is tried again. */
export const JWT_REST_MS = 10 * 60_000;

export class OneClick {
  private readonly base: string;
  private readonly jwt: string | null;
  private readonly fetchImpl: Fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private jwtRestUntil = 0;
  private tokenCache: { at: number; tokens: Token[] } | null = null;

  constructor(o: OneClickOptions = {}) {
    this.base = (o.baseUrl ?? ONECLICK_API).replace(/\/$/, "");
    this.jwt = o.jwt ?? null;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 20_000;
    this.now = o.now ?? Date.now;
  }

  /** Whether quotes carry a partner JWT (confidential): one is set and 1Click has not refused it lately. */
  get authenticated(): boolean {
    return this.jwt !== null && this.now() >= this.jwtRestUntil;
  }

  /** The partner JWT's state for health checks: none set, in use, or resting after 1Click refused it. */
  get partner(): "none" | "ok" | "refused" {
    return this.jwt === null ? "none" : this.authenticated ? "ok" : "refused";
  }

  /**
   * One request, with the partner JWT while it is good. When 1Click refuses the JWT (401: revoked,
   * expired or mistyped), it rests for ten minutes and the request goes again without it, so
   * deposits keep working as public quotes at 1Click's own fees; `body` builds the request for
   * either case.
   */
  private async call<T>(path: string, init: { method?: string; body?: (authed: boolean) => unknown } = {}): Promise<T> {
    const authed = this.authenticated;
    try {
      return await this.send<T>(path, init.method, init.body?.(authed), authed);
    } catch (e) {
      if (!authed || !(e instanceof OneClickError) || e.status !== 401) throw e;
      this.jwtRestUntil = this.now() + JWT_REST_MS;
      console.warn(JSON.stringify({ msg: "1Click refused the partner JWT; quotes go out public", err: e.message, restSec: JWT_REST_MS / 1000 }));
      return this.send<T>(path, init.method, init.body?.(false), false);
    }
  }

  private async send<T>(path: string, method: string | undefined, body: unknown, authed: boolean): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (authed && this.jwt) headers["x-api-key"] = this.jwt;
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? message;
      } catch {
        // Not JSON: keep the text.
      }
      throw new OneClickError(`1Click ${path.split("?")[0]}: ${message}`, res.status);
    }
    return JSON.parse(text) as T;
  }

  /** Every asset 1Click supports, cached for five minutes. */
  async tokens(): Promise<Token[]> {
    if (this.tokenCache && Date.now() - this.tokenCache.at < 300_000) return this.tokenCache.tokens;
    const tokens = await this.call<Token[]>("/v0/tokens");
    this.tokenCache = { at: Date.now(), tokens };
    return tokens;
  }

  /** Requests a quote; confidential when the client has a partner JWT and the request does not say otherwise. */
  quote(req: QuoteRequest): Promise<QuoteResponse> {
    // An explicit `confidentiality` is kept as asked, so a refused JWT fails that quote rather than make it public.
    const body = (authed: boolean) => (req.confidentiality === undefined && authed ? { ...req, confidentiality: "basic" as const } : req);
    return this.call<QuoteResponse>("/v0/quote", { method: "POST", body });
  }

  /** Whether a quote this client makes is confidential. */
  confidential(req: Pick<QuoteRequest, "confidentiality">): boolean {
    const mode = req.confidentiality ?? (this.authenticated ? "basic" : "public");
    return mode !== "public";
  }

  status(depositAddress: string, depositMemo?: string): Promise<StatusResponse> {
    const q = new URLSearchParams({ depositAddress, ...(depositMemo ? { depositMemo } : {}) });
    return this.call<StatusResponse>(`/v0/status?${q}`);
  }

  /** Tells 1Click about a deposit transaction so it starts before the chain watcher sees it. */
  submitDeposit(txHash: string, depositAddress: string, memo?: string): Promise<StatusResponse> {
    return this.call<StatusResponse>("/v0/deposit/submit", { method: "POST", body: () => ({ txHash, depositAddress, ...(memo ? { memo } : {}) }) });
  }
}

/**
 * 1Click quotes only to NEAR mainnet accounts that exist. Testnet accounts do not, so testnet
 * dry quotes price the same route to this stand-in mainnet account instead; nothing is sent.
 */
export const DRY_RUN_ACCOUNT = "intents.near";

/** Default slippage for deposit and withdrawal quotes (basis points). */
export const DEFAULT_SLIPPAGE_BPS = 100;
/** How long a deposit address stays open. */
export const DEPOSIT_WINDOW_MS = 60 * 60_000;

/**
 * A deposit from any chain into a Tredio account: `amount` of `originAsset` (smallest units) from
 * the sender's wallet on its own chain, arriving as USDC on NEAR at `account`. A failed swap
 * refunds `refundTo` on the origin chain.
 */
export function depositRequest(a: { originAsset: string; amount: string; account: string; refundTo: string; dry: boolean; now?: number; slippageBps?: number }): QuoteRequest {
  return {
    dry: a.dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: a.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    originAsset: a.originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: NEAR_USDC_ASSET,
    amount: a.amount,
    refundTo: a.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: a.account,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date((a.now ?? Date.now()) + DEPOSIT_WINDOW_MS).toISOString(),
    referral: "tredio",
  };
}

/**
 * A withdrawal: `amount` USDC (6 decimals) the account sends from NEAR to the quote's deposit
 * address, arriving as `destinationAsset` at `recipient` on its own chain. A failed swap refunds
 * the account on NEAR.
 */
export function withdrawalRequest(a: { destinationAsset: string; amount: string; account: string; recipient: string; dry: boolean; now?: number; slippageBps?: number }): QuoteRequest {
  return {
    dry: a.dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: a.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    originAsset: NEAR_USDC_ASSET,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: a.destinationAsset,
    amount: a.amount,
    refundTo: a.account,
    refundType: "ORIGIN_CHAIN",
    recipient: a.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date((a.now ?? Date.now()) + DEPOSIT_WINDOW_MS).toISOString(),
    referral: "tredio",
  };
}

/** Funding a Hyperliquid perps balance from the account's USDC on NEAR (minimum 0.5 USDC on 1Click's side). */
export function hyperliquidFundingRequest(a: { amount: string; account: string; hyperliquidAddress: string; dry: boolean; now?: number }): QuoteRequest {
  return withdrawalRequest({ destinationAsset: HYPERLIQUID_USDC_ASSET, amount: a.amount, account: a.account, recipient: a.hyperliquidAddress, dry: a.dry, now: a.now });
}

/**
 * What 1Click takes from a transfer out of Hyperliquid (docs.near-intents.org, 1Click API,
 * Hyperliquid, "Deposit USDC from Hyperliquid"): a flat 0.2 USDC from every transfer to the deposit
 * address (already in the quote), at least 0.5 USDC per deposit, and, for a perps `usdSend`, 1 USDC
 * more that the quote does not include, so the account sends `amountIn` plus that. Micro-USDC.
 */
export const HYPERLIQUID_DEPOSIT_FEE = 200_000n;
export const HYPERLIQUID_MIN_DEPOSIT = 500_000n;
export const HYPERLIQUID_USD_SEND_SURCHARGE = 1_000_000n;

/**
 * USDC back from a Hyperliquid perps balance to the account on NEAR: the funding route in reverse.
 * `amount` is micro-USDC (6 decimals) as everywhere in Tredio; 1Click counts Hyperliquid USDC in 8.
 * The account then sends the quote's `amountIn` (plus HYPERLIQUID_USD_SEND_SURCHARGE by `usdSend`)
 * from its Hyperliquid address to the quote's deposit address there; a failed swap refunds that
 * Hyperliquid address.
 */
export function hyperliquidReturnRequest(a: { amount: string; account: string; hyperliquidAddress: string; dry: boolean; now?: number }): QuoteRequest {
  return depositRequest({ originAsset: HYPERLIQUID_USDC_ASSET, amount: (BigInt(a.amount) * 100n).toString(), account: a.account, refundTo: a.hyperliquidAddress, dry: a.dry, now: a.now });
}

/** Where to follow a swap on the NEAR Intents explorer. */
export const explorerUrl = (depositAddress: string) => `${EXPLORER}/transactions/${encodeURIComponent(depositAddress)}`;

/** True once a swap can no longer change. */
export const isFinal = (s: SwapStatus) => s === "SUCCESS" || s === "REFUNDED" || s === "FAILED";
