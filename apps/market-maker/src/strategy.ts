/**
 * Quoting math for the Tredio book. Prices are USDC per token in ticks of 0.001 (1 to 999), sizes
 * raw token units (6 decimals) in lots of 0.001 token. Pure, so it is tested without a chain.
 */

export const TICKS = 1000;
export const LOT = 1000n;
export const TOKEN = 1_000_000;

export interface Level {
  tick: number;
  /** Raw token units, a multiple of LOT. */
  size: bigint;
}

export interface Ladder {
  bids: Level[];
  asks: Level[];
}

export interface QuoteParams {
  /** Distance from fair value to the first bid and ask, as a price (0.02 = 2 cents). */
  halfSpread: number;
  /** Extra distance per further level. */
  levelStep: number;
  levels: number;
  /** Tokens per level. */
  levelTokens: number;
  /** Largest shift of the quotes against net inventory, as a price. */
  maxSkew: number;
  /** Net UP minus DOWN tokens at which the skew is largest and the side adding to it stops. */
  inventoryLimit: number;
}

export interface Holdings {
  /** Tokens on the book (free or resting in asks), per side. */
  up: number;
  down: number;
  /** USDC available to back bids in this series. */
  usdc: number;
}

const bidTick = (p: number) => Math.floor(p * TICKS + 1e-9);
const askTick = (p: number) => Math.ceil(p * TICKS - 1e-9);
const lots = (tokens: number) => (BigInt(Math.floor(tokens * TOKEN)) / LOT) * LOT;

/**
 * Bid and ask ladders for UP around `p` and for DOWN around 1 - p, skewed against net inventory.
 * The asks of the two sides always sum to more than 1 USDC and the bids to less, so the quotes
 * never offer a complete set below or above its redemption value.
 */
export function ladders(p: number, h: Holdings, q: QuoteParams): { up: Ladder; down: Ladder } {
  const net = h.up - h.down;
  const pressure = Math.max(-1, Math.min(1, net / q.inventoryLimit));
  const skew = -q.maxSkew * pressure;
  const side = (center: number, held: number, budget: number, buyAllowed: boolean): Ladder => {
    const bids: Level[] = [];
    const asks: Level[] = [];
    let usdcLeft = budget;
    let tokensLeft = held;
    for (let i = 0; i < q.levels; i++) {
      const off = q.halfSpread + i * q.levelStep;
      const bid = bidTick(center - off);
      const ask = askTick(center + off);
      const bidCost = (bid / TICKS) * q.levelTokens;
      if (buyAllowed && bid >= 1 && bidCost <= usdcLeft) {
        bids.push({ tick: bid, size: lots(q.levelTokens) });
        usdcLeft -= bidCost;
      }
      const askTokens = Math.min(q.levelTokens, tokensLeft);
      if (ask <= TICKS - 1 && lots(askTokens) > 0n) {
        asks.push({ tick: ask, size: lots(askTokens) });
        tokensLeft -= askTokens;
      }
    }
    return { bids, asks };
  };
  // Long UP: stop buying more UP; long DOWN: stop buying more DOWN.
  return { up: side(p + skew, h.up, h.usdc / 2, net < q.inventoryLimit), down: side(1 - p - skew, h.down, h.usdc / 2, -net < q.inventoryLimit) };
}

export type Urgency = "none" | "drift" | "urgent";

/**
 * How badly resting orders need a re-quote. Urgent: a level appeared or vanished, a level is less
 * than half its size (someone traded), or a price is off by twice the threshold. Drift: a price is
 * off by the threshold or more, worth fixing but not at any cost, so drift re-quotes are spaced out.
 */
export function requoteUrgency(live: Ladder, want: Ladder, thresholdTicks: number): Urgency {
  let drift = false;
  for (const [a, b] of [[live.bids, want.bids], [live.asks, want.asks]] as const) {
    if (a.length !== b.length) return "urgent";
    for (const [i, l] of a.entries()) {
      const off = Math.abs(l.tick - b[i]!.tick);
      if (l.size * 2n < b[i]!.size || off >= 2 * thresholdTicks) return "urgent";
      if (off >= thresholdTicks) drift = true;
    }
  }
  return drift ? "drift" : "none";
}

/** The series worth quoting: shorter windows first (most trading happens there), then by attention. */
export function pickSeries<T extends { window: number; index: number }>(series: readonly T[], max: number): T[] {
  return [...series].sort((a, b) => a.window - b.window || b.index - a.index).slice(0, max);
}

export type Arbitrage = { kind: "buyBoth"; tokens: number; upTick: number; downTick: number; edge: number } | { kind: "sellBoth"; tokens: number; upTick: number; downTick: number; edge: number };

/**
 * A complete-set arbitrage against other traders' best orders: buying UP and DOWN for less than
 * 1 USDC a pair (then redeeming), or minting a pair for 1 USDC and selling both for more. The
 * book's taker fee comes out of what the taker receives.
 */
export function findArbitrage(up: { bestBid: Level | null; bestAsk: Level | null }, down: { bestBid: Level | null; bestAsk: Level | null }, feeBps: number, minEdge: number, maxTokens: number): Arbitrage | null {
  const fee = feeBps / 10_000;
  const size = (a: Level, b: Level) => Math.min(Number(a.size), Number(b.size), maxTokens * TOKEN) / TOKEN;
  if (up.bestAsk && down.bestAsk) {
    const cost = (up.bestAsk.tick + down.bestAsk.tick) / TICKS;
    const edge = 1 - fee - cost;
    if (edge >= minEdge) return { kind: "buyBoth", tokens: size(up.bestAsk, down.bestAsk), upTick: up.bestAsk.tick, downTick: down.bestAsk.tick, edge };
  }
  if (up.bestBid && down.bestBid) {
    const edge = ((up.bestBid.tick + down.bestBid.tick) / TICKS) * (1 - fee) - 1;
    if (edge >= minEdge) return { kind: "sellBoth", tokens: size(up.bestBid, down.bestBid), upTick: up.bestBid.tick, downTick: down.bestBid.tick, edge };
  }
  return null;
}
