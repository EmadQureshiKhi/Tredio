/**
 * Checks Tredio's claims against NEAR itself, then runs the test suites.
 *
 *   pnpm verify                 chain checks and tests
 *   pnpm verify --chain-only    chain checks only (no Rust or Postgres needed)
 *   pnpm verify --build         also rebuild the oracle's enclave program and print its sha256
 *
 * Read-only: it sends no transaction and needs no key. NEAR_NETWORK picks the network (testnet),
 * TREDIO_API_URL the API to ask (https://api.tredio.bid, then http://localhost:4000).
 * Backend tests run only when TEST_DATABASE_URL points at a Postgres test database.
 * Exits 1 when any check fails.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RPCS, Viewer } from "@tredio/chain";
import { accountCodeHashes, deployment, type Network } from "@tredio/contracts";

const ROOT = join(import.meta.dir, "..");
const NETWORK = (process.env.NEAR_NETWORK ?? "testnet") as Network;
const D = deployment(NETWORK);
const proofs = JSON.parse(readFileSync(join(ROOT, `deployments/${NETWORK}-proofs.json`), "utf8")) as {
  passkeyAccounts: string[];
  chainSignaturesOrder: { tx: string; sender: string };
  outlayerRun: { tx: string; project: string; attestations: string };
  x402Payment: { tx: string; relayer: string; payer: string; amount: string };
};
const args = new Set(process.argv.slice(2));
const viewer = new Viewer(NETWORK, DEFAULT_RPCS[NETWORK]);
const nowSec = () => Math.floor(Date.now() / 1000);

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

async function apiUrl(): Promise<string | null> {
  const candidates = process.env.TREDIO_API_URL ? [process.env.TREDIO_API_URL] : ["https://api.tredio.bid", "http://localhost:4000"];
  for (const url of candidates) {
    const live = await fetch(`${url}/live`, { signal: AbortSignal.timeout(4_000) }).catch(() => null);
    if (live?.ok) return url;
  }
  return null;
}

async function chain() {
  console.log(`\nOn NEAR ${NETWORK}`);
  const S = "chain";

  await check(S, "Contracts deployed", async () => {
    const entries = Object.entries(D.contracts);
    const missing: string[] = [];
    for (const [, account] of entries) {
      const a = await viewAccount(account).catch(() => null);
      if (!a || (a.code_hash === EMPTY_CODE && !a.global_contract_hash)) missing.push(account);
    }
    return missing.length ? fail(`no code on ${missing.join(", ")}`) : ok(`${entries.length} of ${entries.length} accounts hold code`);
  });

  await check(S, "Account code is one global contract", async () => {
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
    return ok(`${mode} ${cfg.public_key.slice(0, 18)}... (matches deployments)`);
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
    const r = await fetch(`${proofs.outlayerRun.attestations}${proofs.outlayerRun.tx}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return fail(`attestation lookup answered ${r.status}`);
    const a = (await r.json()) as { project_id?: string; wasm_hash?: string; executed_wasm_sha256?: string; tdx_quote?: string };
    if (a.project_id !== proofs.outlayerRun.project) return fail(`attested project is ${a.project_id}`);
    if (!a.tdx_quote || a.wasm_hash !== a.executed_wasm_sha256) return fail("attestation without a TDX quote or with a different executed hash");
    return ok(`${a.project_id}, TDX quote over wasm ${a.wasm_hash?.slice(0, 12)}...`);
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
      const hash = /^([0-9a-f]{64})\s/m.exec(p.stdout.toString())?.[1];
      return hash ? ok(`sha256 ${hash}`) : fail(p.stderr.toString().trim().split("\n").pop() ?? "build failed");
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
