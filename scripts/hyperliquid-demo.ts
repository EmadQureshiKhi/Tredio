/**
 * Hyperliquid on testnet with the Tredio bot and the demo traders apps/activity runs (JUDGES.md discloses them).
 * Every step goes through the same paths as the app: owner requests the passkey signs (sent by the relayer),
 * Chain Signatures for every Hyperliquid signature, and the API for grants, rules, backtests and follows.
 *
 *   bun scripts/hyperliquid-demo.ts status           balances, positions and recent fills
 *   bun scripts/hyperliquid-demo.ts renew-bot        renews the bot's Autopilot session for 30 days (the executor trades the bot through it)
 *   bun scripts/hyperliquid-demo.ts fund             the bot moves spot USDC to perps and sends each chosen trader some
 *   bun scripts/hyperliquid-demo.ts grant            each chosen trader grants Autopilot a Hyperliquid-only session
 *   bun scripts/hyperliquid-demo.ts rules            Autopilot rules for the bot (admin API) and the rule traders
 *   bun scripts/hyperliquid-demo.ts follow           the copy traders follow the Tredio bot
 *   bun scripts/hyperliquid-demo.ts stop <handle> <rule id...>  stops a trader's rules (no approval needed)
 *   bun scripts/hyperliquid-demo.ts trade BTC long 30 the bot opens a position (USDC notional) through its Autopilot session, or
 *   bun scripts/hyperliquid-demo.ts trade BTC close   closes it; the copy traders' follows mirror both
 *
 * Needs internal/keys/autopilot-bot.json and internal/keys/activity-personas.json (gitignored), the relayer's
 * and treasury's keys in ~/.near-credentials, and the admin key (tredio.testnet) for the bot's rules.
 */
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { seal } from "@tredio/autopilot";
import { nep413Hash, Sender } from "@tredio/chain";
import { AccountVersions, calls, type OwnerAction, type OwnerApprovalRequest, ownerApprovalDigest, ownerRequest, ownerRequests, requestJson, sessionCallTgas, upgradeToLatest } from "@tredio/contracts";
import {
  type EvmSignature,
  HL_PATH,
  formatPrice,
  formatSize,
  type HlOrder,
  HyperliquidInfo,
  hyperliquidAddressOf,
  leverageAction,
  orderAction,
  orderOutcome,
  postAction,
  postUserSigned,
  transferOutcome,
  type UserSignedAction,
  usdClassTransferAction,
  usdSendAction,
  userSignedDigestHex,
} from "@tredio/hyperliquid";
import { AdminApi, BACKEND_URL } from "../admin/e2e/support/backend";
import { adminAccount } from "../admin/e2e/support/wallet";
import type { Persona } from "../apps/activity/src/personas";
import { bs58decode, D, newEd25519, nowSecs, RPC, SoftPasskey, senderFor, testnetOnly, viewer } from "./lib/network";

testnetOnly("hyperliquid-demo");

const API = process.env.TREDIO_API_URL ?? "https://api.tredio.bid";
const C = calls(D);
const USDC = 1_000_000n;
const hl = new HyperliquidInfo("testnet");
const relayer = senderFor("tredio-relayer.testnet");
const treasury = senderFor("tredio-treasury.testnet");
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** The traders who trade on Hyperliquid: some run Autopilot rules, others copy the Tredio bot. */
const RULE_TRADERS = ["mila_k", "owenh", "tara_index", "eli_macro"];
const COPY_TRADERS = ["leo_onchain", "jonah_r", "nina_sats", "marco_b"];
/** USDC each trader gets on Hyperliquid, and what the bot keeps on perps for its own rules. */
const PER_TRADER = 60n * USDC;
const BOT_PERPS = 400n * USDC;

interface Trader {
  handle: string;
  account: string;
  passkey: SoftPasskey;
  /** The web session the trader signs in to the API with. */
  session: { publicKey: string; secretKey: string };
}

const bot = (() => {
  const b = JSON.parse(readFileSync("internal/keys/autopilot-bot.json", "utf8")) as { account: string; passkey_secret_hex: string; session_public_key: string; session_secret_key: string };
  return { handle: "tredio-bot", account: b.account, passkey: new SoftPasskey(new Uint8Array(Buffer.from(b.passkey_secret_hex, "hex"))), session: { publicKey: b.session_public_key, secretKey: b.session_secret_key } } satisfies Trader;
})();
const personas = JSON.parse(readFileSync("internal/keys/activity-personas.json", "utf8")) as Persona[];
const trader = (handle: string): Trader => {
  const p = personas.find((x) => x.handle === handle);
  if (!p) throw new Error(`no persona ${handle}`);
  return { handle, account: p.account, passkey: new SoftPasskey(new Uint8Array(Buffer.from(p.passkeySecret, "hex"))), session: { publicKey: p.sessionPublicKey, secretKey: p.sessionSecretKey } };
};

const addressCache = new Map<string, string>();
async function addressOf(account: string): Promise<string> {
  if (!addressCache.has(account)) addressCache.set(account, await hyperliquidAddressOf((c, m, a) => viewer.view(c, m, a), D.external.chainSignatures, account));
  return addressCache.get(account)!;
}

/** One owner request, approved by the trader's passkey and sent by the relayer, as the app sends them. */
async function ownerExecute(t: Trader, actions: OwnerAction[]) {
  const request = requestJson(ownerRequest(t.account, "testnet", actions));
  return relayer.send(C.account.ownerExecute(t.account, request, await t.passkey.prove(request)));
}

/** Signs a user-signed Hyperliquid action with the account's Chain Signatures key and posts it. */
async function userSigned(t: Trader, action: UserSignedAction): Promise<string> {
  const sent = await ownerExecute(t, [{ mpc_sign: { path: HL_PATH, payload: userSignedDigestHex(action), domain_id: 0 } }]);
  const sig = sent.value as Partial<EvmSignature> | undefined;
  if (!sig || typeof sig.r !== "string" || typeof sig.s !== "string" || typeof sig.v !== "number") throw new Error(`${sent.hash}: the account returned no signature`);
  const answer = transferOutcome(await postUserSigned("testnet", action, { r: sig.r, s: sig.s, v: sig.v }));
  if (!answer.ok) throw new Error(`Hyperliquid refused ${action.type} signed in ${sent.hash}: ${answer.error}`);
  return sent.hash;
}

async function balances(address: string): Promise<{ spot: number; perps: number; positions: number }> {
  const post = async <T>(body: object) => (await (await fetch("https://api.hyperliquid-testnet.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as T;
  const [spot, perp] = await Promise.all([
    post<{ balances: { coin: string; total: string }[] }>({ type: "spotClearinghouseState", user: address }),
    post<{ marginSummary: { accountValue: string }; assetPositions: unknown[] }>({ type: "clearinghouseState", user: address }),
  ]);
  return { spot: Number(spot.balances.find((b) => b.coin === "USDC")?.total ?? 0), perps: Number(perp.marginSummary.accountValue), positions: perp.assetPositions.length };
}

/** Moves whatever USDC sits in spot to perps, where it margins orders. */
async function spotToPerps(t: Trader, keepInSpot = 0n): Promise<void> {
  const { spot } = await balances(await addressOf(t.account));
  const amount = BigInt(Math.floor(spot * 1e6)) - keepInSpot;
  if (amount < USDC) return;
  log(t.handle, "spot to perps", Number(amount) / 1e6, await userSigned(t, usdClassTransferAction("testnet", amount, true)));
}

// API access, as the app signs in: NEP-413 by the trader's web session key.
async function api<T>(method: string, path: string, body?: unknown, token?: string, base = API): Promise<T> {
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as T;
  if (res.status >= 300) throw new Error(`${method} ${path}: HTTP ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const tokens = new Map<string, string>();
async function signIn(t: Trader): Promise<string> {
  if (tokens.has(t.account)) return tokens.get(t.account)!;
  const issuedAt = nowSecs();
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const message = `Tredio sign-in\naccount: ${t.account}\nkey: ${t.session.publicKey}\nissued: ${issuedAt}`;
  const seed = bs58decode(t.session.secretKey.replace(/^ed25519:/, "")).slice(0, 32);
  const signature = Buffer.from(ed25519.sign(nep413Hash({ message, nonce, recipient: "tredio.bid" }), seed)).toString("base64");
  const { token } = await api<{ token: string }>("POST", "/v1/auth/session", { account: t.account, signer: t.session.publicKey, issuedAt, signature, nonce });
  tokens.set(t.account, token);
  return token;
}

/** The passkey's approval of one API action, as the app asks for it. */
async function approve(t: Trader, request: OwnerApprovalRequest) {
  const token = await signIn(t);
  const ch = await api<{ nonce: string; expiresAt: number; network: "testnet" }>("POST", "/v1/owner-approvals", { action: request.action }, token);
  const digest = await ownerApprovalDigest({ network: ch.network, account: t.account, request, nonce: ch.nonce, expiresAt: ch.expiresAt });
  const clientDataJson = JSON.stringify({ type: "webauthn.get", challenge: b64url(digest), origin: "https://app.tredio.bid" });
  const auth = new Uint8Array([...sha256(new TextEncoder().encode("tredio.bid")), 0x05, 0, 0, 0, 1]);
  const msg = new Uint8Array([...auth, ...sha256(new TextEncoder().encode(clientDataJson))]);
  const sig = p256.sign(sha256(msg), t.passkey.secret, { prehash: false, lowS: true });
  return { nonce: ch.nonce, authenticator_data: b64url(auth), client_data_json: clientDataJson, signature: hex(sig) };
}

/**
 * Rules that trade on attention moves of the listed trends behind Autopilot's markets: a 1-hour window
 * for small fast moves, or a 1-day window for the slower swings these indexes mostly make.
 */
function ruleFor(n: number, side: "long" | "short", changePct: number, windowMin = 60): { name: string; trend: string } & Record<string, unknown> {
  const pairs = [
    { trend: "crypto:btc", market: "BTC" },
    { trend: "crypto:eth", market: "ETH" },
  ];
  const p = pairs[n % pairs.length]!;
  return {
    name: `${p.market} ${side} on ${changePct > 0 ? "rising" : "falling"} attention${windowMin >= 1440 ? " (day)" : ""}`,
    market: p.market,
    trend: p.trend,
    entry: { attentionChangePct: changePct, windowMin, minIndex: 0, smartMoney: "any", side },
    size: { marginUsdc: 12, leverage: 3 },
    exits: { stopLossPct: 8, takeProfitPct: 12, maxHoldMin: 240 },
    limits: { maxPositionUsdc: 40, maxDailyLossUsdc: 15, cooldownMin: 60 },
  };
}

async function listedTrends(): Promise<Set<string>> {
  const r = await api<{ trends: { identifier: string }[] } | { identifier: string }[]>("GET", "/v1/trends?limit=100");
  return new Set((Array.isArray(r) ? r : r.trends).map((t) => t.identifier));
}

/**
 * The bot trades through its Autopilot session as the executor does: an `hl_order` (or `hl_leverage`)
 * session call, which the account's guard checks against the oracle's mark before Chain Signatures signs it.
 */
async function botSession(action: { hl_order: { order: HlOrder; nonce: number } } | { hl_leverage: { asset_index: number; is_cross: boolean; leverage: number; nonce: number } }) {
  const b = JSON.parse(readFileSync("internal/keys/autopilot-bot.json", "utf8")) as { session_secret_key: string };
  const version = await new AccountVersions((a) => viewer.view<number>(a, "version")).of(bot.account);
  const sender = new Sender({ network: "testnet", accountId: bot.account, privateKey: b.session_secret_key, gasKeyLanes: 4, rpc: RPC });
  const sent = await sender.send(C.account.sessionCall(bot.account, action as never, sessionCallTgas(version)));
  const sig = sent.value as Partial<EvmSignature> | undefined;
  if (!sig || typeof sig.r !== "string" || typeof sig.s !== "string" || typeof sig.v !== "number") throw new Error(`${sent.hash}: the session call returned no signature`);
  return { hash: sent.hash, sig: { r: sig.r, s: sig.s, v: sig.v } };
}

const step = process.argv[2] ?? "status";
const traders = () => [...RULE_TRADERS, ...COPY_TRADERS].map(trader);

if (step === "renew-bot") {
  // Account code v1 cannot renew a session in place: move the bot to the newest code first, as the app does.
  const upgrade = upgradeToLatest(D);
  const version = await new AccountVersions((a) => viewer.view<number>(a, "version", {}, "optimistic")).of(bot.account);
  if (upgrade && version < 3) log("bot account code", version, "upgraded in", (await ownerExecute(bot, [upgrade])).hash);
  // add_session with a key the account already has renews it: same terms, a new expiry, its prepaid gas kept.
  const b = JSON.parse(readFileSync("internal/keys/autopilot-bot.json", "utf8")) as { session_public_key: string };
  const s = await viewer.view<{ label: string; scope: object; daily_limit: string; gas_key: boolean; expires_at: number }>(bot.account, "session", { public_key: b.session_public_key }, "optimistic");
  const expiresAt = nowSecs() + 30 * 86_400 - 600;
  const r = await ownerExecute(bot, [{ add_session: { public_key: b.session_public_key, label: s.label, scope: s.scope, expires_at: expiresAt, daily_limit: s.daily_limit, gas_key: s.gas_key, gas_funding: "0" } } as OwnerAction]);
  log("bot session", b.session_public_key, "expired", new Date(s.expires_at * 1000).toISOString(), "now runs to", new Date(expiresAt * 1000).toISOString(), "in", r.hash);
} else if (step === "status") {
  for (const t of [bot, ...traders()]) {
    const address = await addressOf(t.account);
    const b = await balances(address);
    const fills = await hl.fills(address).catch(() => []);
    log(t.handle.padEnd(12), address, `spot ${b.spot.toFixed(2)}`, `perps ${b.perps.toFixed(2)}`, `positions ${b.positions}`, `fills ${fills.length}`);
  }
} else if (step === "fund") {
  // The bot keeps BOT_PERPS on perps and sends each trader PER_TRADER from perps; the rest stays in spot.
  const sending = PER_TRADER * BigInt(RULE_TRADERS.length + COPY_TRADERS.length);
  const botAddress = await addressOf(bot.account);
  const b = await balances(botAddress);
  const needOnPerps = BOT_PERPS + sending;
  const move = needOnPerps - BigInt(Math.floor(b.perps * 1e6));
  if (move > 0n) log("bot spot to perps", Number(move) / 1e6, await userSigned(bot, usdClassTransferAction("testnet", move, true)));
  for (const t of traders()) {
    const address = await addressOf(t.account);
    const has = await balances(address);
    if (has.spot + has.perps >= Number(PER_TRADER) / 1e6) {
      log(t.handle, "already funded", has);
    } else {
      log(t.handle, "usdSend", Number(PER_TRADER) / 1e6, "to", address, await userSigned(bot, usdSendAction("testnet", address, PER_TRADER)));
      await sleep(1_500);
    }
    await spotToPerps(t);
  }
} else if (step === "grant") {
  const { publicKey: executorKey } = await api<{ publicKey: string }>("GET", "/v1/autopilot/grant/seal-key");
  for (const t of traders()) {
    const token = await signIn(t);
    const existing = await api<{ grant: { status: string; validUntil: number } | null }>("GET", "/v1/autopilot/grant", undefined, token);
    if (existing.grant?.status === "active" && existing.grant.validUntil > nowSecs() + 86_400) {
      log(t.handle, "grant already active until", new Date(existing.grant.validUntil * 1000).toISOString());
      continue;
    }
    const key = newEd25519();
    const sealedKey = await seal(key.secretKey, executorKey, { owner: t.account, sessionKey: key.publicKey });
    const { session } = await api<{ session: { public_key: string; label: string; scope: object; expires_at: number; daily_limit: string } }>(
      "POST",
      "/v1/autopilot/grant",
      { sessionKey: key.publicKey, sealedKey, dailyLimit: (200n * USDC).toString(), validDays: 7 },
      token,
    );
    if (session.public_key !== key.publicKey) throw new Error("the API answered with another key");
    const added = await ownerExecute(t, [
      { add_session: { public_key: key.publicKey, label: session.label, scope: { outcomes: false, perps: false, hyperliquid: true }, expires_at: session.expires_at, daily_limit: session.daily_limit, gas_key: true, gas_funding: "0" } },
    ]);
    // The app asks the relayer to fill the new gas key; anyone may fund a gas key, so the treasury does it here.
    await treasury.fundGasKey(t.account, key.publicKey, 32n * 10n ** 22n);
    for (let attempt = 0; ; attempt++) {
      try {
        await api("POST", "/v1/autopilot/grant/confirm", {}, token);
        break;
      } catch (e) {
        if (attempt >= 10) throw e;
        await sleep(1_500);
      }
    }
    log(t.handle, "granted Autopilot", key.publicKey, "in", added.hash);
  }
} else if (step === "rules") {
  const listed = await listedTrends();
  // The bot: one long and one short rule per market whose trend is listed, through the admin API.
  const admin = new AdminApi(adminAccount());
  const adminToken = (await admin.freshSession()).token;
  const existingBot = await api<{ enabled: { owner: string }[] }>("GET", "/v1/admin/autopilot", undefined, adminToken, BACKEND_URL);
  if (existingBot.enabled.some((r) => r.owner === bot.account)) {
    log("bot already runs rules");
  } else {
    for (let n = 0; n < 2; n++) {
      for (const [side, change] of [["long", 0.5], ["short", -0.5]] as const) {
        const rule = ruleFor(n, side, change);
        if (!listed.has(rule.trend)) continue;
        const { rule: created } = await api<{ rule: { id: number } }>("POST", "/v1/admin/autopilot/bot/rules", { rule }, adminToken, BACKEND_URL);
        await api("POST", "/v1/admin/autopilot/bot/backtests", { rule, days: 7 }, adminToken, BACKEND_URL);
        await api("POST", `/v1/admin/autopilot/bot/rules/${created.id}/status`, { status: "enabled" }, adminToken, BACKEND_URL);
        log("bot rule", created.id, rule.name, "enabled");
      }
    }
  }
  // Each rule trader: an hourly rule on each market and a daily one on ETH, through its session's grant.
  for (const [i, handle] of RULE_TRADERS.entries()) {
    const t = trader(handle);
    const token = await signIn(t);
    const mine = await api<{ rules: { status: string; rule: { name: string } }[] }>("GET", "/v1/autopilot/rules", undefined, token).then((r) => r.rules.filter((x) => x.status !== "stopped").map((x) => x.rule.name));
    const style = personas.find((p) => p.handle === handle)!.style;
    // Momentum traders go with the move in attention; contrarians fade it.
    const plans: [number, "long" | "short", number, number][] =
      style === "contrarian"
        ? [
            [i, "short", 1, 60],
            [i + 1, "long", -1, 60],
            [1, "long", -2, 1440],
          ]
        : [
            [i, "long", 1, 60],
            [i + 1, "short", -1, 60],
            [1, "short", -2, 1440],
          ];
    for (const [n, side, change, windowMin] of plans) {
      const rule = ruleFor(n, side, change, windowMin);
      if (!listed.has(rule.trend) || mine.includes(rule.name)) continue;
      const { rule: created } = await api<{ rule: { id: number; ruleHash: string } }>("POST", "/v1/autopilot/rules", { rule }, token);
      await api("POST", "/v1/autopilot/backtests", { rule, days: 7 }, token);
      const approval = await approve(t, ownerRequests.enableRule(created.id, created.ruleHash));
      await api("POST", `/v1/autopilot/rules/${created.id}/status`, { status: "enabled", ruleHash: created.ruleHash, approval }, token);
      log(handle, "rule", created.id, rule.name, "enabled");
    }
  }
} else if (step === "stop") {
  const [handle = "", ...ids] = process.argv.slice(3);
  const t = trader(handle);
  for (const id of ids) {
    await api("POST", `/v1/autopilot/rules/${id}/status`, { status: "stopped" }, await signIn(t));
    log(handle, "rule", id, "stopped");
  }
} else if (step === "follow") {
  const settings = { mode: "ratio", ratio: 0.5, maxMarginUsdc: 20, maxLeverage: 3, maxDailyLossUsdc: 15, maxSlippagePct: 1 };
  // A leader is named by its Hyperliquid address: the Tredio bot's is its account's Chain Signatures address.
  const leader = await addressOf(bot.account);
  for (const handle of COPY_TRADERS) {
    const t = trader(handle);
    const token = await signIn(t);
    const { follows } = await api<{ follows: { leader: string; status: string }[] }>("GET", "/v1/follows", undefined, token);
    if (follows.some((f) => f.leader === leader && f.status === "active")) {
      log(handle, "already follows the bot");
      continue;
    }
    const approval = await approve(t, ownerRequests.follow(leader, settings));
    const { follow } = await api<{ follow: { id: number } }>("POST", "/v1/follows", { leader, settings, approval }, token);
    log(handle, "follows the Tredio bot", follow.id);
  }
} else if (step === "trade") {
  const [symbol = "BTC", side = "long", notional = "30"] = process.argv.slice(3);
  const market = await hl.market(symbol);
  if (!market) throw new Error(`no ${symbol} perp`);
  const address = await addressOf(bot.account);
  const open = (await hl.accountState(address)).positions.find((p) => p.coin === symbol && p.szi !== 0);
  let isBuy: boolean;
  let size: number;
  if (side === "close") {
    if (!open) throw new Error(`the bot has no ${symbol} position`);
    isBuy = open.szi < 0;
    size = Math.abs(open.szi);
  } else {
    isBuy = side === "long";
    size = Number(notional) / market.markPx;
    const levNonce = Date.now();
    const lev = await botSession({ hl_leverage: { asset_index: market.index, is_cross: false, leverage: 3, nonce: levNonce } });
    log("leverage 3x isolated", lev.hash, JSON.stringify(await postAction("testnet", leverageAction(market.index, false, 3), levNonce, lev.sig)));
  }
  // An immediate order 1% through the mark, inside the account's 2% band.
  const order: HlOrder = {
    asset: symbol,
    asset_index: market.index,
    is_buy: isBuy,
    price: formatPrice(market.markPx * (isBuy ? 1.01 : 0.99), market.szDecimals, isBuy ? "up" : "down"),
    size: formatSize(size, market.szDecimals),
    reduce_only: side === "close",
    tif: "Ioc",
  };
  const nonce = Date.now();
  const signed = await botSession({ hl_order: { order, nonce } });
  const outcome = orderOutcome(await postAction("testnet", orderAction(order), nonce, signed.sig));
  log(`bot ${side} ${symbol}`, order.size, "at up to", order.price, "signed in", signed.hash, JSON.stringify(outcome));
} else {
  throw new Error(`unknown step ${step}`);
}
process.exit(0);
