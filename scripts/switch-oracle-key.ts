/**
 * Moves the registry from the bootstrap report key to the enclave's key, in one step, after
 * checking the enclave can do the job. The first step after hosting the API (internal/PLAN.md).
 *
 *   bun scripts/switch-oracle-key.ts               check only: nothing is sent
 *   bun scripts/switch-oracle-key.ts --send        check, then set_oracle, then point the oracle at the enclave
 *   bun scripts/switch-oracle-key.ts --rollback    set the bootstrap key back (and ORACLE_MODE=local)
 *
 * Checks, all of which must pass before --send changes anything:
 * 1. The API compiled into the enclave build (https://api.tredio.bid, or --api) answers.
 * 2. One live run of the build on OutLayer (about 0.0013 NEAR, paid by the oracle account) returns a
 *    report signed by the expected key (--key, else the key recorded in deployments/<network>-proofs.json)
 *    that measured at least one trend: a run with only marks means the enclave got no readings.
 * Then --send calls set_oracle as the registry owner (one yoctoNEAR: the owner's full-access key from
 * ~/.near-credentials/<network>), reads the key back, records it in deployments/<network>.json and sets
 * ORACLE_MODE=outlayer in apps/oracle/.env (or --env). Restart the oracle afterwards.
 * NEAR_NETWORK picks the network (testnet unless set).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58Decode, base58Encode } from "@tredio/chain";
import { OutLayerRunner } from "../apps/oracle/src/outlayer";
import { judgeRun, setEnv, teeSigner } from "../apps/oracle/src/switch";
import { D, NETWORK, senderFor, viewer } from "./lib/network";

const ROOT = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const envPath = option("--env") ?? join(ROOT, "apps/oracle/.env");
const env = Object.fromEntries(
  (existsSync(envPath) ? readFileSync(envPath, "utf8") : "")
    .split("\n")
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [m[1]!, m[2]!]),
);
const proofsFile = join(ROOT, `deployments/${NETWORK}-proofs.json`);
const recordedKey = existsSync(proofsFile) ? (JSON.parse(readFileSync(proofsFile, "utf8")) as { outlayerRun?: { enclavePublicKey?: string } }).outlayerRun?.enclavePublicKey : undefined;

const say = (ok: boolean | null, text: string) => console.log(`  ${ok === null ? "    " : ok ? "ok  " : "FAIL"}  ${text}`);
const trusted = async () => (await viewer.view<{ tee_signer?: { public_key: string } }>(D.contracts.registry, "get_oracle")).tee_signer?.public_key ?? null;

async function setOracle(publicKey: string) {
  const owner = senderFor(D.root);
  const { hash } = await owner.send({ receiverId: D.contracts.registry, methodName: "set_oracle", args: teeSigner(publicKey), deposit: "1", gas: (30n * 10n ** 12n).toString() });
  // Views lag a fresh transaction by a block or two.
  for (let i = 0; i < 10 && (await trusted()) !== publicKey; i++) await new Promise((r) => setTimeout(r, 1500));
  const now = await trusted();
  if (now !== publicKey) throw new Error(`set_oracle ${hash} sent, but the registry still trusts ${now}`);
  const file = join(ROOT, `deployments/${NETWORK}.json`);
  const deployment = JSON.parse(readFileSync(file, "utf8")) as { oracle: { publicKey: string } };
  deployment.oracle.publicKey = publicKey;
  writeFileSync(file, `${JSON.stringify(deployment, null, 2)}\n`);
  return hash;
}

console.log(`Oracle key on ${NETWORK}: registry ${D.contracts.registry}, owner ${D.root}`);
const current = await trusted();
say(null, `the registry trusts ${current}`);

if (flag("--rollback")) {
  const secret = env.REPORT_SIGNING_KEY;
  if (!secret) throw new Error(`no REPORT_SIGNING_KEY in ${envPath}: the bootstrap key is unknown`);
  const bootstrap = `ed25519:${base58Encode(ed25519.getPublicKey(base58Decode(secret.replace(/^ed25519:/, "")).slice(0, 32)))}`;
  if (current === bootstrap) {
    say(true, "the registry already trusts the bootstrap key");
    process.exit(0);
  }
  const hash = await setOracle(bootstrap);
  writeFileSync(envPath, setEnv(readFileSync(envPath, "utf8"), "ORACLE_MODE", "local"));
  say(true, `set_oracle ${hash}: the registry trusts the bootstrap key ${bootstrap} again; ORACLE_MODE=local in ${envPath}; restart the oracle`);
  process.exit(0);
}

const expected = option("--key") ?? recordedKey;
if (!expected) throw new Error("no enclave key: pass --key ed25519:... or record outlayerRun.enclavePublicKey in the proofs file");
if (current === expected) {
  say(true, "the registry already trusts the enclave's key");
  process.exit(0);
}
let ready = true;

// 1. The API the build reads.
const api = option("--api") ?? "https://api.tredio.bid";
const live = await fetch(`${api}/live`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.ok, () => false);
say(live, `the enclave's API ${api} ${live ? "answers" : "does not answer (host it first: the build reads it)"}`);
ready &&= live;

// 2. One live run of the build.
if (ready) {
  if (!env.OUTLAYER_WASM_URL || !env.OUTLAYER_WASM_HASH || !env.ORACLE_ACCOUNT_ID) throw new Error(`${envPath} needs OUTLAYER_WASM_URL, OUTLAYER_WASM_HASH and ORACLE_ACCOUNT_ID`);
  const contract = env.OUTLAYER_CONTRACT || (NETWORK === "mainnet" ? "outlayer.near" : "outlayer.testnet");
  const secrets = env.OUTLAYER_SECRETS_PROFILE && env.OUTLAYER_SECRETS_ACCOUNT ? { profile: env.OUTLAYER_SECRETS_PROFILE, account_id: env.OUTLAYER_SECRETS_ACCOUNT } : null;
  if (!secrets) say(false, "no OUTLAYER_SECRETS_PROFILE and OUTLAYER_SECRETS_ACCOUNT: the enclave has no API token");
  const runner = new OutLayerRunner(senderFor(env.ORACLE_ACCOUNT_ID), viewer, { contract, wasmUrl: env.OUTLAYER_WASM_URL, wasmHash: env.OUTLAYER_WASM_HASH, maxSeconds: Number(env.OUTLAYER_MAX_SECONDS || 60), secrets });
  const { output, tx } = await runner.run();
  const verdict = judgeRun(output, expected);
  say(verdict.ok, `enclave run ${tx ?? "(no transaction)"}: ${verdict.ok ? `measured ${verdict.measured} trends and ${verdict.marks} marks, signed by ${expected}` : verdict.problems.join("; ")}`);
  ready &&= verdict.ok && secrets !== null;
}

if (!ready) {
  console.log("\nNot switching: fix what failed above and run it again.");
  process.exit(1);
}
if (!flag("--send")) {
  console.log(`\nReady. Run with --send to make the registry trust ${expected}.`);
  process.exit(0);
}
const hash = await setOracle(expected);
writeFileSync(envPath, setEnv(readFileSync(envPath, "utf8"), "ORACLE_MODE", "outlayer"));
say(true, `set_oracle ${hash}: the registry trusts the enclave's key ${expected}, recorded in deployments/${NETWORK}.json`);
say(true, `ORACLE_MODE=outlayer in ${envPath}: restart the oracle so the enclave signs the next report (pnpm verify shows the key)`);
