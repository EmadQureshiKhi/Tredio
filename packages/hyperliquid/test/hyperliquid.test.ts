import { describe, expect, test } from "bun:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  actionDigest,
  actionHash,
  agentDigest,
  evmAddressOfKey,
  exchangeBody,
  formatPrice,
  formatSize,
  leverageAction,
  msgpack,
  orderAction,
  orderOutcome,
  postUserSigned,
  transferOutcome,
  usdAmount,
  usdClassTransferAction,
  usdSendAction,
  userSignedBody,
  userSignedDigest,
  userSignedDigestHex,
  withdrawAction,
} from "../src";

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

/**
 * Withdrawals and sends. The vectors are Hyperliquid's own: tests/signing_test.py in
 * hyperliquid-python-sdk (`test_sign_usd_transfer_action`, `test_sign_withdraw_from_bridge_action`)
 * signs these exact testnet messages with this key through eth_account and expects these r, s, v.
 * Every digest here was also computed independently with ethers 6.17 (`TypedDataEncoder.hash`).
 */
describe("user-signed transfers match Hyperliquid's SDK", () => {
  const key = hexToBytes("0123456789012345678901234567890123456789012345678901234567890123");
  const destination = "0x5e9ee1089755c3435139848e47e6635505d5a13a";
  const time = 1_687_816_341_423;
  const sign = (digest: Uint8Array) => {
    const sig = secp256k1.Signature.fromBytes(secp256k1.sign(digest, key, { prehash: false, format: "recovered" }), "recovered");
    return { r: `0x${sig.r.toString(16).padStart(64, "0")}`, s: `0x${sig.s.toString(16).padStart(64, "0")}`, v: (sig.recovery ?? 0) + 27 };
  };

  test("usdSend on testnet: the SDK's digest and signature", () => {
    const a = usdSendAction("testnet", destination, 1_000_000n, time);
    expect(a).toEqual({ type: "usdSend", hyperliquidChain: "Testnet", signatureChainId: "0x66eee", destination, amount: "1", time });
    expect(userSignedDigestHex(a)).toBe("cacf7585cc49ca60c6c5fb3001e226c0ca03c46252c893eea574c78907b7cebe");
    expect(sign(userSignedDigest(a))).toEqual({ r: "0x637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073", s: "0x11a6a24900e6e314136d2592e2f8d502cd89b7c15b198e1bee043c9589f9fad7", v: 27 });
  });

  test("withdraw3 on testnet: the SDK's digest and signature", () => {
    const a = withdrawAction("testnet", destination, 1_000_000n, time);
    expect(a.type).toBe("withdraw3");
    expect(userSignedDigestHex(a)).toBe("8080d06f566813165cec60d85300445133b3439e9c92e10b93ed510372608899");
    expect(sign(userSignedDigest(a))).toEqual({ r: "0x8363524c799e90ce9bc41022f7c39b4e9bdba786e5f9c72b20e43e1462c37cf9", s: "0x58b1411a775938b83e29182e8ef74975f9054c8e97ebf5ec2dc8d51bfc893881", v: 28 });
  });

  test("mainnet signs for Arbitrum One with hyperliquidChain Mainnet (digests from ethers)", () => {
    const w = withdrawAction("mainnet", destination, 12_500_000n, 1_700_000_000_000);
    expect(w).toMatchObject({ hyperliquidChain: "Mainnet", signatureChainId: "0xa4b1", amount: "12.5" });
    expect(userSignedDigestHex(w)).toBe("59ac165c84dfe89a8fa99250188fad1309bfc3bb0f02553bf7350a829027219c");
    expect(userSignedDigestHex(usdSendAction("mainnet", destination, 12_500_000n, 1_700_000_000_000))).toBe("aaaa00717967a6e5d56ba6a149fb7171c226d0c5133f10f69edda060b598c902");
  });

  test("usdClassTransfer moves spot USDC to perps, signed over its nonce (digests from ethers)", () => {
    const a = usdClassTransferAction("testnet", 1_000_000n, true, time);
    expect(a).toEqual({ type: "usdClassTransfer", hyperliquidChain: "Testnet", signatureChainId: "0x66eee", amount: "1", toPerp: true, nonce: time });
    expect(userSignedDigestHex(a)).toBe("5149dfa9ac9a951c7236ba72dd42984ff953a7c61ac8bd3c15cb5976aa33bf67");
    expect(userSignedDigestHex(usdClassTransferAction("mainnet", 12_500_000n, false, 1_700_000_000_000))).toBe("46bcd93d54a3f05304a4be55b9cc204fea5b552f7169e5f1b73fe56d1c307ae6");
    expect(userSignedBody(a, { r: "0x01", s: "0x02", v: 27 }).nonce).toBe(time);
  });

  test("a checksummed destination is signed and sent in lowercase", () => {
    const a = usdSendAction("testnet", "0x5E9EE1089755C3435139848E47E6635505D5A13A", 1_000_000n, time);
    expect(a.destination).toBe(destination);
    expect(userSignedDigestHex(a)).toBe("cacf7585cc49ca60c6c5fb3001e226c0ca03c46252c893eea574c78907b7cebe");
    expect(() => usdSendAction("testnet", "0x123", 1_000_000n, time)).toThrow();
    expect(() => withdrawAction("testnet", destination, 0n, time)).toThrow();
  });

  test("amounts are decimal strings without trailing zeros", () => {
    expect(usdAmount(1_000_000n)).toBe("1");
    expect(usdAmount(12_500_000n)).toBe("12.5");
    expect(usdAmount(1n)).toBe("0.000001");
    expect(usdAmount(1_234_567_890n)).toBe("1234.56789");
  });

  test("the /exchange body: the action, its time as the nonce, and the MPC signature in 0x words", async () => {
    const a = withdrawAction("testnet", destination, 2_000_000n, time);
    const sig = { r: "8363524c799e90ce9bc41022f7c39b4e9bdba786e5f9c72b20e43e1462c37cf9", s: "b1411a775938b83e29182e8ef74975f9054c8e97ebf5ec2dc8d51bfc8938", v: 28 };
    const body = userSignedBody(a, sig);
    expect(body).toEqual({ action: a, nonce: time, signature: { r: `0x${sig.r}`, s: "0x0000b1411a775938b83e29182e8ef74975f9054c8e97ebf5ec2dc8d51bfc8938", v: 28 }, vaultAddress: null });
    expect(exchangeBody(orderAction(order), 5, sig).nonce).toBe(5);
    const seen: Array<{ url: string; body: unknown }> = [];
    const fake = (async (url: string, init?: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ status: "ok", response: { type: "default" } }));
    }) as unknown as typeof fetch;
    expect(transferOutcome(await postUserSigned("testnet", a, sig, fake))).toEqual({ ok: true });
    expect(seen).toEqual([{ url: "https://api.hyperliquid-testnet.xyz/exchange", body }]);
    expect(transferOutcome({ status: "err", response: "Insufficient balance for withdrawal" })).toEqual({ ok: false, error: "Insufficient balance for withdrawal" });
  });
});
