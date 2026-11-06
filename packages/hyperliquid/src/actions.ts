import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { concat, domainSeparator, keccakText, typedDataDigest } from "./eip712";

/**
 * Hyperliquid L1 actions exactly as the Tredio account contract builds and hashes them
 * (`contracts/account/src/hyperliquid.rs`). The contract signs the EIP-712 "phantom agent" digest
 * through NEAR Chain Signatures; this module builds the same action JSON (key order matters: the
 * exchange re-encodes it with MessagePack to check the signature) and, for tests and for checking
 * a signature before posting it, the same digest.
 */

export type Tif = "Gtc" | "Ioc" | "Alo";

/** One order as the account contract's `hl_order` session action takes it. */
export interface HlOrder {
  /** Ticker (`BTC`), for the contract's mark lookup. */
  asset: string;
  /** Hyperliquid asset index. */
  asset_index: number;
  is_buy: boolean;
  /** Decimal strings without trailing zeros (see format.ts). */
  price: string;
  size: string;
  reduce_only: boolean;
  tif: Tif;
}

export interface OrderAction {
  type: "order";
  orders: Array<{ a: number; b: boolean; p: string; s: string; r: boolean; t: { limit: { tif: Tif } } }>;
  grouping: "na";
}

export interface LeverageAction {
  type: "updateLeverage";
  asset: number;
  isCross: boolean;
  leverage: number;
}

export type L1Action = OrderAction | LeverageAction;

export function orderAction(o: HlOrder): OrderAction {
  return { type: "order", orders: [{ a: o.asset_index, b: o.is_buy, p: o.price, s: o.size, r: o.reduce_only, t: { limit: { tif: o.tif } } }], grouping: "na" };
}

export function leverageAction(assetIndex: number, isCross: boolean, leverage: number): LeverageAction {
  return { type: "updateLeverage", asset: assetIndex, isCross, leverage };
}

/** MessagePack of the subset of values L1 actions use (maps, arrays, strings, booleans, unsigned ints). */
export function msgpack(value: unknown): Uint8Array {
  const out: number[] = [];
  const write = (v: unknown): void => {
    if (typeof v === "boolean") out.push(v ? 0xc3 : 0xc2);
    else if (typeof v === "number") {
      if (!Number.isInteger(v) || v < 0) throw new Error("msgpack: only unsigned integers");
      if (v < 128) out.push(v);
      else if (v <= 0xff) out.push(0xcc, v);
      else if (v <= 0xffff) out.push(0xcd, v >> 8, v & 0xff);
      else if (v <= 0xffffffff) out.push(0xce, (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
      else {
        out.push(0xcf);
        const b = BigInt(v);
        for (let i = 7; i >= 0; i--) out.push(Number((b >> BigInt(i * 8)) & 0xffn));
      }
    } else if (typeof v === "string") {
      const b = new TextEncoder().encode(v);
      if (b.length < 32) out.push(0xa0 | b.length);
      else if (b.length <= 0xff) out.push(0xd9, b.length);
      else throw new Error("msgpack: string too long");
      out.push(...b);
    } else if (Array.isArray(v)) {
      if (v.length >= 16) throw new Error("msgpack: array too long");
      out.push(0x90 | v.length);
      v.forEach(write);
    } else if (v && typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
      if (entries.length >= 16) throw new Error("msgpack: map too large");
      out.push(0x80 | entries.length);
      for (const [k, x] of entries) {
        write(k);
        write(x);
      }
    } else throw new Error(`msgpack: cannot encode ${typeof v}`);
  };
  write(value);
  return new Uint8Array(out);
}

/** keccak256(msgpack(action) || nonce (8 bytes, big endian) || 0x00): the agent's connection id. */
export function actionHash(action: L1Action, nonce: number): Uint8Array {
  const packed = msgpack(action);
  const data = new Uint8Array(packed.length + 9);
  data.set(packed);
  new DataView(data.buffer).setBigUint64(packed.length, BigInt(nonce));
  return keccak_256(data);
}

/** The EIP-712 digest of the phantom agent `Agent(string source, bytes32 connectionId)` in the Exchange domain. */
export function agentDigest(connectionId: Uint8Array, mainnet: boolean): Uint8Array {
  const hash = keccak_256(concat(keccakText("Agent(string source,bytes32 connectionId)"), keccakText(mainnet ? "a" : "b"), connectionId));
  return typedDataDigest(domainSeparator("Exchange", "1", 1337), hash);
}

/** The digest the contract emits in its `hyperliquid_signed` event for this action. */
export const actionDigest = (action: L1Action, nonce: number, mainnet: boolean): string => bytesToHex(agentDigest(actionHash(action, nonce), mainnet));
