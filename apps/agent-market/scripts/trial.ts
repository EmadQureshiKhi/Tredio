/**
 * A trial hire on testnet terms, end to end, without the live market (it has no testnet):
 *
 *   1. the stand-in market (scripts/standin.ts) serves the agent's A2A host and worker API,
 *   2. the worker runs as in production, its own process (`bun src/index.ts`) pointed at it,
 *   3. a caller reads the agent card, gets the 402 quote, signs one `ft_transfer` of test USDC as
 *      a NEP-366 delegate action (x402 `exact` on near:testnet) and calls again with X-PAYMENT,
 *   4. the stand-in opens the hire and sends the signed hire.created webhook; the worker starts
 *      and delivers; at delivery the facilitator's relayer submits the payment on NEAR testnet,
 *   5. the caller reads the answer, and the transfer is confirmed in the transaction's receipts.
 *
 *   TRIAL_RELAYER=<testnet account> bun scripts/trial.ts ["topic"]
 *
 * TRIAL_PAYER (default: the deployment's root account) pays and needs test USDC (the token's
 * faucet tops it up) and a full-access key; TRIAL_RELAYER submits the payment and pays its gas,
 * and must not be the payer. Keys come from <ACCOUNT>_KEY or ~/.near-credentials/testnet.
 * The worker reads BACKEND_URL (default http://localhost:4000). Testnet USDC has no value.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { createPaymentPayload, type PaymentRequired } from "@tredio/chain";
import { calls, explorerTx, fromRaw } from "@tredio/contracts";
import type { FinalExecutionOutcome } from "near-kit";
import { D, keyOf, senderFor, testnetOnly, viewer } from "../../../scripts/lib/network";
import { parseDeliverable } from "../src/result";
import { createStandin, nearFacilitator, newAgentToken, type Task, transferred } from "./standin";

testnetOnly("the agent-market trial");

const fail = (why: string): never => {
  console.error(`trial failed: ${why}`);
  process.exit(1);
};
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const TOPIC = process.argv.slice(2).join(" ").trim() || "Godzilla Minus Zero";
const PAYER = process.env.TRIAL_PAYER ?? D.root;
const RELAYER = process.env.TRIAL_RELAYER ?? fail("set TRIAL_RELAYER to a testnet account with a little NEAR and a key in ~/.near-credentials/testnet (not the payer)");
if (RELAYER === PAYER) fail("the relayer submits the payer's transfer and cannot be the payer");
const PRICE = process.env.PRICE_USDC ?? "0.05";
const STANDIN_PORT = Number(process.env.STANDIN_PORT ?? 4890);
const WORKER_PORT = Number(process.env.TRIAL_WORKER_PORT ?? 4891);
const BASE = `http://localhost:${STANDIN_PORT}`;
const token = newAgentToken();
const secret = randomBytes(24).toString("hex");
const usdcOf = (account: string) => viewer.view<string>(D.contracts.usdc, "ft_balance_of", { account_id: account }).then(BigInt);

// 1. The stand-in market, settling through a real relayer on NEAR testnet.
const standin = createStandin({
  token,
  agent: { agentId: randomUUID(), handle: "tredio", name: "Tredio attention check", description: "Attention index for any topic, with its sources, registry checkpoint and NEAR AI review", tags: ["attention", "near"] },
  plan: { priceAmount: PRICE, slaSeconds: 120 },
  payment: { network: "near:testnet", asset: D.contracts.usdc, payTo: D.treasury },
  facilitator: nearFacilitator({ viewer, relayer: senderFor(RELAYER) }),
  baseUrl: BASE,
  webhook: { url: `http://localhost:${WORKER_PORT}/market/webhook`, secret },
  log: (f, m) => log(`[market] ${m}`, JSON.stringify(f)),
});
const market = Bun.serve({ port: STANDIN_PORT, fetch: standin.app.fetch, idleTimeout: 120 });
log(`stand-in market on ${BASE}: ${PRICE} USDC a call, paid to ${D.treasury} in ${D.contracts.usdc}, settled by ${RELAYER}`);

// 2. The worker, as it runs in production.
const worker = Bun.spawn(["bun", "src/index.ts"], {
  cwd: join(import.meta.dir, ".."),
  env: { ...process.env, PORT: String(WORKER_PORT), NEAR_NETWORK: "testnet", MARKET_URL: BASE, MARKET_API_TOKEN: token, MARKET_WEBHOOK_SECRET: secret, PRICE_USDC: PRICE, POLL_INTERVAL_SEC: "15" },
  stdout: "pipe",
  stderr: "pipe",
});
const pipe = async (stream: ReadableStream<Uint8Array>) => {
  const decoder = new TextDecoder();
  for await (const chunk of stream) for (const line of decoder.decode(chunk).split("\n")) if (line.trim()) log(`[worker] ${line.slice(0, 400)}`);
};
void pipe(worker.stdout);
void pipe(worker.stderr);
const stop = (code: number): never => {
  worker.kill();
  market.stop(true);
  process.exit(code);
};
for (let i = 0; ; i++) {
  if (await fetch(`http://localhost:${WORKER_PORT}/live`).then((r) => r.ok).catch(() => false)) break;
  if (i > 50) stop(1);
  await Bun.sleep(200);
}

try {
  // 3. The caller: the card, the quote, the payment.
  const card = (await (await fetch(`${BASE}/.well-known/agent-card.json`)).json()) as { name: string; supportedInterfaces: Array<{ url: string }> };
  const a2a = card.supportedInterfaces[0]!.url;
  log(`card: ${card.name} at ${a2a}`);
  const message = (text: string) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { messageId: randomUUID(), role: "ROLE_USER", parts: [{ text }] }, configuration: { historyLength: 0 } } });
  const text = `Attention check: ${TOPIC}`;
  const quote = await fetch(a2a, { method: "POST", headers: { "content-type": "application/json" }, body: message(text) });
  if (quote.status !== 402) fail(`expected 402, got ${quote.status}`);
  const required = (await quote.json()) as PaymentRequired & { error: string };
  const row = required.accepts[0] ?? fail("the 402 offers no payment");
  log(`402 (${required.error}): pay ${fromRaw(row.amount, 6)} USDC (${row.asset}) to ${row.payTo} on ${row.network}, valid ${row.maxTimeoutSeconds} s`);
  let balance = await usdcOf(PAYER);
  if (balance < BigInt(row.amount)) {
    const drip = await senderFor(PAYER).send(calls(D).usdc.faucet());
    for (let i = 0; i < 30 && balance < BigInt(row.amount); i++) {
      await Bun.sleep(1000);
      balance = await usdcOf(PAYER);
    }
    log(`faucet: ${PAYER} drew test USDC (${explorerTx("testnet", drip.hash)})`);
  }
  const [payerBefore, payeeBefore] = [balance, await usdcOf(row.payTo)];
  const payment = await createPaymentPayload({ signer: { accountId: PAYER, privateKey: keyOf(PAYER) }, rpc: viewer, requirements: row });
  log(`${PAYER} signed one ft_transfer of ${row.amount} to ${row.payTo} as a delegate action; calling again with X-PAYMENT`);

  // 4. The paid call: the market opens the hire and holds the call while the worker answers.
  const started = Date.now();
  const paid = await fetch(a2a, { method: "POST", headers: { "content-type": "application/json", "X-PAYMENT": Buffer.from(JSON.stringify(payment)).toString("base64") }, body: message(text) });
  if (paid.status !== 200) fail(`the paid call answered ${paid.status}: ${await paid.text()}`);
  let task = ((await paid.json()) as { result: { task: Task } }).result.task;
  for (let i = 0; i < 30 && (task.status.state === "TASK_STATE_SUBMITTED" || task.status.state === "TASK_STATE_WORKING"); i++) {
    await Bun.sleep(10_000);
    task = ((await (await fetch(a2a, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: task.id, historyLength: 0 } }) })).json()) as { result: Task }).result;
  }
  if (task.status.state !== "TASK_STATE_COMPLETED") fail(`the task ended ${task.status.state}: ${JSON.stringify(task.status)}`);
  const result = parseDeliverable(task.artifacts![0]!.parts[0]!.text);
  log(`task ${task.id} completed in ${((Date.now() - started) / 1000).toFixed(1)} s`);

  // 5. The payment on chain: the relayer's transaction carries the payer's transfer to the payee.
  const s = standin.settlements[0] ?? fail("no settlement recorded");
  const tx = await viewer.rpc<FinalExecutionOutcome>("EXPERIMENTAL_tx_status", { tx_hash: s.transaction, sender_account_id: RELAYER, wait_until: "FINAL" });
  if (!transferred(tx, { asset: row.asset, payTo: row.payTo, amount: row.amount, payer: PAYER })) fail(`no matching ft_transfer in ${s.transaction}`);
  const [payerAfter, payeeAfter] = [await usdcOf(PAYER), await usdcOf(row.payTo)];
  const record = {
    topic: TOPIC,
    task: { id: task.id, state: task.status.state },
    answer: {
      identifier: result.topic.identifier,
      index: result.index?.now ?? null,
      change24h: result.index?.change24h ?? null,
      sources: result.sources.filter((x) => x.counted).map((x) => `${x.source} ${x.points}`),
      checkpoint: result.onChain?.checkpoint ?? null,
      oracleReport: result.onChain?.oracleReport ? { verified: result.onChain.oracleReport.verified, transaction: result.onChain.oracleReport.transaction } : null,
      review: result.review ? { hash: result.review.hash, verified: result.review.verified } : null,
    },
    payment: { transaction: s.transaction, explorer: explorerTx("testnet", s.transaction), payer: PAYER, relayer: tx.transaction?.signer_id, payTo: row.payTo, asset: row.asset, amount: fromRaw(row.amount, 6), payerUsdc: [fromRaw(payerBefore, 6), fromRaw(payerAfter, 6)], payeeUsdc: [fromRaw(payeeBefore, 6), fromRaw(payeeAfter, 6)] },
  };
  log(`on chain: ${PAYER} -> ${row.payTo} ${fromRaw(row.amount, 6)} USDC, submitted by ${tx.transaction?.signer_id}: ${explorerTx("testnet", s.transaction)}`);
  console.log(JSON.stringify(record, null, 2));
  stop(0);
} catch (e) {
  console.error(e);
  stop(1);
}
