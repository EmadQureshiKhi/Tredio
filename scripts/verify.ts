/**
 * Checks Tredio's claims against NEAR itself, then runs the test suites.
 *
 *   pnpm verify                 chain checks and tests
 *   pnpm verify --chain-only    chain checks only (no Rust or Postgres needed)
 *   pnpm verify --build         also rebuild the oracle's enclave program and require the attested run's sha256
 *   pnpm verify --rebuild       also make the reproducible contract builds the chain names (Docker; minutes each)
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
import { base58Decode, base58Encode, rpcEndpoints, Viewer } from "@tredio/chain";
import { accountCodeHashes, deployment, type Network } from "@tredio/contracts";
import { CUSTODY_CONTRACT, custodyKeyOf, nearKeyOf } from "@tredio/custody";

const ROOT = join(import.meta.dir, "..");
const NETWORK = (process.env.NEAR_NETWORK ?? "testnet") as Network;
const D = deployment(NETWORK);
const PROOFS_FILE = join(ROOT, `deployments/${NETWORK}-proofs.json`);
/** What a check proves from a recorded transaction; a network without the file (#mainnet before its first runs) skips those checks. */
const recorded = (existsSync(PROOFS_FILE) ? JSON.parse(readFileSync(PROOFS_FILE, "utf8")) : null) as {
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
  curationClaim: { tx: string; account: string; amount: string };
  signals: { leaderIdentity: string; leaderAccount: string; follower: string; commitTx: string; commitment: string; accessTx: string; relayer: string; price: string };
  settledSeries: { series: number; trend: string; window: number; openTx: string; settleTx: string; keeper: string };
  graduation: { trend: string; pool: number; keeper: string; steps: string[] };
  policyWallet: { account: string; wallet: string; relayer: string; setupTx: string; sessionCallTx: string; freezeTx: string; unfreezeTx: string };
} | null;
class NoProofs extends Error {}
const proofs = new Proxy({} as NonNullable<typeof recorded>, {
  get: (_, key) => {
    if (!recorded) throw new NoProofs();
    return recorded[key as keyof typeof recorded];
  },
});
const args = new Set(process.argv.slice(2));
const FASTNEAR_KEYS = (process.env.FASTNEAR_API_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
const viewer = new Viewer(NETWORK, rpcEndpoints(NETWORK, [], FASTNEAR_KEYS));
/** Recorded transactions age out of regular nodes after about five epochs (2.5 days); FastNEAR's archival nodes keep them. */
const ARCHIVAL_RPC: Record<Network, string> = { testnet: "https://archival-rpc.testnet.fastnear.com", mainnet: "https://archival-rpc.mainnet.fastnear.com" };
const archive = new Viewer(NETWORK, [...FASTNEAR_KEYS.map((key) => ({ url: ARCHIVAL_RPC[NETWORK], headers: { authorization: `Bearer ${key}` } })), { url: ARCHIVAL_RPC[NETWORK] }]);
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
    r = e instanceof NoProofs ? skip(`no deployments/${NETWORK}-proofs.json yet`) : fail(String((e as Error).message ?? e).slice(0, 160));
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

  // A block explorer's "verified source", checked here. NEAR's code hash is the sha256 of the wasm. Code from a
  // reproducible build (SourceScan's pinned Docker image) records this repository and its commit (NEP-330): its
  // contract's source must be unchanged since that commit, and it must hash like `scripts/build.sh --reproducible
  // <commit>`. Code deployed from a local build (testnet's global code) must hash like `pnpm build:contracts`, which
  // needs the toolchain SECURITY.md records. #mainnet: Circle's USDC is not Tredio's code and is left out.
  await check(S, "Deployed code is this source", async () => {
    const repo = /^repository = "(.*)"$/m.exec(readFileSync(join(ROOT, "contracts/Cargo.toml"), "utf8"))?.[1] ?? "";
    const ownUsdc = D.contracts.usdc.endsWith(`.${D.root}`);
    const code = async (item: { account?: string; hash?: string }) => {
      const r = item.account
        ? await viewer.rpc<{ code_base64: string; hash: string }>("query", { request_type: "view_code", finality: "final", account_id: item.account })
        : await viewer.rpc<{ code_base64: string }>("query", { request_type: "view_global_contract_code", finality: "final", code_hash: item.hash });
      const bytes = Buffer.from(r.code_base64, "base64");
      return { hash: base58Encode(createHash("sha256").update(bytes).digest()), rev: new RegExp(`git\\+${repo.replace(/[.?]/g, "\\$&")}\\?rev=([0-9a-f]{40})`).exec(bytes.toString("latin1"))?.[1] ?? null };
    };
    const items = [
      ...Object.entries(D.contracts)
        .filter(([role]) => role !== "usdc" || ownUsdc)
        .map(([crate, account]) => ({ name: crate, crate, account })),
      { name: "coin (global)", crate: "coin", hash: D.globalCode.coin },
      { name: `account v${D.globalCode.accountV2 ? 2 : 1} (global)`, crate: "account", hash: D.globalCode.accountV2 ?? D.globalCode.account },
    ];
    const git = (...a: string[]) => run(["git", ...a], ".");
    const local = (crate: string) => join(ROOT, "contracts/target/near", `tredio_${crate}`, `tredio_${crate}.wasm`);
    const reproducible = (rev: string, crate: string) => join(ROOT, "contracts/target/near-reproducible", rev, `tredio_${crate}.wasm`);
    const sha = (file: string) => base58Encode(createHash("sha256").update(readFileSync(file)).digest());
    const problems: string[] = [];
    const unbuilt: string[] = [];
    const revs = new Set<string>();
    let matched = 0;
    for (const item of items) {
      const onChain = await code(item);
      let file = local(item.crate);
      if (onChain.rev) {
        revs.add(onChain.rev);
        if (git("cat-file", "-e", `${onChain.rev}^{commit}`).code !== 0) {
          problems.push(`${item.name} was built from ${onChain.rev.slice(0, 12)}, which this checkout does not have`);
          continue;
        }
        const source = [`contracts/${item.crate}`, "contracts/common", "contracts/Cargo.toml", "contracts/Cargo.lock", "contracts/rust-toolchain.toml"];
        if (git("diff", "--quiet", onChain.rev, "--", ...source).code !== 0) problems.push(`${item.name}'s source changed since ${onChain.rev.slice(0, 12)}`);
        file = reproducible(onChain.rev, item.crate);
        if (!existsSync(file) && args.has("--rebuild")) run(["bash", "contracts/scripts/build.sh", "--reproducible", onChain.rev], ".");
      }
      if (!existsSync(file)) {
        unbuilt.push(onChain.rev ? `${item.name} (build.sh --reproducible ${onChain.rev.slice(0, 12)})` : `${item.name} (pnpm build:contracts)`);
        continue;
      }
      if (sha(file) === onChain.hash) matched++;
      else problems.push(`${item.name} ${onChain.hash.slice(0, 10)}... differs from its ${onChain.rev ? "reproducible" : "local"} build ${sha(file).slice(0, 10)}...`);
    }
    if (problems.length) return fail(problems.join("; "));
    const how = `${[...revs].map((r) => `reproducible builds of ${r.slice(0, 12)}`).join(", ")}${revs.size ? " and " : ""}local builds`;
    if (unbuilt.length) return skip(`${matched} of ${items.length} match; not built: ${unbuilt.join(", ")}, or run with --rebuild`);
    return ok(`${items.length} of ${items.length} hash like their ${how}, byte for byte`);
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
    const o = await archive.rpc<Outcome>("EXPERIMENTAL_tx_status", { tx_hash: tx, sender_account_id: sender, wait_until: "NONE" });
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
    const o = await archive.rpc<Outcome>("EXPERIMENTAL_tx_status", { tx_hash: settleTx, sender_account_id: keeper, wait_until: "NONE" });
    if (s.outcome === "open" || !settlement.finalized || !("SuccessValue" in o.status)) return fail(`series ${series}: outcome ${s.outcome}, settlement finalized ${settlement.finalized}`);
    return ok(`series ${series} (${trend}) settled ${s.outcome} at ${(settlement.value / 1e6).toFixed(2)} by ${settleTx.slice(0, 10)}...`);
  });

  await check(S, "A trend coin graduated into Rhea", async () => {
    const { trend, pool, steps, keeper } = proofs.graduation;
    const c = await viewer.view<{ coin: string; stage: string; pool_id: number | null }>(D.contracts.coins, "get_curve", { trend });
    if (c.stage !== "graduated" || c.pool_id !== pool) return fail(`${trend}: stage ${c.stage}, pool ${c.pool_id}`);
    const p = await viewer.view<{ token_account_ids: string[]; amounts: string[] }>(D.external.exchange, "get_pool", { pool_id: pool });
    const usdc = p.amounts[p.token_account_ids.indexOf(D.contracts.usdc)];
    if (!p.token_account_ids.includes(c.coin) || !usdc || BigInt(usdc) === 0n) return fail(`pool ${pool} on ${D.external.exchange} does not hold ${c.coin} and USDC`);
    for (const tx of steps) {
      const o = await archive.rpc<Outcome>("EXPERIMENTAL_tx_status", { tx_hash: tx, sender_account_id: keeper, wait_until: "NONE" });
      if (!("SuccessValue" in o.status)) return fail(`graduation step ${tx.slice(0, 10)}... failed`);
    }
    return ok(`${trend}: pool ${pool} on ${D.external.exchange} holds ${(Number(usdc) / 1e6).toFixed(2)} USDC and the coin, in ${steps.length} keeper steps`);
  });

  await check(S, "x402 payment settled in USDC on NEAR", async () => {
    const { tx, relayer, payer, amount } = proofs.x402Payment;
    const o = await archive.rpc<Outcome>("EXPERIMENTAL_tx_status", { tx_hash: tx, sender_account_id: relayer, wait_until: "NONE" });
    const transfer = events(o).find((e) => e.standard === "nep141" && e.event === "ft_transfer");
    const data = (Array.isArray(transfer?.data) ? transfer.data[0] : transfer?.data) as { old_owner_id?: string; new_owner_id?: string; amount?: string } | undefined;
    if (!data || data.old_owner_id !== payer || data.new_owner_id !== D.treasury || data.amount !== amount) return fail(`${tx}: no ft_transfer of ${amount} from ${payer} to ${D.treasury}`);
    return ok(`${tx.slice(0, 10)}...: ${Number(amount) / 1e6} USDC from ${payer} to ${D.treasury}, a delegate action ${relayer} submitted`);
  });

  await check(S, "Curation reward claimed by its surfacer", async () => {
    const { tx, account, amount } = proofs.curationClaim;
    // A session gas key sends from the account itself.
    const o = await archive.rpc<Outcome>("EXPERIMENTAL_tx_status", { tx_hash: tx, sender_account_id: account, wait_until: "NONE" });
    const claimed = events(o).find((e) => e.standard === "tredio-curation" && e.event === "claimed");
    const paid = events(o)
      .filter((e) => e.standard === "nep141" && e.event === "ft_transfer")
      .flatMap((e) => (Array.isArray(e.data) ? e.data : [e.data]) as Array<{ old_owner_id?: string; new_owner_id?: string; amount?: string }>)
      .find((t) => t.old_owner_id === D.contracts.curation && t.new_owner_id === account && t.amount === amount);
    if (!claimed || !paid) return fail(`${tx}: no claimed event and transfer of ${amount} from ${D.contracts.curation} to ${account}`);
    return ok(`${tx.slice(0, 10)}...: ${Number(amount) / 1e6} USDC from ${D.contracts.curation} to the surfacer, through its session key`);
  });

  await check(S, "Paid signal committed and bought", async () => {
    const p = proofs.signals;
    const transferOf = async (tx: string) => {
      const o = await archive.rpc<Outcome>("EXPERIMENTAL_tx_status", { tx_hash: tx, sender_account_id: p.relayer, wait_until: "NONE" });
      return events(o)
        .filter((e) => e.standard === "nep141" && e.event === "ft_transfer")
        .flatMap((e) => (Array.isArray(e.data) ? e.data : [e.data]) as Array<{ old_owner_id?: string; new_owner_id?: string; amount?: string; memo?: string }>);
    };
    const commit = (await transferOf(p.commitTx)).find((t) => t.old_owner_id === p.leaderAccount && t.new_owner_id === D.treasury && t.memo === `tredio-signal:${p.commitment}`);
    if (!commit) return fail(`${p.commitTx}: no transfer from ${p.leaderAccount} to ${D.treasury} with memo tredio-signal:${p.commitment}`);
    const paid = (await transferOf(p.accessTx)).find((t) => t.old_owner_id === p.follower && t.new_owner_id === p.leaderAccount && t.memo === `tredio-signals:${p.leaderIdentity}` && BigInt(t.amount ?? 0) >= BigInt(p.price));
    if (!paid) return fail(`${p.accessTx}: no payment of ${p.price} from ${p.follower} to ${p.leaderAccount} with memo tredio-signals:${p.leaderIdentity}`);
    return ok(`commitment ${p.commitTx.slice(0, 10)}... from the leader's account, then ${Number(p.price) / 1e6} USDC from a follower to the leader in ${p.accessTx.slice(0, 10)}...`);
  });

  await check(S, "Autopilot's policy wallet belongs to its passkey account", async () => {
    const p = proofs.policyWallet;
    const outlayer = CUSTODY_CONTRACT[NETWORK];
    const policy = await viewer.view<{ owner: string; frozen: boolean } | null>(outlayer, "get_wallet_policy", { wallet_pubkey: custodyKeyOf(p.wallet) });
    if (policy?.owner !== p.account) return fail(`${outlayer} names ${policy?.owner ?? "no one"} as the wallet's controller, not ${p.account}`);
    const session = await viewer.view<{ label: string; scope: { outcomes: boolean; perps: boolean; hyperliquid: boolean }; gas_key: boolean } | null>(p.account, "session", { public_key: nearKeyOf(p.wallet) }).catch(() => null);
    const setup = await archive.rpc<Outcome>("EXPERIMENTAL_tx_status", { tx_hash: p.setupTx, sender_account_id: p.relayer, wait_until: "NONE" });
    const stored = setup.receipts_outcome.some((r) => r.outcome.executor_id === outlayer && r.outcome.logs.some((l) => l.includes("WalletPolicyUpdated") && l.includes(p.account)));
    if (!stored) return fail(`${p.setupTx}: no WalletPolicyUpdated by ${p.account} on ${outlayer}`);
    const call = await archive.rpc<Outcome>("EXPERIMENTAL_tx_status", { tx_hash: p.sessionCallTx, sender_account_id: p.wallet, wait_until: "NONE" });
    if (call.transaction.signer_id !== p.wallet || call.transaction.receiver_id !== p.account) return fail(`${p.sessionCallTx}: not sent by the wallet to the account`);
    const live = session ? `a live ${session.label} session (${session.gas_key ? "gas key" : "plain key"}, Hyperliquid ${session.scope.hyperliquid ? "only" : "off"})` : "its session since ended";
    return ok(`controller ${p.account.slice(0, 10)}..., ${policy.frozen ? "frozen" : "not frozen"}; the enclave-signed session_call ${p.sessionCallTx.slice(0, 10)}... reached the account; ${live}`);
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
