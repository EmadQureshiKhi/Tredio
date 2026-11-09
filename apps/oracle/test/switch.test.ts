import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58Encode } from "@tredio/chain";
import { judgeRun, setEnv, teeSigner } from "../src/switch";

const seed = ed25519.utils.randomSecretKey();
const key = `ed25519:${base58Encode(ed25519.getPublicKey(seed))}`;
const signed = (report: unknown, by = seed) => {
  const report_json = JSON.stringify(report);
  const signature = Buffer.from(ed25519.sign(sha256(new TextEncoder().encode(report_json)), by)).toString("base64");
  return { report_json, signature, public_key: `ed25519:${base58Encode(ed25519.getPublicKey(by))}` };
};

describe("switching the registry to the enclave's key", () => {
  test("a run that measured trends, signed by the expected key, passes", () => {
    const v = judgeRun(signed({ run_id: 1, updates: [{ id: "topic:a", index: 1 }], new_trends: [], marks: [{ asset: "BTC" }] }), key);
    expect(v).toEqual({ ok: true, problems: [], measured: 1, marks: 1 });
  });

  test("a run with only marks means the enclave got no readings, so the switch would stall every trend", () => {
    const v = judgeRun(signed({ run_id: 1, updates: [], new_trends: [], marks: [{ asset: "BTC" }, { asset: "ETH" }] }), key);
    expect(v.ok).toBe(false);
    expect(v.problems.join(" ")).toMatch(/measured no trend \(only 2 marks\)/);
  });

  test("another key, a bad signature, an enclave error or no report all refuse", () => {
    const other = ed25519.utils.randomSecretKey();
    expect(judgeRun(signed({ updates: [{}] }, other), key).problems.join(" ")).toMatch(/signs with ed25519:.*, not/);
    const forged = { ...signed({ updates: [{}] }), report_json: JSON.stringify({ updates: [{}, {}] }) };
    expect(judgeRun(forged, key).problems.join(" ")).toMatch(/does not verify/);
    expect(judgeRun({ report_json: null, error: "Execution failed: timeout" }, key).problems).toEqual(["the enclave failed: Execution failed: timeout", "the enclave returned no signed report"]);
    expect(judgeRun({ ...signed({ updates: [{}] }), warnings: ["backend 401: unauthorized"] }, key).problems).toEqual(["enclave warning: backend 401: unauthorized"]);
  });

  test("set_oracle's argument and the service's .env", () => {
    expect(teeSigner(key)).toEqual({ oracle: { tee_signer: { public_key: key } } });
    expect(setEnv("A=1\nORACLE_MODE=local\nB=2\n", "ORACLE_MODE", "outlayer")).toBe("A=1\nORACLE_MODE=outlayer\nB=2\n");
    expect(setEnv("A=1", "ORACLE_MODE", "outlayer")).toBe("A=1\nORACLE_MODE=outlayer\n");
  });
});
