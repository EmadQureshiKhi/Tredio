/**
 * Paid private signals on NEAR testnet, as the app does them, against a running API:
 *   1. two passkey accounts (a leader and a follower), each with a session key and test USDC,
 *   2. the leader links a caller identity and opens a channel (price, period, reveal delay),
 *   3. the leader signs a signal and commits its hash on chain (a 0.000001 USDC transfer to the
 *      treasury whose memo is the hash, an owner request the relayer sends), and the API takes it sealed,
 *   4. the follower is refused the viewing keys, pays the leader's price to the leader's account (memo
 *      `tredio-signals:<identity>`), claims early access, and opens the sealed signal with the week's key.
 *
 *   bun scripts/signals-demo.ts              (API at http://localhost:4000, or API_URL)
 *
 * Accounts and keys are kept in internal/scratch/signals-demo.json (gitignored), so a second run
 * picks them up again and costs only the transfers. Each new account costs the relayer 0.4 NEAR.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ACCESS_MEMO_PREFIX, COMMIT_AMOUNT, COMMIT_MEMO_PREFIX, channelMessage, matchesCommitment, openSignal, signalCommitment, signalMessage } from "@tredio/autopilot";
import { nep413Hash, Sender } from "@tredio/chain";
import { AccountVersions, calls, type OwnerAction, type OwnerApprovalRequest, ownerApprovalDigest, ownerRequest, ownerRequests, requestJson, sessionCallTgas, upgradeToLatest } from "@tredio/contracts";
import { bs58decode, D, newEd25519, nowSecs, RPC, SoftPasskey, senderFor, testnetOnly, viewer } from "./lib/network";

testnetOnly("signals-demo");

const ROOT = join(import.meta.dir, "..");
const API = (process.env.API_URL ?? "http://localhost:4000").replace(/\/$/, "");
const STATE = join(ROOT, "internal/scratch/signals-demo.json");
const C = calls(D);
const USDC = 1_000_000n;
const PRICE = 1n * USDC;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const relayer = senderFor("tredio-relayer.testnet");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

interface Person {
  passkey: string;
  account: string;
  session: { publicKey: string; secretKey: string };
}
interface State {
  leader?: Person;
  follower?: Person;
  identity?: string;
}
const state: State = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const save = () => writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);

async function api<T>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}
async function ok<T>(what: string, r: Promise<{ status: number; body: T }>): Promise<T> {
  const { status, body } = await r;
  if (status >= 300) throw new Error(`${what}: HTTP ${status} ${JSON.stringify(body)}`);
  return body;
}

/** A passkey account with a session key and test USDC, created on the first run and kept. */
async function person(name: "leader" | "follower"): Promise<Person> {
  const known = state[name];
  if (known) return known;
  const passkey = new SoftPasskey();
  const account = await viewer.view<string>(D.contracts.accounts, "account_id_of", { owner_key: passkey.publicKeyHex });
  const session = newEd25519();
  const upgrade = upgradeToLatest(D);
  const first: OwnerAction[] = [
    {
      add_session: {
        public_key: session.publicKey,
        label: `signals-${name}`,
        scope: { outcomes: true, perps: true, hyperliquid: false },
        expires_at: nowSecs() + 30 * 86_400,
        daily_limit: (50n * USDC).toString(),
        gas_key: true,
        gas_funding: (32n * 10n ** 22n).toString(),
      },
    },
    ...(upgrade ? [upgrade] : []),
  ];
  const request = requestJson(ownerRequest(account, "testnet", first));
  const created = await relayer.send(C.accounts.create(passkey.publicKeyHex, (4n * 10n ** 23n).toString(), { request, proof: await passkey.prove(request) }));
  log(name, account, "created in", created.hash);
  await Bun.sleep(3000);
  const version = await new AccountVersions((a) => viewer.view<number>(a, "version")).of(account);
  const user = new Sender({ network: "testnet", accountId: account, privateKey: session.secretKey, gasKeyLanes: 1, rpc: RPC });
  const drip = await user.send(C.account.sessionCall(account, "faucet", sessionCallTgas(version)));
  log(name, "test USDC from the faucet", drip.hash);
  const p = { passkey: hex(passkey.secret), account, session };
  state[name] = p;
  save();
  return p;
}
const passkeyOf = (p: Person) => new SoftPasskey(new Uint8Array(Buffer.from(p.passkey, "hex")));

/** API sign-in with the session key (NEP-413, recipient tredio.bid). */
async function signIn(p: Person): Promise<string> {
  const issuedAt = nowSecs();
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const message = `Tredio sign-in\naccount: ${p.account}\nkey: ${p.session.publicKey}\nissued: ${issuedAt}`;
  const seed = bs58decode(p.session.secretKey.replace(/^ed25519:/, "")).slice(0, 32);
  const signature = Buffer.from(ed25519.sign(nep413Hash({ message, nonce, recipient: "tredio.bid" }), seed)).toString("base64");
  const r = await ok<{ token: string }>("sign-in", api("POST", "/v1/auth/session", { account: p.account, signer: p.session.publicKey, issuedAt, signature, nonce }));
  return r.token;
}

/** The passkey's approval of one API action: a WebAuthn assertion over the approval digest. */
async function approve(p: Person, token: string, request: OwnerApprovalRequest) {
  const ch = await ok<{ nonce: string; expiresAt: number; network: "testnet" }>("approval challenge", api("POST", "/v1/owner-approvals", { action: request.action }, token));
  const digest = await ownerApprovalDigest({ network: ch.network, account: p.account, request, nonce: ch.nonce, expiresAt: ch.expiresAt });
  const clientDataJson = JSON.stringify({ type: "webauthn.get", challenge: b64url(digest), origin: "https://app.tredio.bid" });
  const auth = new Uint8Array([...sha256(new TextEncoder().encode("tredio.bid")), 0x05, 0, 0, 0, 1]);
  const msg = new Uint8Array([...auth, ...sha256(new TextEncoder().encode(clientDataJson))]);
  const sig = p256.sign(sha256(msg), passkeyOf(p).secret, { prehash: false, lowS: true });
  return { nonce: ch.nonce, authenticator_data: b64url(auth), client_data_json: clientDataJson, signature: hex(sig) };
}

/** A USDC transfer with a memo from a passkey account: one owner request, sent by the relayer as the app's are. */
async function sendUsdc(p: Person, to: string, amount: bigint, memo: string) {
  const actions: OwnerAction[] = [];
  const registered = await viewer.view<unknown>(D.contracts.usdc, "storage_balance_of", { account_id: to });
  if (!registered) {
    const s = C.usdc.storageDeposit(to);
    actions.push({ call: { receiver_id: s.receiverId, method_name: s.methodName, args: Buffer.from(JSON.stringify(s.args)).toString("base64"), deposit: s.deposit, gas: s.gas } });
  }
  const t = C.usdc.transfer(to, amount.toString(), memo);
  actions.push({ call: { receiver_id: t.receiverId, method_name: t.methodName, args: Buffer.from(JSON.stringify(t.args)).toString("base64"), deposit: t.deposit, gas: t.gas } });
  const request = requestJson(ownerRequest(p.account, "testnet", actions));
  return relayer.send(C.account.ownerExecute(p.account, request, await passkeyOf(p).prove(request)));
}

// 1. Accounts.
const leader = await person("leader");
const follower = await person("follower");
const leaderToken = await signIn(leader);
const followerToken = await signIn(follower);
log("signed in", leader.account, "and", follower.account);

// 2. The leader's caller identity, linked to its account with one passkey approval, and its channel.
const identitySeed = state.identity ? new Uint8Array(Buffer.from(state.identity, "hex")) : ed25519.utils.randomSecretKey();
state.identity = hex(identitySeed);
save();
const identity = hex(ed25519.getPublicKey(identitySeed));
const signAs = (message: string) => Buffer.from(ed25519.sign(new TextEncoder().encode(message), identitySeed)).toString("base64");
const caller = await api<{ caller: { linked_account: string | null } | null }>("GET", `/v1/callers/${identity}?optional=1`);
if (caller.body.caller?.linked_account !== leader.account) {
  const issuedAt = nowSecs();
  const identitySignature = signAs(`Tredio link\nidentity: ${identity}\naccount: ${leader.account}\nissued: ${issuedAt}`);
  await ok("link", api("POST", "/v1/callers/link", { identity, account: leader.account, issuedAt, identitySignature, approval: await approve(leader, leaderToken, ownerRequests.linkIdentity(identity)) }));
  log("linked identity", identity, "to", leader.account);
}
const terms = { priceUsdc: PRICE.toString(), periodDays: 7, revealDelaySec: 900 };
const issued = nowSecs();
await ok("channel", api("PUT", "/v1/signals/channel", { caller: identity, ...terms, issuedAt: issued, signature: signAs(channelMessage({ ...terms, issuedAt: issued })) }));
log("channel open: 1 USDC for 7 days, public after 15 minutes");

// 3. A signal: signed, committed on chain, then taken sealed.
const fields = { kind: "open" as const, market: "BTC", side: "long" as const, marginUsdc: 50, leverage: 3, note: "Attention on BTC is climbing faster than price." };
const signedAt = nowSecs();
const commitment = await signalCommitment(identity, { ...fields, issuedAt: signedAt });
const commit = await sendUsdc(leader, D.treasury, COMMIT_AMOUNT, COMMIT_MEMO_PREFIX + commitment);
log("commitment", commitment, "in", commit.hash);
const published = await ok<{ signal: { id: number; revealAt: number } }>(
  "publish",
  api("POST", "/v1/signals", { caller: identity, signal: fields, issuedAt: signedAt, signature: signAs(await signalMessage(identity, { ...fields, issuedAt: signedAt })), commitTx: commit.hash, commitSender: relayer.accountId }),
);
log("signal", published.signal.id, "sealed until", new Date(published.signal.revealAt * 1000).toISOString());

// 4. The follower: refused, pays, claims, reads.
const refused = await api<{ priceUsdc: string; payTo: string }>("GET", `/v1/signals/${identity}/keys`, undefined, followerToken);
const accessBefore = await api<{ active: boolean }>("GET", `/v1/signals/${identity}/access`, undefined, followerToken);
if (refused.status === 402) log("keys refused without access:", JSON.stringify(refused.body));
else if (!accessBefore.body.active) throw new Error(`expected 402 for the keys, got ${refused.status}`);
const payment = await sendUsdc(follower, leader.account, PRICE, ACCESS_MEMO_PREFIX + identity);
log("paid", leader.account, "1 USDC in", payment.hash);
const access = await ok<{ startsAt: number; expiresAt: number }>("claim", api("POST", `/v1/signals/${identity}/access`, { tx: payment.hash, sender: relayer.accountId }, followerToken));
log("early access until", new Date(access.expiresAt * 1000).toISOString());
const { keys } = await ok<{ keys: Array<{ epoch: number; key: string }> }>("keys", api("GET", `/v1/signals/${identity}/keys`, undefined, followerToken));
const feed = await ok<{ signals: Array<{ id: number; epoch: number; iv: string; ciphertext: string; commitment: string; signal: unknown }> }>("feed", api("GET", `/v1/signals?leader=${identity}&limit=5`));
const item = feed.signals.find((s) => s.id === published.signal.id)!;
if (item.signal !== null) throw new Error("the signal is public before its reveal");
const key = keys.find((k) => k.epoch === item.epoch)?.key;
if (!key) throw new Error(`no key for week ${item.epoch}`);
const opened = await openSignal(key, item, item.commitment);
if (!(await matchesCommitment(opened, item.commitment))) throw new Error("the opened signal does not match its commitment");
log("opened early:", JSON.stringify(opened));

const proofsFile = join(ROOT, "deployments/testnet-proofs.json");
const proofs = JSON.parse(readFileSync(proofsFile, "utf8")) as Record<string, unknown>;
proofs.signals = {
  leaderIdentity: identity,
  leaderAccount: leader.account,
  follower: follower.account,
  commitTx: commit.hash,
  commitment,
  accessTx: payment.hash,
  relayer: relayer.accountId,
  price: PRICE.toString(),
};
writeFileSync(proofsFile, `${JSON.stringify(proofs, null, 2)}\n`);
log("recorded in deployments/testnet-proofs.json");
log("explorer", `https://testnet.nearblocks.io/txns/${commit.hash}`, `https://testnet.nearblocks.io/txns/${payment.hash}`);
