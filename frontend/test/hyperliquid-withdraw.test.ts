import { describe, expect, test } from "bun:test";
import type { OwnerAction } from "@tredio/contracts";
import { usdSendAction, userSignedDigestHex, withdrawAction } from "@tredio/hyperliquid";
import type { TxResult } from "../src/lib/account/service";
import { TxFailed } from "../src/lib/chain/outcome";
import { HL_NETWORK } from "../src/lib/config";
import { ownerActions } from "../src/lib/trade/calls";
import { intentsSendAmount, routeFee, signTransfer, transferPlan } from "../src/lib/trade/hyperliquid";

const OWN = "0x972dac64d693f387cd089f0efcda320c71097a2c";
const OTHER = "0x5e9ee1089755c3435139848e47e6635505d5a13a";
const USDC = 1_000_000n;

describe("moving USDC out of Hyperliquid: the checks before anything is signed", () => {
  const plan = (route: "near" | "arbitrum" | "hyperliquid", amount: bigint | null, destination = "", withdrawable: bigint | null = 50n * USDC) => transferPlan({ route, amount, withdrawable, destination, own: OWN });

  test("each route's fee: NEAR Intents 1.2 USDC, the bridge 1 USDC, a send none", () => {
    expect(routeFee("near")).toBe(1_200_000n);
    expect(routeFee("arbitrum")).toBe(USDC);
    expect(routeFee("hyperliquid")).toBe(0n);
    expect(plan("near", 10n * USDC).plan).toEqual({ send: 10n * USDC, fee: 1_200_000n, receive: 8_800_000n });
    expect(plan("arbitrum", 10n * USDC, OTHER).plan).toEqual({ send: 10n * USDC, fee: USDC, receive: 9n * USDC });
    expect(plan("hyperliquid", 1n, OTHER).plan).toEqual({ send: 1n, fee: 0n, receive: 1n });
  });

  test("the amount: not more than is free, and enough to clear the route's fee", () => {
    expect(plan("near", 51n * USDC).amountError).toBe("More than the 50.00 USDC free to withdraw");
    expect(plan("near", 1_400_000n).amountError).toBe("At least 1.50 USDC: NEAR Intents keeps 1.20 USDC of a transfer from Hyperliquid");
    expect(plan("near", 1_500_000n).amountError).toBeNull();
    expect(plan("arbitrum", USDC, OTHER).amountError).toBe("More than 1.00 USDC: Hyperliquid's bridge keeps that much");
    expect(plan("arbitrum", USDC, OTHER).plan).toBeNull();
    // Unknown balance (still loading): only the route's own rules apply.
    expect(plan("near", 500n * USDC, "", null).plan?.send).toBe(500n * USDC);
  });

  test("the destination: a 0x address off the NEAR route, and not the account's own for a send", () => {
    expect(plan("arbitrum", 5n * USDC).plan).toBeNull();
    expect(plan("arbitrum", 5n * USDC).destinationError).toBeNull();
    expect(plan("arbitrum", 5n * USDC, "alice.near").destinationError).toBe("Enter a 0x address");
    expect(plan("hyperliquid", 5n * USDC, OWN.toUpperCase().replace("0X", "0x")).destinationError).toBe("That is this account's own Hyperliquid address");
    // Withdrawing to the same key's address on Arbitrum is allowed.
    expect(plan("arbitrum", 5n * USDC, OWN).plan?.receive).toBe(4n * USDC);
    // The NEAR route ignores any address: 1Click's deposit address comes with the quote.
    expect(plan("near", 5n * USDC, "junk").destinationError).toBeNull();
    // An address typed before the amount is still checked.
    expect(plan("hyperliquid", null, "0x12").destinationError).toBe("Enter a 0x address");
  });

  test("a 1Click quote's amountIn (8 decimals) plus the 1 USDC its usdSend intake keeps", () => {
    expect(intentsSendAmount("850000000")).toBe(9_500_000n);
    // Never under-sends: a sub-micro remainder rounds up.
    expect(intentsSendAmount("850000001")).toBe(9_500_001n);
  });
});

describe("signing a transfer", () => {
  const sig = { r: "637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073", s: "11a6a24900e6e314136d2592e2f8d502cd89b7c15b198e1bee043c9589f9fad7", v: 27 };

  test("one mpc_sign owner action over the digest, then the same action to Hyperliquid", async () => {
    const action = withdrawAction(HL_NETWORK, OTHER, 5n * USDC, 1_700_000_000_000);
    const asked: OwnerAction[][] = [];
    const execute = async (actions: OwnerAction[]): Promise<TxResult> => {
      asked.push(actions);
      return { hash: "tx1", value: sig, sender: "tredio-relayer.testnet", outcome: null };
    };
    const posted: Array<{ url: string; body: { action: unknown; nonce: number; signature: unknown } }> = [];
    const fake = (async (url: string, init?: RequestInit) => {
      posted.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ status: "ok", response: { type: "default" } }));
    }) as unknown as typeof fetch;
    const { sent, answer } = await signTransfer(execute, action, fake);
    expect(asked).toEqual([[{ mpc_sign: { path: "hyperliquid", payload: userSignedDigestHex(action), domain_id: 0 } }]]);
    expect(asked[0]).toEqual([ownerActions.mpcSign("hyperliquid", userSignedDigestHex(action))]);
    expect(sent.hash).toBe("tx1");
    expect(answer).toEqual({ status: "ok", response: { type: "default" } });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe(HL_NETWORK === "mainnet" ? "https://api.hyperliquid.xyz/exchange" : "https://api.hyperliquid-testnet.xyz/exchange");
    expect(posted[0]!.body).toEqual({ action, nonce: 1_700_000_000_000, signature: { r: `0x${sig.r}`, s: `0x${sig.s}`, v: 27 }, vaultAddress: null });
  });

  test("no signature back from the account: nothing is posted", async () => {
    let posts = 0;
    const fake = (async () => {
      posts++;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const execute = async (): Promise<TxResult> => ({ hash: "tx2", value: undefined, sender: null, outcome: null });
    await expect(signTransfer(execute, usdSendAction(HL_NETWORK, OTHER, USDC), fake)).rejects.toBeInstanceOf(TxFailed);
    expect(posts).toBe(0);
  });
});
