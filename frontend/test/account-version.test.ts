import { describe, expect, test } from "bun:test";
import { calls, sessionCallTgas } from "@tredio/contracts";
import { describeReason } from "../src/lib/account/errors";
import { GAS_KEY_MIN, gasKeyMin } from "../src/lib/account/service";
import { ownerActions } from "../src/lib/trade/calls";
import { DEPLOYMENT } from "../src/lib/config";

const NEAR = 10n ** 24n;

describe("account code versions", () => {
  test("a session call attaches 300 Tgas on v1 accounts and 150 on v2", () => {
    const C = calls(DEPLOYMENT);
    expect(C.account.sessionCall("0uabc", "faucet", sessionCallTgas(1)).gas).toBe((300n * 10n ** 12n).toString());
    expect(C.account.sessionCall("0uabc", "faucet", sessionCallTgas(2)).gas).toBe((150n * 10n ** 12n).toString());
  });

  test("the gas key is refilled below what one call prepays plus 0.01 NEAR", () => {
    expect(GAS_KEY_MIN).toBe(310_000_000_000_000_000_000_000n);
    expect(gasKeyMin(1)).toBe((31n * NEAR) / 100n);
    expect(gasKeyMin(2)).toBe((16n * NEAR) / 100n);
  });

  test("revoking sends no delete_key unless asked, so v1 gets the request it always got", () => {
    expect(ownerActions.revokeSession("ed25519:K")).toEqual({ revoke_session: { public_key: "ed25519:K" } });
    expect(ownerActions.revokeSession("ed25519:K", true)).toEqual({ revoke_session: { public_key: "ed25519:K", delete_key: true } });
  });

  test("v2's refusals read as plain words", () => {
    for (const reason of ["attach at least 120 Tgas", "mark is for another asset", "a session key cannot change type; revoke and delete it first", "this key is a gas key", "daily gas top-up cap exceeded", "not enough NEAR on the account", "too many sessions", "graduation in progress", "zero amount", "not a gas key", "stale mark"]) {
      const text = describeReason(reason);
      expect(text).not.toBe(`${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`);
      expect(text).not.toContain("two minutes");
    }
  });
});
