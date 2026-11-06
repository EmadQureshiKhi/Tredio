/**
 * Checks Tredio's claims against NEAR itself, then runs the test suites.
 *
 *   pnpm verify                 chain checks and tests
 *   pnpm verify --chain-only    chain checks only (no Rust or Postgres needed)
 *   pnpm verify --build         also rebuild the oracle's enclave program and require the attested run's sha256
 *
 * Read-only: it sends no transaction and needs no key. NEAR_NETWORK picks the network (testnet),
 * TREDIO_API_URL the API to ask (https://api.tredio.bid, then http://localhost:4000).
 * Backend tests run only when TEST_DATABASE_URL points at a Postgres test database.
 * Exits 1 when any check fails.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58Decode, rpcEndpoints, Viewer } from "@tredio/chain";
import { accountCodeHashes, deployment, type Network } from "@tredio/contracts";

const ROOT = join(import.meta.dir, "..");
const NETWORK = (process.env.NEAR_NETWORK ?? "testnet") as Network;
const D = deployment(NETWORK);
const proofs = JSON.parse(readFileSync(join(ROOT, `deployments/${NETWORK}-proofs.json`), "utf8")) as {
  passkeyAccounts: string[];
  chainSignaturesOrder: { tx: string; sender: string };
  outlayerRun: {
    tx: string;
    project: string | null;
    caller: string;
    wasmSha256: string;
    toolchain: string;
    enclavePublicKey: string;
    /** The run's stdout as the enclave printed it; its sha256 is the attestation's output_hash. */
    enclaveOutput: { public_key: string; report_json: string; signature: string };
    attestations: string;
  };
  x402Payment: { tx: string; relayer: string; payer: string; amount: string };
  settledSeries: { series: number; trend: string; window: number; openTx: string; settleTx: string; keeper: string };
};
const args = new Set(process.argv.slice(2));
const viewer = new Viewer(NETWORK, rpcEndpoints(NETWORK, [], (process.env.FASTNEAR_API_KEYS ?? "").split(",")));
const nowSec = () => Math.floor(Date.now() / 1000);
const sha256 = (data: string) => createHash("sha256").update(data).digest();

type Result = { ok: boolean | null; detail: string };
const results: Array<{ section: string; name: string } & Result> = [];
const ok = (detail: string): Result => ({ ok: true, detail });
const fail = (detail: string): Result => ({ ok: false, detail });
const skip = (detail: string): Result => ({ ok: null, detail });

async function check(section: string, name: string, run: () => Promise<Result>) {
  let r: Result;
  try {
    r = await run();
  } catch (e) {
    r = fail(String((e as Error).message ?? e).slice(0, 160));
  }
  results.push({ section, name, ...r });
  const mark = r.ok === null ? "skip" : r.ok ? "ok  " : "FAIL";
  console.log(`  ${mark}  ${name.padEnd(46)} ${r.detail}`);
}

interface AccountView {
  code_hash: string;
  global_contract_hash?: string;
}
const viewAccount = (account: string) => viewer.rpc<AccountView>("query", { request_type: "view_account", finality: "final", account_id: account });
const EMPTY_CODE = "11111111111111111111111111111111";

interface Outcome {
  transaction: { signer_id: string; receiver_id: string };
  status: Record<string, unknown>;
  receipts_outcome: Array<{ outcome: { logs: string[]; executor_id: string } }>;
}
const events = (o: Outcome) =>
  o.receipts_outcome.flatMap((r) =>
    r.outcome.logs.filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice(11)) as { standard: string; event: string; data: unknown }),
  );

const PUBLIC_API = "https://api.tredio.bid";
const LOCAL_API = "http://localhost:4000";

async function apiUrl(): Promise<string | null> {
  const answers = async (url: string) => (await fetch(`${url}/live`, { signal: AbortSignal.timeout(4_000) }).catch(() => null))?.ok === true;
  if (process.env.TREDIO_API_URL) return (await answers(process.env.TREDIO_API_URL)) ? process.env.TREDIO_API_URL : null;
  if (await answers(PUBLIC_API)) return PUBLIC_API;
  console.log(`  warn  the public API ${PUBLIC_API} is unreachable; checking the local API ${LOCAL_API} instead (set TREDIO_API_URL to choose)`);
  return (await answers(LOCAL_API)) ? LOCAL_API : null;
}

async function chain() {
  console.log(`\nOn NEAR ${NETWORK}`);
  const S = "chain";

  await check(S, "Contracts deployed", async () => {
    const entries = Object.entries(D.contracts);
    const absent: string[] = [];
    const empty: string[] = [];
    for (const [, account] of entries) {
      let a: AccountView;
      try {
        a = await viewAccount(account);
      } catch (e) {
        // Only the node's UNKNOWN_ACCOUNT answer means the account is missing; a rate limit or an outage fails the check as itself.
        const message = String((e as Error).message ?? e);
        if (message.includes("UNKNOWN_ACCOUNT")) {
          absent.push(account);
          continue;
        }
        return fail(`could not read ${account}: ${message.slice(0, 120)}`);
      }
      if (a.code_hash === EMPTY_CODE && !a.global_contract_hash) empty.push(account);
    }
    const problems = [absent.length ? `no account ${absent.join(", ")}` : "", empty.length ? `no code on ${empty.join(", ")}` : ""].filter(Boolean);
    return problems.length ? fail(problems.join("; ")) : ok(`${entries.length} of ${entries.length} accounts hold code`);
  });

  await check(S, "Accounts run published global code", async () => {
    const [, , codeHash] = await viewer.view<[string, unknown, string, number]>(D.contracts.accounts, "config");
    if (codeHash !== D.globalCode.account) return fail(`factory uses ${codeHash}, deployments say ${D.globalCode.account}`);
    // Accounts are born on the factory's code (v1) and move to v2 with their passkey once deployments names it.
    const allowed = accountCodeHashes(D);
    let onV2 = 0;
    for (const account of proofs.passkeyAccounts) {
      const a = await viewAccount(account);
      if (!a.global_contract_hash || !allowed.includes(a.global_contract_hash)) return fail(`${account.slice(0, 10)}... runs ${a.global_contract_hash ?? a.code_hash}`);
      if (a.global_contract_hash === D.globalCode.accountV2) onV2++;
    }
    const n = proofs.passkeyAccounts.length;
    return ok(`${codeHash.slice(0, 10)}... on the factory and ${n - onV2} passkey accounts${D.globalCode.accountV2 ? `, v2 ${D.globalCode.accountV2.slice(0, 10)}... on ${onV2}` : ""}`);
  });

  await check(S, "Account ids derive from their passkeys", async () => {
    for (const account of proofs.passkeyAccounts) {
      const owner = await viewer.view<string>(account, "owner_key");
      const derived = await viewer.view<string>(D.contracts.accounts, "account_id_of", { owner_key: owner });
      if (derived !== account) return fail(`${account} has owner ${owner} but that key maps to ${derived}`);
      if (!owner.startsWith("p256:")) return fail(`${account} owner is not a P-256 passkey: ${owner}`);
    }
    return ok(`${proofs.passkeyAccounts.length} accounts, each owned by a P-256 passkey (owner_key -> account_id_of)`);
  });

  await check(S, "A passkey account trades on a session gas key", async () => {
    for (const account of proofs.passkeyAccounts) {
      const sessions = await viewer.view<Array<[string, { expires_at: number; label?: string; daily_limit?: string }]>>(account, "sessions");
      for (const [key, s] of sessions) {
        if (s.expires_at <= nowSec()) continue;
        const gas = await viewer.gasKey(account, key);
        if (gas) return ok(`${account.slice(0, 10)}... session "${s.label ?? "app"}", gas key with ${gas.nonces} lanes, expires in ${Math.round((s.expires_at - nowSec()) / 3600)} h`);
      }
    }
    return fail("no listed passkey account has an unexpired session on a gas key");
  });

  await check(S, "Registry trusts one oracle key", async () => {
    const o = await viewer.view<Record<string, { public_key: string }>>(D.contracts.registry, "get_oracle");
    const [mode, cfg] = Object.entries(o)[0] ?? [];
    if (!cfg) return fail("no oracle configured");
    if (cfg.public_key !== D.oracle.publicKey) return fail(`registry trusts ${cfg.public_key}, deployments say ${D.oracle.publicKey}`);
    const enclave = proofs.outlayerRun.enclavePublicKey;
    if (cfg.public_key === enclave) return ok(`${mode} ${cfg.public_key.slice(0, 18)}..., the enclave key of wasm ${proofs.outlayerRun.wasmSha256.slice(0, 12)}... (matches deployments)`);
    // Until the switch the registry trusts the bootstrap key the deploy script wrote to deployments; say so plainly.
    return ok(`bootstrap key ${cfg.public_key.slice(0, 18)}... (${mode}, matches deployments); enclave key ${enclave} recorded, not set yet`);
  });

  await check(S, "Index reports are recent", async () => {
    const last = await viewer.view<number>(D.contracts.registry, "last_run_id");
    const age = nowSec() - last;
    const text = age < 120 ? `${age} s ago` : `${Math.round(age / 60)} min ago`;
    return age <= 30 * 60 ? ok(`last accepted report ${text}`) : fail(`last accepted report ${text}; is the oracle running?`);
  });

  await check(S, "Live trends on chain", async () => {
    const trends = await viewer.view<Array<{ id: string; status: string; index: number }>>(D.contracts.registry, "get_trends", { from_index: 0, limit: 100 });
    const live = trends.filter((t) => t.status === "active" || t.status === "cooling");
    if (!live.length) return fail(`${trends.length} trends, none live`);
    const top = live.reduce((a, b) => (b.index > a.index ? b : a));
    return ok(`${live.length} live of ${trends.length}; ${top.id} at ${(top.index / 1e6).toFixed(2)}`);
  });

  await check(S, "Hyperliquid order signed by Chain Signatures", async () => {
    const { tx, sender } = proofs.chainSignaturesOrder;
    const o = await viewer.rpc<Outcome>("EXPERIMENTAL_tx_status", { tx_hash: tx, sender_account_id: sender, wait_until: "NONE" });
    const signed = events(o).find((e) => e.event === "hyperliquid_signed");
    const mpc = o.receipts_outcome.some((r) => r.outcome.executor_id === D.external.chainSignatures);
    if (!signed || !mpc) return fail(`${tx}: ${signed ? "" : "no hyperliquid_signed event "}${mpc ? "" : `no receipt on ${D.external.chainSignatures}`}`);
    return ok(`${tx.slice(0, 10)}... by ${o.transaction.signer_id.slice(0, 10)}..., signed through ${D.external.chainSignatures}`);
  });

  await check(S, "Oracle run attested by OutLayer", async () => {
    const run = proofs.outlayerRun;
    const r = await fetch(`${run.attestations}${run.tx}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return fail(`attestation lookup answered ${r.status}`);
    const a = (await r.json()) as {
      transaction_hash?: string;
      caller_account_id?: string;
      project_id?: string | null;
      wasm_hash?: string;
      executed_wasm_sha256?: string;
      output_hash?: string;
      tdx_quote?: string;
    };
    if (a.transaction_hash !== run.tx) return fail(`attestation is for tx ${a.transaction_hash}`);
    if (!a.tdx_quote) return fail("attestation without a TDX quote");
    if (a.wasm_hash !== run.wasmSha256 || a.executed_wasm_sha256 !== run.wasmSha256) return fail(`attested wasm ${a.wasm_hash} (executed ${a.executed_wasm_sha256}), recorded build ${run.wasmSha256}`);
    if ((a.project_id ?? null) !== run.project) return fail(`attested project ${a.project_id ?? "none"}, recorded ${run.project ?? "none"}`);
    if (a.caller_account_id !== run.caller) return fail(`requested by ${a.caller_account_id}, recorded ${run.caller}`);
    // The recorded output is what the enclave printed: it hashes to the attested output_hash, so the key and signature in it came from this run.
    if (sha256(JSON.stringify(run.enclaveOutput)).toString("hex") !== a.output_hash) return fail("the recorded enclave output does not hash to the attested output_hash");
    const out = run.enclaveOutput;
    if (out.public_key !== run.enclavePublicKey) return fail(`the run printed key ${out.public_key}, recorded ${run.enclavePublicKey}`);
    const signed = ed25519.verify(Buffer.from(out.signature, "base64"), sha256(out.report_json), base58Decode(out.public_key.replace(/^ed25519:/, "")));
    if (!signed) return fail("the run's report signature does not verify under the key it printed");
    return ok(`tx ${run.tx.slice(0, 10)}...: TDX quote over wasm ${run.wasmSha256.slice(0, 12)}... (the recorded build); its report verifies under ${run.enclavePublicKey.slice(0, 18)}...`);
  });

  await check(S, "An Up/Down series settled from the registry", async () => {
    const { series, trend, settleTx, keeper } = proofs.settledSeries;
    const s = await viewer.view<{ trend: string; expiry: number; outcome: string } | null>(D.contracts.outcomes, "get_series", { series });
    if (!s || s.trend !== trend) return fail(`series ${series} is not ${trend}`);
    const settlement = await viewer.view<{ finalized: boolean; value: number }>(D.contracts.registry, "settlement_of", { id: trend, expiry: s.expiry });
    const o = await viewer.rpc<Outcome>("EXPERIMENTAL_tx_status", { tx_hash: settleTx, sender_account_id: keeper, wait_until: "NONE" });
    if (s.outcome === "open" || !settlement.finalized || !("SuccessValue" in o.status)) return fail(`series ${series}: outcome ${s.outcome}, settlement finalized ${settlement.finalized}`);
    return ok(`series ${series} (${trend}) settled ${s.outcome} at ${(settlement.value / 1e6).toFixed(2)} by ${settleTx.slice(0, 10)}...`);
  });

  await check(S, "x402 payment settled in USDC on NEAR", async () => {
    const { tx, relayer, payer, amount } = proofs.x402Payment;
    const o = await viewer.rpc<Outcome>("EXPERIMENTAL_tx_status", { tx_hash: tx, sender_account_id: relayer, wait_until: "NONE" });
    const transfer = events(o).find((e) => e.standard === "nep141" && e.event === "ft_transfer");
    const data = (Array.isArray(transfer?.data) ? transfer.data[0] : transfer?.data) as { old_owner_id?: string; new_owner_id?: string; amount?: string } | undefined;
    if (!data || data.old_owner_id !== payer || data.new_owner_id !== D.treasury || data.amount !== amount) return fail(`${tx}: no ft_transfer of ${amount} from ${payer} to ${D.treasury}`);
    return ok(`${tx.slice(0, 10)}...: ${Number(amount) / 1e6} USDC from ${payer} to ${D.treasury}, a delegate action ${relayer} submitted`);
  });

  if (args.has("--build")) {
    await check(S, "Enclave build is reproducible", async () => {
      const p = Bun.spawnSync(["bash", "apps/oracle/tee/build.sh"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
      const out = p.stdout.toString();
      const hash = /^([0-9a-f]{64})\s/m.exec(out)?.[1];
      if (p.exitCode !== 0 || !hash) return fail(p.stderr.toString().trim().split("\n").pop() ?? "build failed");
      const toolchain = /^toolchain: (rustc [^,]+)/m.exec(out)?.[1] ?? "unknown rustc";
      const attested = proofs.outlayerRun.wasmSha256;
      return hash === attested ? ok(`sha256 ${hash.slice(0, 16)}... with ${toolchain}, the attested build`) : fail(`local build ${hash} with ${toolchain}, attested ${attested} (${proofs.outlayerRun.toolchain})`);
    });
  }

  const api = await apiUrl();
  await check(S, "NEAR AI review on a listed trend", async () => {
    const trends = await viewer.view<Array<{ id: string; review_hash: string | null }>>(D.contracts.registry, "get_trends", { from_index: 0, limit: 100 });
    const reviewed = trends.find((t) => t.review_hash);
    if (!reviewed) return skip("no trend listed from a NEAR AI review yet (testnet topics were added by hand)");
    if (!api) return skip(`${reviewed.id} carries review ${reviewed.review_hash!.slice(0, 12)}...; no API reachable to fetch it`);
    const r = await fetch(`${api}/v1/reviews/${reviewed.review_hash}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return fail(`${api}/v1/reviews answered ${r.status}`);
    const body = JSON.stringify(await r.json());
    return /provider_tee|signature/.test(body) ? ok(`${reviewed.id}: signed evidence served by the API`) : fail("review served without a signature");
  });

  await check(S, "API and services report healthy", async () => {
    if (!api) return skip("no API reachable (set TREDIO_API_URL)");
    const r = await fetch(`${api}/v1/status`, { signal: AbortSignal.timeout(10_000) });
    const s = (await r.json()) as { ok: boolean; services?: Array<{ name: string; ok: boolean }> };
    const down = (s.services ?? []).filter((x) => !x.ok).map((x) => x.name);
    return s.ok && !down.length ? ok(`${api}: ${(s.services ?? []).map((x) => x.name).join(", ")}`) : fail(`${api}: down ${down.join(", ") || "(status not ok)"}`);
  });
}

function run(cmd: string[], cwd: string, env: Record<string, string | undefined> = {}) {
  const p = Bun.spawnSync(cmd, { cwd: join(ROOT, cwd), env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

async function tests() {
  console.log("\nTests");
  const S = "tests";
  const workspace = (parent: string) =>
    readdirSync(join(ROOT, parent), { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(ROOT, parent, d.name, "package.json")))
      .map((d) => `${parent}/${d.name}`);
  for (const dir of [...workspace("packages"), ...workspace("apps"), "frontend"]) {
    await check(S, dir, async () => {
      const pkg = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      if (!pkg.scripts?.test) return skip("no tests");
      const r = run(["pnpm", "-s", "test"], dir);
      const pass = /(\d+) pass/.exec(r.out)?.[1];
      const failed = Number(/(\d+) fail/.exec(r.out)?.[1] ?? 0);
      return r.code === 0 && !failed ? ok(`${pass ?? "all"} pass`) : fail(`${failed} failed (exit ${r.code})`);
    });
  }
  await check(S, "backend", async () => {
    if (!process.env.TEST_DATABASE_URL) return skip("set TEST_DATABASE_URL to a Postgres test database to run");
    const r = run(["bun", "test", "test/"], "backend");
    const pass = /(\d+) pass/.exec(r.out)?.[1];
    const failed = Number(/(\d+) fail/.exec(r.out)?.[1] ?? 0);
    return r.code === 0 && !failed ? ok(`${pass} pass`) : fail(`${failed} failed`);
  });
  await check(S, "contracts (Rust unit tests)", async () => {
    if (run(["cargo", "--version"], "contracts").code !== 0) return skip("cargo not installed");
    const r = run(["cargo", "test", "--workspace", "--exclude", "tredio-sandbox-tests", "--exclude", "tredio-test-publisher"], "contracts");
    const passed = [...r.out.matchAll(/test result: ok\. (\d+) passed/g)].reduce((n, m) => n + Number(m[1]), 0);
    return r.code === 0 ? ok(`${passed} pass`) : fail(r.out.split("\n").find((l) => /FAILED|error/.test(l)) ?? `exit ${r.code}`);
  });
}

console.log(`Tredio verify: ${NETWORK}, contracts under ${D.root}`);
await chain();
if (!args.has("--chain-only")) await tests();
const failed = results.filter((r) => r.ok === false);
const skipped = results.filter((r) => r.ok === null);
console.log(`\n${results.length - failed.length - skipped.length} ok, ${failed.length} failed, ${skipped.length} skipped`);
process.exit(failed.length ? 1 : 0);
