/**
 * Gives a service account a gas key: a full-access key with its own prepaid NEAR for gas and N
 * parallel nonces (NEP-611), so the service sends N transactions at once without nonce clashes
 * and its gas spend shows on its own. The new secret key is written to internal/keys/ (gitignored)
 * for the service's .env (`<SERVICE>_PRIVATE_KEY` and `<SERVICE>_GAS_KEY_LANES`).
 *
 *   bun scripts/gas-keys.ts <account> [lanes=4] [fund NEAR=1]
 *
 * NEAR_NETWORK picks the network (testnet unless set; #mainnet service accounts need gas keys too).
 * The account signs with its current key (env `<ACCOUNT>_KEY` or ~/.near-credentials/<network>).
 * A gas key pays at the prepaid gas price for the gas a transaction attaches (about 0.3 NEAR for
 * 300 Tgas) and gets the unused part back, so fund at least 0.3 NEAR per lane that sends large calls.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58Encode, toNear } from "@tredio/chain";
import { senderFor, viewer } from "./lib/network";

const [account, lanesArg = "4", fundArg = "1"] = process.argv.slice(2);
if (!account) throw new Error("usage: bun scripts/gas-keys.ts <account> [lanes] [fund NEAR]");
const lanes = Number(lanesArg);
const fund = BigInt(Math.round(Number(fundArg) * 1e6)) * 10n ** 18n;

const seed = ed25519.utils.randomSecretKey();
const pub = ed25519.getPublicKey(seed);
const publicKey = `ed25519:${base58Encode(pub)}`;
const secretKey = `ed25519:${base58Encode(new Uint8Array([...seed, ...pub]))}`;

const owner = senderFor(account);
// Saved first, so a failure after the key lands never loses it.
mkdirSync("internal/keys", { recursive: true });
const file = `internal/keys/${account}-gas.json`;
writeFileSync(file, JSON.stringify({ account, public_key: publicKey, secret_key: secretKey, lanes }, null, 2));
const o = await owner.sendTx((tx) => tx.addKey(publicKey, { type: "gasKeyFullAccess", numNonces: lanes }).transferToGasKey(publicKey, `${fund} yocto` as never));
const key = await viewer.gasKey(account, publicKey);
console.log(JSON.stringify({ account, publicKey, lanes, funded: key ? toNear(key.balance) : null, tx: o.transaction?.hash, saved: file }));
