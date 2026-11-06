import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base58Encode, publicKeyOf } from "@tredio/chain";
import type { Session, SessionAction } from "@tredio/contracts";
import { type AccountState, actionHash, agentDigest, type EvmSignature, type ExchangeResponse, type L1Action, leverageAction, orderAction, type PerpMarket } from "@tredio/hyperliquid";
import { connect, ExecutorDb } from "../src/db";
import type { RegistryMark } from "../src/orders";
import { type Fill, type HyperliquidApi, recoverAddress, type SessionChain } from "../src/venue";

/**
 * Fakes for the executor's two outside worlds: an account on NEAR (its session, gas key and a
 * Chain Signatures key that signs exactly what the contract would), and Hyperliquid (an exchange
 * that recovers the signer from each signature, as Hyperliquid does, and fills immediate-or-cancel
 * orders at the mark).
 */

export const T = 1_800_000_000;

export function market(symbol: string, index: number, szDecimals: number, markPx: number, maxLeverage = 40): PerpMarket {
  return { index, symbol, szDecimals, maxLeverage, markPx, midPx: markPx, oraclePx: markPx, funding: 0, openInterest: 0, dayNtlVlm: 0, prevDayPx: markPx };
}

/** A fresh `ed25519:<base58>` secret and its public key. */
export function ed25519Key(): { secretKey: string; publicKey: string } {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const secretKey = `ed25519:${base58Encode(seed)}`;
  return { secretKey, publicKey: publicKeyOf(secretKey) };
}

const evmAddress = (secret: Uint8Array) => `0x${bytesToHex(keccak_256(secp256k1.getPublicKey(secret, false).slice(1)).slice(-20))}`;

/** The L1 action a session action makes the contract sign, and its nonce. */
function l1Of(a: SessionAction): { action: L1Action; nonce: number } | null {
  if (typeof a === "object" && "hl_order" in a) return { action: orderAction(a.hl_order.order), nonce: a.hl_order.nonce };
  if (typeof a === "object" && "hl_leverage" in a) return { action: leverageAction(a.hl_leverage.asset_index, a.hl_leverage.is_cross, a.hl_leverage.leverage), nonce: a.hl_leverage.nonce };
  return null;
}

export function signL1(action: L1Action, nonce: number, secret: Uint8Array, mainnet = false): EvmSignature {
  const sig = secp256k1.Signature.fromBytes(secp256k1.sign(agentDigest(actionHash(action, nonce), mainnet), secret, { prehash: false, format: "recovered" }), "recovered");
  return { r: sig.r.toString(16).padStart(64, "0"), s: sig.s.toString(16).padStart(64, "0"), v: (sig.recovery ?? 0) + 27 };
}

/** A Tredio account with one session: the contract's scope and expiry checks, and its Chain Signatures key. */
export class FakeAccount implements SessionChain {
  readonly hlSecret: Uint8Array;
  readonly address: string;
  readonly key = ed25519Key();
  session_: Session | null;
  gas = 32n * 10n ** 22n;
  calls: SessionAction[] = [];
  /** Errors the next session calls throw, in order (the contract's panics, RPC failures). */
  failures: Error[] = [];
  /** Sign with another key, as a wrong derivation would. */
  wrongKey: Uint8Array | null = null;
  private n = 0;

  constructor(
    readonly account: string,
    label = "autopilot",
    scope = { outcomes: false, perps: false, hyperliquid: true },
    /** The account's Chain Signatures key; another session key of the same account signs with the same one. */
    hlSecret?: Uint8Array,
  ) {
    this.hlSecret = hlSecret ?? secp256k1.utils.randomSecretKey();
    this.address = evmAddress(this.hlSecret);
    this.session_ = { label, scope, created_at: T - 3600, expires_at: T + 7 * 86_400, daily_limit: "500000000", spent: "0", day: 0, gas_key: true };
  }

  async session(account: string, publicKey: string): Promise<Session | null> {
    return account === this.account && publicKey === this.key.publicKey ? this.session_ : null;
  }

  async gasBalance(): Promise<bigint | null> {
    return this.gas;
  }

  async sessionCall(action: SessionAction): Promise<{ hash: string; value: unknown }> {
    const f = this.failures.shift();
    if (f) throw f;
    if (!this.session_) throw new Error("not a session key");
    this.calls.push(action);
    this.gas -= 5n * 10n ** 21n;
    const l1 = l1Of(action);
    if (!l1) throw new Error("not a Hyperliquid action");
    return { hash: `tx${++this.n}`, value: signL1(l1.action, l1.nonce, this.wrongKey ?? this.hlSecret) };
  }
}

interface FakePosition {
  szi: number;
  entryPx: number;
  marginUsed: number;
  leverage: number;
}

/** Hyperliquid in memory: recovers each signer, refuses unknown users and seen nonces, fills IOC orders at the mark. */
export class FakeExchange implements HyperliquidApi {
  readonly markets: PerpMarket[];
  readonly balances = new Map<string, number>();
  readonly books = new Map<string, Map<string, FakePosition>>();
  readonly leverages = new Map<string, { type: "cross" | "isolated"; value: number }>();
  readonly fillsBy = new Map<string, Fill[]>();
  readonly posted: Array<{ user: string; action: L1Action; nonce: number }> = [];
  private readonly seen = new Set<string>();
  feeBps = 4.5;
  /** Posts that fail at the network before reaching the exchange. */
  down = 0;
  now = () => T * 1000;
  private oid = 100;

  constructor(markets: PerpMarket[]) {
    this.markets = markets;
  }

  bySymbol(symbol: string): PerpMarket {
    const m = this.markets.find((x) => x.symbol === symbol);
    if (!m) throw new Error(`no ${symbol}`);
    return m;
  }

  setMark(symbol: string, px: number): void {
    this.bySymbol(symbol).markPx = px;
  }

  fund(address: string, usdc: number): void {
    this.balances.set(address, usdc);
  }

  private book(user: string): Map<string, FakePosition> {
    let b = this.books.get(user);
    if (!b) {
      b = new Map();
      this.books.set(user, b);
    }
    return b;
  }

  private addFill(user: string, f: Omit<Fill, "oid" | "time" | "dir"> & { oid?: number; dir?: string }): number {
    const oid = f.oid ?? ++this.oid;
    this.fillsBy.set(user, [{ ...f, oid, time: this.now(), dir: f.dir ?? "" }, ...(this.fillsBy.get(user) ?? [])]);
    return oid;
  }

  async post(action: L1Action, nonce: number, sig: EvmSignature): Promise<ExchangeResponse> {
    if (this.down > 0) {
      this.down--;
      throw new Error("fetch failed");
    }
    const user = recoverAddress(agentDigest(actionHash(action, nonce), false), sig);
    this.posted.push({ user, action, nonce });
    if (this.seen.has(`${user}:${nonce}`)) return { status: "err", response: `Invalid nonce: duplicate nonce ${nonce}` };
    this.seen.add(`${user}:${nonce}`);
    if (!this.balances.has(user)) return { status: "err", response: `User or API Wallet ${user} does not exist.` };
    if (action.type === "updateLeverage") {
      this.leverages.set(`${user}:${this.markets.find((x) => x.index === action.asset)!.symbol}`, { type: action.isCross ? "cross" : "isolated", value: action.leverage });
      return { status: "ok", response: { type: "default" } };
    }
    const o = action.orders[0]!;
    const m = this.markets.find((x) => x.index === o.a)!;
    const mark = m.markPx;
    const status = (s: Record<string, unknown>): ExchangeResponse => ({ status: "ok", response: { type: "order", data: { statuses: [s] } } });
    if (o.b ? Number(o.p) < mark : Number(o.p) > mark) return status({ error: `Order could not immediately match against any resting orders. asset=${o.a}` });
    const book = this.book(user);
    const held = book.get(m.symbol);
    let size = Number(o.s);
    const signed = o.b ? 1 : -1;
    let closedPnl = 0;
    if (o.r) {
      if (!held || Math.sign(held.szi) === signed) return status({ error: "Reduce only order would increase position." });
      size = Math.min(size, Math.abs(held.szi));
      closedPnl = (mark - held.entryPx) * size * Math.sign(held.szi);
      const left = Math.abs(held.szi) - size;
      if (left <= 1e-12) book.delete(m.symbol);
      else book.set(m.symbol, { ...held, szi: left * Math.sign(held.szi), marginUsed: held.marginUsed * (left / Math.abs(held.szi)) });
    } else {
      const lev = this.leverages.get(`${user}:${m.symbol}`) ?? { type: "cross", value: 20 };
      const margin = (size * mark) / lev.value;
      if (margin > this.withdrawable(user)) return status({ error: `Insufficient margin to place order. asset=${o.a}` });
      const szi = (held?.szi ?? 0) + signed * size;
      const entryPx = held ? (held.entryPx * Math.abs(held.szi) + mark * size) / Math.abs(szi) : mark;
      book.set(m.symbol, { szi, entryPx, marginUsed: (held?.marginUsed ?? 0) + margin, leverage: lev.value });
    }
    const fee = (size * mark * this.feeBps) / 10_000;
    this.balances.set(user, this.balances.get(user)! - fee + closedPnl);
    const oid = this.addFill(user, { coin: m.symbol, px: mark, sz: size, side: o.b ? "B" : "A", closedPnl, fee, liquidation: false });
    return status({ filled: { totalSz: String(size), avgPx: String(mark), oid } });
  }

  private withdrawable(user: string): number {
    return (this.balances.get(user) ?? 0) - [...this.book(user).values()].reduce((a, p) => a + p.marginUsed, 0);
  }

  /** The liquidation engine takes a position at the mark; the margin is lost. */
  liquidate(user: string, symbol: string): void {
    const p = this.book(user).get(symbol)!;
    const mark = this.bySymbol(symbol).markPx;
    this.book(user).delete(symbol);
    this.balances.set(user, this.balances.get(user)! - p.marginUsed);
    this.addFill(user, { coin: symbol, px: mark, sz: Math.abs(p.szi), side: p.szi > 0 ? "A" : "B", closedPnl: -p.marginUsed, fee: 0, liquidation: true });
  }

  async accountState(address: string): Promise<AccountState> {
    const positions = [...this.book(address).entries()].map(([coin, p]) => ({
      coin,
      szi: p.szi,
      entryPx: p.entryPx,
      positionValue: Math.abs(p.szi) * this.bySymbol(coin).markPx,
      unrealizedPnl: (this.bySymbol(coin).markPx - p.entryPx) * p.szi,
      marginUsed: p.marginUsed,
      leverage: p.leverage,
      liquidationPx: null,
    }));
    const balance = this.balances.get(address) ?? 0;
    return { accountValue: balance, withdrawable: this.withdrawable(address), totalMarginUsed: balance - this.withdrawable(address), positions, time: this.now() };
  }

  async leverage(address: string, coin: string): Promise<{ type: "cross" | "isolated"; value: number } | null> {
    return this.leverages.get(`${address}:${coin}`) ?? { type: "cross", value: 20 };
  }

  async fills(address: string): Promise<Fill[]> {
    return this.fillsBy.get(address) ?? [];
  }
}

/** Tredio's registry marks (8 decimals): fresh (ten seconds old at `now`) unless set with a time. */
export class FakeRegistry {
  readonly marks = new Map<string, { price: string; at: number | null }>();
  now = T;
  set(asset: string, price: number, at: number | null = null): void {
    this.marks.set(asset, { price: BigInt(Math.round(price * 1e8)).toString(), at });
  }
  read = async (asset: string): Promise<RegistryMark | null> => {
    const m = this.marks.get(asset);
    return m ? { price: m.price, at: m.at ?? this.now - 10 } : null;
  };
}

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** The backend's schema in a schema of its own on the test database; `drop` removes it. */
export async function testDb(): Promise<{ db: ExecutorDb; drop: () => Promise<void> }> {
  const schema = `autopilot_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const sql = connect(TEST_DATABASE_URL!, { schema, max: 2 });
  await sql.unsafe(`create schema if not exists "${schema}"`);
  const dir = join(import.meta.dir, "../../../backend/src/db/migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await sql.unsafe(readFileSync(join(dir, f), "utf8"));
  return {
    db: new ExecutorDb(sql),
    drop: async () => {
      await sql.unsafe(`drop schema if exists "${schema}" cascade`);
      await sql.end({ timeout: 5 });
    },
  };
}
