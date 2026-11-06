/**
 * Sends one order through an account's session exactly as the executor does, printing each step
 * and Hyperliquid's own answer: the session on chain, the gas key, Tredio's mark and the price
 * guard, the leverage change, the `session_call` that signs, the signature check and the post.
 * Nothing is recorded in the database. For checking a deployment end to end.
 *
 *   ACCOUNT=<account> SESSION_KEY=ed25519:<secret> MARKET=BTC SIDE=long USD=11 LEVERAGE=2 bun run order
 *
 * LEVERAGE=none skips the leverage change. An order the account's price guard would refuse (no
 * fresh Tredio mark, or a price over 2% from it) is not sent, as the executor would not send it,
 * unless SEND_ANYWAY=1 asks to see the contract refuse it; WAIT_MARK_SEC=<n> first waits up to n
 * seconds for the oracle's next mark. ANY_SESSION=1 accepts any session with
 * Hyperliquid scope (the executor itself trades only through Autopilot's Hyperliquid-only
 * sessions). RELAYER_URL tops up the session's gas key when it runs low.
 */
import { publicKeyOf, toNear, Viewer } from "@tredio/chain";
import { calls, deployment as deploymentOf } from "@tredio/contracts";
import { type HlNetwork, HyperliquidInfo, hyperliquidAddressOf } from "@tredio/hyperliquid";
import { buildOrder, guardProblem, openingLeverage, type RegistryMark, worstPrice } from "../src/orders";
import { AUTOPILOT_POLICY, type HyperliquidApi, hyperliquidApi, Nonces, relayerFunding, SessionVenue, sessionProblem } from "../src/venue";
import { nearSessionChain } from "../src/venues";

const env = process.env;
const need = (k: string) => env[k] ?? (console.error(`set ${k}`), process.exit(2));
const network = (env.NEAR_NETWORK ?? "testnet") as HlNetwork;
const account = need("ACCOUNT");
const secretKey = need("SESSION_KEY");
const sessionKey = publicKeyOf(secretKey);
const symbol = (env.MARKET ?? "BTC").toUpperCase();
const side = env.SIDE === "short" ? "short" : "long";
const usd = Number(env.USD ?? "11");
const slippageBps = Number(env.SLIPPAGE_BPS ?? "50");
const policy = env.ANY_SESSION ? { label: null, hyperliquidOnly: false } : AUTOPILOT_POLICY;

const D = deploymentOf(network);
const viewer = new Viewer(network);
const info = new HyperliquidInfo(network);
const step = (label: string, value: unknown) => console.log(`${label}:`, typeof value === "string" ? value : JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

const nowSec = Math.floor(Date.now() / 1000);
const session = await viewer.view<Parameters<typeof sessionProblem>[0]>(account, "session", { public_key: sessionKey });
step("session", session);
step("session check", sessionProblem(session, nowSec, policy) ?? "ok");
const gas = await viewer.gasKey(account, sessionKey);
step("gas key", gas ? `${toNear(gas.balance)} NEAR, ${gas.nonces} nonces` : "missing");
const address = await hyperliquidAddressOf((c, m, a) => viewer.view(c, m, a), D.external.chainSignatures, account);
step("hyperliquid address", address);
const state = await info.accountState(address);
step("hyperliquid account", { accountValue: state.accountValue, withdrawable: state.withdrawable, positions: state.positions.length });

const market = await info.market(symbol);
if (!market) throw new Error(`Hyperliquid ${network} has no ${symbol} perp`);
const mark = await viewer.view<RegistryMark | null>(D.contracts.registry, "mark_of", { asset: symbol });
step("tredio mark", mark ? { price: Number(mark.price) / 1e8, ageSec: nowSec - mark.at } : null);
const leverage = env.LEVERAGE === "none" ? null : openingLeverage(Number(env.LEVERAGE ?? "2"), market.maxLeverage, 10);
const buy = side === "long";
const order = buildOrder(market, { buy, worstPrice: worstPrice(buy, market.markPx, slippageBps), size: usd / market.markPx, reduceOnly: false });
if ("skip" in order) throw new Error(order.skip);
step("hyperliquid mark", market.markPx);
step("order", order);
step("guard check", guardProblem(symbol, order.price, mark, nowSec) ?? "ok");

/** Every exchange answer, verbatim. */
const api = hyperliquidApi(info, network);
const logged: HyperliquidApi = {
  ...api,
  post: async (action, nonce, sig) => {
    step(`post ${action.type} (nonce ${nonce})`, { signature: sig });
    const r = await api.post(action, nonce, sig);
    step(`hyperliquid answered ${action.type}`, r);
    return r;
  },
};
const venue = new SessionVenue({
  owner: account,
  kind: "grant",
  sessionKey,
  network,
  policy,
  chain: nearSessionChain(viewer, D, account, secretKey, viewer.urls),
  hyperliquid: logged,
  addressOf: async () => address,
  nonces: new Nonces(),
  fund: env.RELAYER_URL ? relayerFunding(env.RELAYER_URL, account, sessionKey) : async () => gas?.balance ?? 0n,
  gasMin: BigInt(calls(D).account.sessionCall(account, "faucet").gas) * 10n ** 9n + 10n ** 22n,
  gasNeeded: BigInt(calls(D).account.sessionCall(account, "faucet").gas) * 10n ** 9n,
});
const failed = (e: unknown) => ({ status: "refused before Hyperliquid", error: e instanceof Error ? e.message : String(e) });
if (leverage !== null) {
  const refused = await venue.setLeverage(market, leverage).catch(failed);
  step(`leverage ${leverage}x isolated`, refused ?? "set");
  if (refused) process.exit(1);
}
let guard = guardProblem(symbol, order.price, mark, Math.floor(Date.now() / 1000));
const waitUntil = Date.now() + Number(env.WAIT_MARK_SEC ?? "0") * 1000;
while (guard && Date.now() < waitUntil) {
  await Bun.sleep(5_000);
  const fresh = await viewer.view<RegistryMark | null>(D.contracts.registry, "mark_of", { asset: symbol });
  guard = guardProblem(symbol, order.price, fresh, Math.floor(Date.now() / 1000));
  if (!guard) step("tredio mark", fresh ? { price: Number(fresh.price) / 1e8, ageSec: Math.floor(Date.now() / 1000) - fresh.at } : null);
}
if (guard && !env.SEND_ANYWAY) {
  step("order", `not sent: ${guard}`);
  process.exit(1);
}
const result = await venue.send({ market, action: "open", side, order, leverage: null, nonce: Date.now() }, async (hash) => step("session_call", `signed in ${hash}`)).catch(failed);
step("result", result);
