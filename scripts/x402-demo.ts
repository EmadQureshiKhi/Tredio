/**
 * x402 on NEAR testnet, end to end, as an agent pays for Tredio's API:
 *   1. ask for a paid resource and get 402 with the payment requirements (PAYMENT-REQUIRED),
 *   2. draw test USDC from the token's faucet when the payer has too little,
 *   3. sign a delegate action for one ft_transfer (no NEAR needed) and repeat the request with it
 *      in PAYMENT-SIGNATURE; the API's relayer submits it and pays the gas,
 *   4. get the data with PAYMENT-RESPONSE and confirm the transfer on chain,
 *   5. pay for a rule backtest the short way, with x402Fetch.
 *
 *   X402_API=http://localhost:4010 bun scripts/x402-demo.ts [trend]
 *
 * The payer is X402_PAYER (default tredio.testnet), its key from <ACCOUNT>_KEY or
 * ~/.near-credentials/testnet. Testnet USDC has no value.
 */
import { calls, explorerTx, fromRaw, parseEvents } from "@tredio/contracts";
import { createPaymentPayload, decodeHeader, encodeHeader, type PaymentRequired, type SettlementResponse, X402_HEADERS, x402Fetch } from "@tredio/chain";
import type { FinalExecutionOutcome } from "near-kit";
import { D, keyOf, senderFor, viewer } from "./lib/testnet";

const API = (process.env.X402_API ?? "http://localhost:4000").replace(/\/+$/, "");
const PAYER = process.env.X402_PAYER ?? "tredio.testnet";
const signer = { accountId: PAYER, privateKey: keyOf(PAYER) };
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const usdcOf = (account: string) => viewer.view<string>(D.contracts.usdc, "ft_balance_of", { account_id: account }).then(BigInt);
function fail(why: string): never {
  console.error(`x402 demo failed: ${why}`);
  process.exit(1);
}

// The paid resources and who is paid.
const info = (await (await fetch(`${API}/v1/x402`)).json()) as { enabled: boolean; payTo: string; relayers: string[]; resources: Array<{ method: string; path: string; usdc: string }> };
if (!info.enabled) fail(`${API} has no x402 relayer configured (X402_RELAYER_ACCOUNT, X402_RELAYER_KEY)`);
log("paid resources:", info.resources.map((r) => `${r.method} ${r.path} (${r.usdc} USDC)`).join(", "), "| payee", info.payTo, "| relayer", info.relayers.join(", "));
const trend = process.argv[2] ?? ((await (await fetch(`${API}/v1/trends`)).json()) as { trends: Array<{ identifier: string }> }).trends[0]?.identifier ?? fail("no live trend");
const url = `${API}/v1/x402/trends/${encodeURIComponent(trend)}/history`;

// 1. Unpaid: 402 and the requirements.
const unpaid = await fetch(url);
if (unpaid.status !== 402) fail(`expected 402, got ${unpaid.status}`);
const required = decodeHeader<PaymentRequired>(unpaid.headers.get(X402_HEADERS.required) ?? fail("no PAYMENT-REQUIRED header"));
const req = required.accepts[0] ?? fail("no payment option");
log(`1. GET ${url} -> 402: pay ${fromRaw(req.amount, 6)} USDC (${req.asset}) to ${req.payTo} on ${req.network}, within ${req.maxTimeoutSeconds}s`);

// 2. Funds: the payer needs the token, not NEAR.
let balance = await usdcOf(PAYER);
if (balance < BigInt(req.amount)) {
  const drip = await senderFor(PAYER).send(calls(D).usdc.faucet());
  // The server checks the balance at a final block, a block or two behind the faucet's.
  for (let i = 0; i < 30 && balance < BigInt(req.amount); i++) {
    await Bun.sleep(1000);
    balance = await usdcOf(PAYER);
  }
  log(`2. faucet: ${PAYER} drew test USDC (${explorerTx("testnet", drip.hash)}); balance ${fromRaw(balance, 6)} USDC`);
} else {
  log(`2. ${PAYER} holds ${fromRaw(balance, 6)} USDC`);
}
const payeeBefore = await usdcOf(req.payTo);

// 3. Sign one ft_transfer as a delegate action and repeat the request with it.
const payment = await createPaymentPayload({ signer, rpc: viewer, requirements: req, resource: required.resource });
log(`3. signed a delegate action for ft_transfer of ${req.amount} to ${req.payTo} (${payment.payload.signedDelegateAction.length} base64 chars); retrying with ${X402_HEADERS.signature}`);
const paid = await fetch(url, { headers: { [X402_HEADERS.signature]: encodeHeader(payment) } });
const settlementHeader = paid.headers.get(X402_HEADERS.response);
const settlement = settlementHeader ? decodeHeader<SettlementResponse>(settlementHeader) : null;
if (paid.status !== 200 || !settlement?.success) fail(`paid request answered ${paid.status}: ${JSON.stringify(settlement ?? (await paid.json()))}`);
const data = (await paid.json()) as { trend: { identifier: string; index: number }; index: Array<{ t: number; v: number }>; readings: Array<{ source: string }> };
const sources = [...new Set(data.readings.map((r) => r.source))].join(", ");
log(`4. 200 with ${X402_HEADERS.response}: ${JSON.stringify(settlement)}`);
log(`   ${data.trend.identifier} at ${data.trend.index} points: ${data.index.length} index checkpoints since ${new Date((data.index[0]?.t ?? 0) * 1000).toISOString()}, ${data.readings.length} readings (${sources})`);

// 4. On chain: the relayer's transaction carries the payer's ft_transfer to the payee.
const tx = await viewer.rpc<FinalExecutionOutcome>("EXPERIMENTAL_tx_status", { tx_hash: settlement.transaction, sender_account_id: info.relayers[0], wait_until: "FINAL" });
const transfer = (tx.receipts_outcome ?? [])
  .filter((r) => r.outcome.executor_id === req.asset)
  .flatMap((r) => parseEvents(r.outcome.logs))
  .find((e) => e.standard === "nep141" && e.event === "ft_transfer");
const t = (transfer?.data as unknown as Array<{ old_owner_id: string; new_owner_id: string; amount: string }> | undefined)?.[0];
if (!t || t.old_owner_id !== PAYER || t.new_owner_id !== req.payTo || t.amount !== req.amount) fail(`no matching ft_transfer in ${settlement.transaction}`);
const payeeAfter = await usdcOf(req.payTo);
log(`   on chain: ${t.old_owner_id} -> ${t.new_owner_id} ${fromRaw(t.amount, 6)} USDC, signed by ${tx.transaction?.signer_id} (relayer) for ${tx.transaction?.receiver_id}; payee ${fromRaw(payeeBefore, 6)} -> ${fromRaw(payeeAfter, 6)} USDC`);
log(`   ${explorerTx("testnet", settlement.transaction)}`);

// 5. The short way: x402Fetch pays within a limit and repeats the request.
const rule = {
  name: "Attention breakout",
  market: "ETH",
  trend,
  entry: { attentionChangePct: 5, windowMin: 60, side: "long" },
  size: { marginUsdc: 10, leverage: 2 },
  exits: { stopLossPct: 5, takeProfitPct: 10 },
  limits: { maxPositionUsdc: 50, maxDailyLossUsdc: 20 },
};
const bt = await x402Fetch(`${API}/v1/x402/backtests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rule, days: 7 }) }, { signer, rpc: viewer, network: "testnet", limits: { maxAmount: 50_000n, assets: [D.contracts.usdc] } });
if (bt.response.status === 200 && bt.settlement?.success) {
  const r = (await bt.response.json()) as { result: { trades: unknown[]; warnings: string[]; resolutionSec: number } };
  log(`5. backtest paid ${fromRaw(bt.requirements!.amount, 6)} USDC in ${bt.settlement.transaction}: ${r.result.trades.length} trades at ${r.result.resolutionSec}s candles${r.result.warnings.length ? `; ${r.result.warnings.join("; ")}` : ""}`);
} else {
  log(`5. backtest answered ${bt.response.status} (not charged unless settled): ${JSON.stringify(bt.settlement ?? (await bt.response.json()))}`);
}
