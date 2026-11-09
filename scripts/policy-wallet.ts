/**
 * Autopilot on an OutLayer policy wallet, live on NEAR testnet, as the app and the executor do it:
 *
 *   bun scripts/policy-wallet.ts setup      a passkey account (the relayer pays), then one owner request: store the wallet's
 *                                           policy (the account becomes its controller), fund its gas, add Autopilot's session
 *   bun scripts/policy-wallet.ts call       a session call the enclave signs and sends, and what the account contract answers
 *   bun scripts/policy-wallet.ts outside    calls outside the policy: the enclave refuses them before signing
 *   bun scripts/policy-wallet.ts freeze     the passkey freezes the wallet; the executor's venue and the enclave refuse
 *   bun scripts/policy-wallet.ts unfreeze   the passkey unfreezes it; the executor's gate passes again
 *   bun scripts/policy-wallet.ts fund 0.1   the passkey sends the wallet more NEAR for gas
 *   bun scripts/policy-wallet.ts show       the policy on chain and as the enclave reads it, the session, the balances
 *
 * The passkey's seed and the wallet's API key stay in internal/scratch/policy-wallet.json (gitignored), with every
 * transaction hash. Testnet only; the wallet registration is OutLayer's free anonymous wallet.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AccountVersions, acceptsWalletSessions, calls, explorerTx, type OwnerAction, ownerRequest, requestJson, type Session, upgradeToLatest } from "@tredio/contracts";
import {
  AUTOPILOT_CAPABILITIES,
  autopilotRules,
  CUSTODY_API,
  CUSTODY_CONTRACT,
  CustodyCallFailed,
  CustodyWallet,
  custodyKeyOf,
  DEFAULT_GAS_FUNDING,
  freezeCall,
  nearKeyOf,
  onChainPolicy,
  ownerCall,
  PolicyRefusal,
  policyCost,
  unfreezeCall,
  walletPolicyProblem,
  walletSetupActions,
} from "@tredio/custody";
import { Nonces, SessionVenue, VenueError, WALLET_POLICY } from "../apps/autopilot/src/venue";
import { outLayerSigner, WalletGate, walletSessionChain } from "../apps/autopilot/src/wallets";
import { D, SoftPasskey, nowSecs, senderFor, testnetOnly, viewer } from "./lib/network";

testnetOnly("policy-wallet");

const FILE = "internal/scratch/policy-wallet.json";
const C = calls(D);
const relayer = senderFor("tredio-relayer.testnet");
const contract = CUSTODY_CONTRACT.testnet;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

interface State {
  passkeySeed: string;
  account: string;
  wallet?: { id: string; account: string; apiKey: string };
  txs: Record<string, string>;
}

const load = (): State | null => (existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as State) : null);
const save = (s: State) => writeFileSync(FILE, `${JSON.stringify(s, null, 2)}\n`);
const record = (s: State, name: string, hash: string) => {
  s.txs[name] = hash;
  save(s);
  log(name.padEnd(22), explorerTx("testnet", hash));
};

/** Reads until `done` holds or 20 s pass (views at `final` trail a just-sent transaction). */
async function until<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  const end = Date.now() + 20_000;
  for (;;) {
    const v = await read().catch(() => undefined as T);
    if ((v !== undefined && done(v)) || Date.now() > end) return v;
    await Bun.sleep(1_000);
  }
}

/** One owner request the passkey signs, relayed like the app's relayer does. */
async function owner(s: State, actions: OwnerAction[]): Promise<string> {
  const passkey = new SoftPasskey(Uint8Array.from(Buffer.from(s.passkeySeed, "hex")));
  const request = requestJson(ownerRequest(s.account, "testnet", actions));
  return (await relayer.send(C.account.ownerExecute(s.account, request, await passkey.prove(request)))).hash;
}

function walletOf(s: State): CustodyWallet {
  if (!s.wallet) throw new Error("run setup first");
  return new CustodyWallet(s.wallet.apiKey, CUSTODY_API.testnet);
}

/** The executor's own venue for this grant: the gate it checks before every order (controller, freeze, policy, gas). */
function executorVenue(s: State) {
  const signer = outLayerSigner(viewer, "testnet", s.wallet!.account, s.wallet!.apiKey);
  const versions = new AccountVersions((a) => viewer.view<number>(a, "version"));
  const gate = new WalletGate(signer, s.account, { balance: (a) => viewer.balance(a), minBalance: 16n * 10n ** 22n, ttlMs: 0, accepts: async () => acceptsWalletSessions(await versions.of(s.account)) });
  const venue = new SessionVenue({
    owner: s.account,
    kind: "grant",
    sessionKey: signer.sessionKey,
    network: "testnet",
    policy: WALLET_POLICY,
    chain: walletSessionChain(viewer, signer, s.account, versions),
    hyperliquid: { accountState: async () => ({}) as never, leverage: async () => null, fills: async () => [], post: async () => ({ status: "err", response: "not posted by this script" }) as never },
    addressOf: async () => "0x0000000000000000000000000000000000000000",
    nonces: new Nonces(),
    fund: async () => 0n,
    gasMin: 0n,
    wallet: gate,
    checkTtlMs: 0,
  });
  return { signer, gate, venue };
}

async function setup() {
  let s = load();
  if (!s) {
    const passkey = new SoftPasskey();
    const account = await viewer.view<string>(D.contracts.accounts, "account_id_of", { owner_key: passkey.publicKeyHex });
    s = { passkeySeed: Buffer.from(passkey.secret).toString("hex"), account, txs: {} };
    save(s);
    const upgrade = upgradeToLatest(D);
    const request = requestJson(ownerRequest(account, "testnet", upgrade ? [upgrade] : []));
    const created = upgrade
      ? await relayer.send(C.accounts.create(passkey.publicKeyHex, (4n * 10n ** 23n).toString(), { request, proof: await passkey.prove(request) }))
      : await relayer.send(C.accounts.create(passkey.publicKeyHex, (4n * 10n ** 23n).toString()));
    record(s, "account_created", created.hash);
  }
  log("account", s.account);
  if (s.wallet) {
    log("wallet", s.wallet.account, "(already set up)");
    return;
  }
  // The app does these in the browser: a wallet, its policy encrypted to the enclave and signed for this account.
  const { wallet, walletId, accountId } = await CustodyWallet.register(CUSTODY_API.testnet);
  s.wallet = { id: walletId, account: accountId, apiKey: wallet.apiKey };
  save(s);
  log("wallet", accountId, `(OutLayer key ${custodyKeyOf(accountId)}, session key ${nearKeyOf(accountId)})`);
  const { encrypted } = await wallet.encryptPolicy(walletId, autopilotRules({ account: s.account }), AUTOPILOT_CAPABILITIES);
  const signed = await wallet.signPolicy(encrypted, s.account);
  const cost = await policyCost((c, m, a) => viewer.view(c, m, a), contract, custodyKeyOf(accountId), encrypted);
  const actions = walletSetupActions({
    contract,
    walletAccount: accountId,
    encrypted,
    signed,
    policyCost: cost,
    gasFunding: DEFAULT_GAS_FUNDING,
    expiresAt: nowSecs() + 7 * 86_400,
    dailyLimit: 100_000_000n,
  });
  record(s, "policy_wallet_setup", await owner(s, actions as OwnerAction[]));
  await wallet.refresh(walletId);
  const p = await until(
    () => onChainPolicy((c, m, a) => viewer.view(c, m, a), contract, custodyKeyOf(accountId)),
    (v) => v?.owner === s!.account,
  );
  log("policy on chain", JSON.stringify(p));
  log("enclave's reading", walletPolicyProblem(await wallet.policy(), s.account) ?? "Autopilot's policy, controlled by the account");
  const session = await viewer.view<Session | null>(s.account, "session", { public_key: nearKeyOf(accountId) });
  log("session", JSON.stringify(session));
}

async function call() {
  const s = load()!;
  const { signer, venue } = executorVenue(s);
  // What the executor checks first (it would wait here), then the call itself, sent anyway to show where the account stops it.
  log("executor's check", (await venue.wallet!.check())?.reason ?? "the wallet may sign");
  const action = { hl_leverage: { asset_index: 3, is_cross: false, leverage: 2, nonce: Date.now() } };
  try {
    const r = await signer.sessionCall(s.account, action, 150);
    record(s, `session_call_${Date.now()}`, r.hash);
    log("returned", JSON.stringify(r.value));
  } catch (e) {
    if (e instanceof CustodyCallFailed) {
      record(s, `session_call_${Date.now()}`, e.txHash);
      log("the enclave signed and sent it; the account contract answered:", e.message);
      return;
    }
    throw e;
  }
}

async function outside() {
  const s = load()!;
  const w = walletOf(s);
  const tries = [
    { why: "a contract outside the allowlist", call: { ...C.usdc.faucet(), gas: "30000000000000" } },
    { why: "NEAR attached to a call to the account", call: { receiverId: s.account, methodName: "session_call", args: { action: "faucet" }, gas: "150000000000000", deposit: "1" } },
  ];
  for (const t of tries) {
    try {
      const r = await w.call({ receiverId: t.call.receiverId, methodName: t.call.methodName, args: t.call.args, gas: t.call.gas, deposit: t.call.deposit });
      log(`x the enclave signed ${t.why}:`, r.txHash);
      process.exitCode = 1;
    } catch (e) {
      if (!(e instanceof PolicyRefusal)) throw e;
      log(`+ refused before signing, ${t.why} (${e.code}): ${e.message}`);
    }
  }
}

async function freeze(frozen: boolean) {
  const s = load()!;
  const c = (frozen ? freezeCall : unfreezeCall)(contract, s.wallet!.account);
  record(s, `${frozen ? "freeze" : "unfreeze"}_${Date.now()}`, await owner(s, [ownerCall(c) as OwnerAction]));
  await until(
    () => onChainPolicy((cn, m, a) => viewer.view(cn, m, a), contract, custodyKeyOf(s.wallet!.account)),
    (v) => v?.frozen === frozen,
  );
  const { venue } = executorVenue(s);
  log("executor's gate", JSON.stringify((await venue.wallet!.check()) ?? "the wallet may sign"));
  if (!frozen) return;
  try {
    await venue.ready();
    log("x the executor's venue would send while frozen");
    process.exitCode = 1;
  } catch (e) {
    if (!(e instanceof VenueError)) throw e;
    log(`+ the executor waits (retryable ${e.retryable}): ${e.message}`);
  }
  try {
    await walletOf(s).call({ receiverId: s.account, methodName: "session_call", args: { action: "faucet" }, gas: "150000000000000", deposit: "0" });
    log("x the enclave signed while frozen");
    process.exitCode = 1;
  } catch (e) {
    if (!(e instanceof PolicyRefusal)) throw e;
    log(`+ the enclave refuses too (${e.code}): ${e.message}`);
  }
}

async function fund(near: string) {
  const s = load()!;
  const yocto = BigInt(Math.round(Number(near) * 1e6)) * 10n ** 18n;
  record(s, `fund_${Date.now()}`, await owner(s, [{ transfer: { receiver_id: s.wallet!.account, amount: yocto.toString() } }]));
}

async function show() {
  const s = load()!;
  const w = walletOf(s);
  console.log(
    JSON.stringify(
      {
        account: s.account,
        wallet: s.wallet!.account,
        onChain: await onChainPolicy((c, m, a) => viewer.view(c, m, a), contract, custodyKeyOf(s.wallet!.account)),
        enclave: await w.policy(),
        session: await viewer.view<Session | null>(s.account, "session", { public_key: nearKeyOf(s.wallet!.account) }),
        walletNear: (await viewer.balance(s.wallet!.account).catch(() => 0n)).toString(),
        txs: s.txs,
      },
      null,
      2,
    ),
  );
}

const cmd = process.argv[2];
if (cmd === "setup") await setup();
else if (cmd === "call") await call();
else if (cmd === "outside") await outside();
else if (cmd === "freeze") await freeze(true);
else if (cmd === "unfreeze") await freeze(false);
else if (cmd === "fund") await fund(process.argv[3] ?? "0.1");
else if (cmd === "show") await show();
else {
  console.error("usage: bun scripts/policy-wallet.ts setup|call|outside|freeze|unfreeze|fund <NEAR>|show");
  process.exit(2);
}
