import { describe, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { actionDigest, actionHash, agentDigest, evmAddressOfKey, formatPrice, formatSize, leverageAction, msgpack, orderAction, orderOutcome } from "../src";

const order = { asset: "BTC", asset_index: 0, is_buy: true, price: "65000", size: "0.001", reduce_only: false, tif: "Ioc" as const };

describe("L1 actions match the account contract", () => {
  test("MessagePack bytes", () => {
    expect(bytesToHex(msgpack(orderAction(order)))).toBe(
      "83a474797065a56f72646572a66f72646572739186a16100a162c3a170a53635303030a173a5302e303031a172c2a17481a56c696d697481a3746966a3496f63a867726f7570696e67a26e61",
    );
    expect(bytesToHex(msgpack(leverageAction(3, false, 10)))).toBe("84a474797065ae7570646174654c65766572616765a5617373657403a7697343726f7373c2a86c657665726167650a");
  });

  test("connection id and EIP-712 digest", () => {
    const cid = actionHash(orderAction(order), 1_700_000_000_000);
    expect(bytesToHex(cid)).toBe("3da5943d2d9f1ea6c0dbb3b01f6bbde493957855410e9a7a4dd5c766146a1883");
    expect(bytesToHex(agentDigest(cid, false))).toBe("b2537461185e0995f837c1e35d7e8a19244a13383f2e5a7013e1572cd25543ba");
    expect(actionDigest(orderAction(order), 1_700_000_000_000, true)).not.toBe(actionDigest(orderAction(order), 1_700_000_000_000, false));
  });

  test("unsigned integers of every width", () => {
    expect(bytesToHex(msgpack(200))).toBe("ccc8");
    expect(bytesToHex(msgpack(70_000))).toBe("ce00011170");
    expect(bytesToHex(msgpack(1_700_000_000_000))).toBe("cf0000018bcfe56800");
  });
});

describe("tick and lot rules", () => {
  test("prices keep five significant figures and the decimal cap", () => {
    expect(formatPrice(65_123.456, 5)).toBe("65123");
    expect(formatPrice(3456.789, 4)).toBe("3456.8");
    expect(formatPrice(1.234567, 0)).toBe("1.2346");
    expect(formatPrice(0.0123456, 0)).toBe("0.012346");
    expect(formatPrice(0.0123456, 2)).toBe("0.0123");
    expect(formatPrice(100_000.4, 5)).toBe("100000");
    expect(formatPrice(3456.71, 4, "up")).toBe("3456.8");
    expect(formatPrice(3456.79, 4, "down")).toBe("3456.7");
  });

  test("sizes round down to the lot", () => {
    expect(formatSize(0.0012345, 5)).toBe("0.00123");
    expect(formatSize(2, 2)).toBe("2");
    expect(() => formatSize(0, 2)).toThrow();
  });
});

test("an EVM address from a derived key", () => {
  // keccak256 of 64 zero bytes ends in these 20 bytes.
  expect(evmAddressOfKey("secp256k1:1111111111111111111111111111111111111111111111111111111111111111")).toBe("0x3f17f1962b36e491b30a40b2405849e597ba5fb5");
});

test("order outcomes", () => {
  expect(orderOutcome({ status: "err", response: "bad" })).toEqual({ ok: false, error: "bad" });
  expect(orderOutcome({ status: "ok", response: { type: "order", data: { statuses: [{ error: "Insufficient margin" }] } } })).toEqual({ ok: false, error: "Insufficient margin" });
  expect(orderOutcome({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.01", avgPx: "65000", oid: 7 } }] } } })).toEqual({ ok: true, oid: 7, filled: { totalSz: 0.01, avgPx: 65000 } });
});
