/**
 * End-to-end on NEAR testnet, as the app and services do it:
 *   1. a passkey's universal account is created by the relayer with a gas-key session,
 *   2. the session (gas key, nonce lane 0) draws test USDC straight from RPC, no relayer,
 *   3. the oracle lists a trend, the keeper opens a series and lists it on the book,
 *   4. the market maker quotes, and the session buys UP with an anchored swap,
 *   5. the session opens and closes an attention perp.
 *
 *   bun scripts/e2e-testnet.ts            (uses ~/.near-credentials/testnet service keys)
 */
import { readFileSync } from "node:fs";
import { calls, ownerRequest, requestJson, type Report, type Series } from "@tredio/contracts";
import { Sender } from "@tredio/chain";
import { D, SoftPasskey, newEd25519, nowSecs, senderFor, signReport, viewer } from "./lib/testnet";

const C = calls(D);
const USDC = 1_000_000n;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const relayer = senderFor("tredio-relayer.testnet");
const keeper = senderFor("tredio-keeper.testnet");
const mm = senderFor("tredio-mm.testnet");
const oracleKey = JSON.parse(readFileSync("internal/keys/oracle-bootstrap.json", "utf8")).secret_key as string;
const trend = process.env.E2E_TREND ?? `topic:e2e-${nowSecs().toString(36)}`;

async function report(r: Omit<Report, "run_id" | "observed_at">) {
  const last = await viewer.view<number>(D.contracts.registry, "last_run_id");
  const json = JSON.stringify({ run_id: last + 1, observed_at: nowSecs() - 5, ...r });
  return keeper.send(C.registry.submitReport(json, signReport(json, oracleKey)));
}

// 1. Account.
const passkey = new SoftPasskey();
const account = await viewer.view<string>(D.contracts.accounts, "account_id_of", { owner_key: passkey.publicKeyHex });
const session = newEd25519();
// Kept locally (gitignored) so a failed run can be inspected with the same session key.
await Bun.write("internal/scratch/e2e-session.json", JSON.stringify({ account, ...session }, null, 2));
const request = requestJson(
  ownerRequest(account, "testnet", [
    {
      add_session: {
        public_key: session.publicKey,
        label: "e2e",
        scope: { outcomes: true, perps: true, hyperliquid: true },
        expires_at: nowSecs() + 7 * 86_400,
        daily_limit: (500n * USDC).toString(),
        gas_key: true,
        // Prepaid gas is bought at 1e9 yocto/gas, so a 300 Tgas transaction needs 0.3 NEAR of float;
        // unused gas returns to the key, each trade burns a few thousandths.
        gas_funding: (32n * 10n ** 22n).toString(),
      },
    },
  ]),
);
const created = await relayer.send(C.accounts.create(passkey.publicKeyHex, (4n * 10n ** 23n).toString(), { request, proof: await passkey.prove(request) }));
log("account", account, "created in", created.hash);
const keys = await viewer.rpc<{ keys: { public_key: string; access_key: Record<string, unknown> }[] }>("query", {
  request_type: "view_access_key_list",
  finality: "final",
  account_id: account,
});
log("keys", JSON.stringify(keys.keys));

// 2. The gas key draws test USDC.
const user = new Sender({ network: "testnet", accountId: account, privateKey: session.secretKey, gasKeyLanes: 4 });
const drip = await user.send(C.account.sessionCall(account, "faucet"));
const bal = await viewer.view<string>(D.contracts.usdc, "ft_balance_of", { account_id: account });
log("faucet via gas key", drip.hash, "USDC", Number(bal) / 1e6);

// 3. A trend, a series on the book.
await report({ new_trends: [{ identifier: trend, asset_class: "topic", index: 50_000_000, surfacer: account, smart_money_confirmed: false, review_hash: null, asset: null }], updates: [], marks: [] });
log("listed", trend);
const opened = await keeper.send<number | null>(C.outcomes.openSeries(trend, D.params.outcomeTestWindow));
const series = opened.value!;
await keeper.send(C.book.listSeries(series));
const s = await viewer.view<Series>(D.contracts.outcomes, "get_series", { series });
log("series", series, "opening", s.opening_index / 1e6, "expiry", new Date(s.expiry * 1000).toISOString());

// 4. The market maker quotes UP; the session buys with an anchored swap.
const mmBal = BigInt(await viewer.view<string>(D.contracts.usdc, "ft_balance_of", { account_id: mm.accountId }));
if (mmBal < 200n * USDC) {
  await mm.send(C.usdc.storageDeposit(mm.accountId)).catch(() => undefined);
  await senderFor("tredio-faucet.testnet").send(C.usdc.mint(mm.accountId, (10_000n * USDC).toString()));
}
await mm.send({ ...C.usdc.storageDeposit(mm.accountId), receiverId: D.contracts.outcomes, args: { account_id: mm.accountId }, deposit: (2n * 10n ** 23n).toString() }).catch(() => undefined);
await mm.send({ ...C.usdc.storageDeposit(mm.accountId), receiverId: D.contracts.book, args: { account_id: mm.accountId }, deposit: (2n * 10n ** 23n).toString() }).catch(() => undefined);
await mm.send(C.outcomes.mint(series, (100n * USDC).toString()));
await mm.send(C.outcomes.toBook(series, "up", (100n * USDC).toString()));
for (const tick of [180, 200, 600]) {
  await mm.send(C.book.place({ series, side: "up", dir: "sell", tick, size: (20n * USDC).toString(), tif: "gtc" }));
}
const before = BigInt(await viewer.view<string>(D.contracts.usdc, "ft_balance_of", { account_id: account }));
const swap = await user.send(C.account.sessionCall(account, { swap: { series, side: "up", buy: true, amount: (30n * USDC).toString(), min_out: "1" } }));
await new Promise((r) => setTimeout(r, 4000));
const up = await viewer.view<string>(D.contracts.outcomes, "mt_balance_of", { account_id: account, token_id: `${series}:up` });
const after = BigInt(await viewer.view<string>(D.contracts.usdc, "ft_balance_of", { account_id: account }));
log("anchored swap", swap.hash, "UP", Number(up) / 1e6, "paid", Number(before - after) / 1e6);

// 5. Attention perp from the session (the pool backs positions; seed it once).
const pool = BigInt(await viewer.view<string>(D.contracts.perps, "pool"));
if (pool < 1_000n * USDC) {
  await senderFor("tredio-faucet.testnet").send(C.usdc.mint(keeper.accountId, (5_000n * USDC).toString()));
  await keeper.send(C.perps.depositPool((5_000n * USDC).toString()));
  log("seeded the perps pool");
}
const open = await user.send(C.account.sessionCall(account, { perp_open: { trend, is_long: true, margin: (20n * USDC).toString(), leverage_bps: 20_000, acceptable_index: 60_000_000 } }));
await new Promise((r) => setTimeout(r, 4000));
const positions = await viewer.view<{ id: number; qty: string; margin: string }[]>(D.contracts.perps, "positions_of", { account_id: account });
log("perp opened", open.hash, JSON.stringify(positions));
if (positions[0]) {
  await report({ new_trends: [], updates: [{ id: trend, index: 55_000_000 }], marks: [] });
  const close = await user.send(C.account.sessionCall(account, { perp_close: { id: positions[0].id, acceptable_index: 0 } }));
  await new Promise((r) => setTimeout(r, 4000));
  const end = BigInt(await viewer.view<string>(D.contracts.usdc, "ft_balance_of", { account_id: account }));
  log("perp closed", close.hash, "USDC now", Number(end) / 1e6);
}
const sessionView = await viewer.view(account, "session", { public_key: session.publicKey });
log("session after", JSON.stringify(sessionView));
log("done: explorer", `https://testnet.nearblocks.io/address/${account}`);
