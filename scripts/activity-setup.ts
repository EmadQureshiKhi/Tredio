/**
 * Sets up the demo traders apps/activity runs on testnet (JUDGES.md discloses them):
 *   1. the funder `activity.tredio-treasury.testnet`, a subaccount of the treasury that pays for the
 *      personas' accounts and keeps their session gas keys topped up,
 *   2. one passkey account per persona in apps/activity's roster, created with a gas-key session in
 *      its first request, as the app creates accounts (the funder pays the 0.4 NEAR),
 *   3. its first test USDC through that session, and its caller profile (handle and bio).
 * Resumable: personas already in the file are left alone. Keys go to internal/keys/ (gitignored).
 *
 *   bun scripts/activity-setup.ts [--count 12] [--days 16]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Sender } from "@tredio/chain";
import { calls, type OwnerAction, ownerRequest, requestJson, upgradeToLatest } from "@tredio/contracts";
import { type Persona, ROSTER } from "../apps/activity/src/personas";
import { Caller, identityOf } from "../apps/activity/src/social";
import { D, RPC, SoftPasskey, newEd25519, nowSecs, senderFor, testnetOnly, viewer } from "./lib/network";

testnetOnly("activity-setup");

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const COUNT = Math.min(option("--count", ROSTER.length), ROSTER.length);
const DAYS = option("--days", 16);
const FUNDER = "activity.tredio-treasury.testnet";
const FUNDER_FILE = "internal/keys/activity-funder.json";
const PERSONAS_FILE = "internal/keys/activity-personas.json";
const API = process.env.TREDIO_API_URL ?? "https://api.tredio.bid";
const C = calls(D);
const USDC = 1_000_000n;
const NEAR = 10n ** 24n;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function exists(account: string): Promise<boolean> {
  return viewer
    .rpc("query", { request_type: "view_account", finality: "final", account_id: account })
    .then(() => true)
    .catch(() => false);
}

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 30_000): Promise<T | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read().catch(() => undefined);
    if ((v !== undefined && done(v)) || Date.now() > end) return v;
    await Bun.sleep(1_500);
  }
}

// 1. The funder.
if (!existsSync(FUNDER_FILE)) {
  const key = newEd25519();
  writeFileSync(FUNDER_FILE, JSON.stringify({ account_id: FUNDER, public_key: key.publicKey, private_key: key.secretKey }, null, 2), { mode: 0o600 });
}
const funderKey = JSON.parse(readFileSync(FUNDER_FILE, "utf8")) as { public_key: string; private_key: string };
if (!(await exists(FUNDER))) {
  const treasury = senderFor("tredio-treasury.testnet");
  const opening = BigInt(Math.ceil(COUNT * 0.45 + 3)) * NEAR;
  await treasury.sendTx((tx) => tx.createAccount(FUNDER).transfer(FUNDER, `${opening} yocto` as never).addKey(funderKey.public_key, { type: "fullAccess" } as never));
  log("funder", FUNDER, "created with", Number(opening / NEAR), "NEAR");
}
const funder = new Sender({ network: "testnet", accountId: FUNDER, privateKey: funderKey.private_key, rpc: RPC });

// 2 and 3. The personas.
const personas: Persona[] = existsSync(PERSONAS_FILE) ? (JSON.parse(readFileSync(PERSONAS_FILE, "utf8")) as Persona[]) : [];
const save = () => writeFileSync(PERSONAS_FILE, JSON.stringify(personas, null, 2), { mode: 0o600 });
const upgrade = upgradeToLatest(D);

for (const entry of ROSTER.slice(0, COUNT)) {
  if (personas.some((p) => p.handle === entry.handle)) continue;
  const passkey = new SoftPasskey();
  const account = await viewer.view<string>(D.contracts.accounts, "account_id_of", { owner_key: passkey.publicKeyHex });
  const session = newEd25519();
  const first: OwnerAction[] = [
    {
      add_session: {
        public_key: session.publicKey,
        label: "web",
        scope: { outcomes: true, perps: true, hyperliquid: true },
        expires_at: nowSecs() + DAYS * 86_400,
        daily_limit: (500n * USDC).toString(),
        gas_key: true,
        gas_funding: (32n * 10n ** 22n).toString(),
      },
    },
    ...(upgrade ? [upgrade] : []),
  ];
  const request = requestJson(ownerRequest(account, "testnet", first));
  const created = await funder.send(C.accounts.create(passkey.publicKeyHex, (4n * 10n ** 23n).toString(), { request, proof: await passkey.prove(request) }));
  await until(
    () => viewer.rpc<{ keys: unknown[] }>("query", { request_type: "view_access_key_list", finality: "final", account_id: account }),
    (k) => k.keys.length > 0,
  );
  const identitySecret = randomBytes(32).toString("hex");
  const persona: Persona = {
    ...entry,
    account,
    passkeySecret: Buffer.from(passkey.secret).toString("hex"),
    sessionPublicKey: session.publicKey,
    sessionSecretKey: session.secretKey,
    identitySecret,
    identity: identityOf(identitySecret),
  };
  personas.push(persona);
  save();
  log(entry.handle, "account", account, "created in", created.hash);

  // Its first test USDC, through the session (150 Tgas on account code v2 and later).
  const user = new Sender({ network: "testnet", accountId: account, privateKey: session.secretKey, gasKeyLanes: 4, rpc: RPC });
  const drip = await user.send(C.account.sessionCall(account, "faucet", 150)).catch((e: Error) => ({ hash: `failed: ${e.message.slice(0, 120)}` }));
  log(entry.handle, "faucet", drip.hash);

  const caller = new Caller(identitySecret, API);
  await caller.profile(entry.handle, entry.bio).then(
    () => log(entry.handle, "profile set, caller", persona.identity.slice(0, 12)),
    (e: Error) => log(entry.handle, "profile failed:", e.message),
  );
}
log(`${personas.length} personas in ${PERSONAS_FILE}; funder ${FUNDER} (${FUNDER_FILE})`);
