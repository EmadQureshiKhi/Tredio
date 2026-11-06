/**
 * Helpers for scripts that drive a deployment, on the network NEAR_NETWORK names (testnet unless
 * set): service keys from the local NEAR keychain (or env), a simulated passkey that signs
 * WebAuthn assertions like a browser, and the oracle report signer.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { p256 } from "@noble/curves/nist.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { deployment, deploymentPlan, isDeployed, type Network, requestChallenge, type PasskeyProof } from "@tredio/contracts";
import { rpcEndpoints, Sender, Viewer } from "@tredio/chain";

export const NETWORK: Network = process.env.NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
/** The deployment; before mainnet is deployed, its plan (scripts that prepare the deploy, such as gas keys, run then). */
export const D = isDeployed(NETWORK) ? deployment(NETWORK) : deploymentPlan(NETWORK);
/** FastNEAR API keys from FASTNEAR_API_KEYS (comma-separated) lead, as in the services. */
export const RPC = rpcEndpoints(NETWORK, [], (process.env.FASTNEAR_API_KEYS ?? "").split(","));
export const viewer = new Viewer(NETWORK, RPC);

/** Stops a script that needs testnet (the test USDC faucet, test windows) from running anywhere else. */
export function testnetOnly(script: string): void {
  if (NETWORK !== "testnet") throw new Error(`${script} runs on testnet only: it uses the test USDC faucet`);
}

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** The private key of `accountId` from env (`<ACCOUNT>_KEY`) or ~/.near-credentials/<network>. */
export function keyOf(accountId: string): string {
  const env = process.env[`${accountId.replace(/[^a-z0-9]/gi, "_").toUpperCase()}_KEY`];
  if (env) return env;
  const file = join(homedir(), ".near-credentials", NETWORK, `${accountId}.json`);
  if (!existsSync(file)) throw new Error(`no key for ${accountId}: set its _KEY env var`);
  return JSON.parse(readFileSync(file, "utf8")).private_key as string;
}

export const senderFor = (accountId: string, gasKeyLanes?: number) =>
  new Sender({ network: NETWORK, accountId, privateKey: keyOf(accountId), gasKeyLanes, rpc: RPC });

/** A software passkey: P-256 over SHA-256(authData || SHA-256(clientDataJSON)), as WebAuthn does. */
export class SoftPasskey {
  readonly secret: Uint8Array;
  constructor(seed?: Uint8Array) {
    this.secret = seed ?? p256.utils.randomSecretKey();
  }

  get publicKeyHex(): string {
    return hex(p256.getPublicKey(this.secret, true));
  }

  async prove(request: string): Promise<PasskeyProof> {
    const challenge = b64url(await requestChallenge(request));
    const clientDataJson = JSON.stringify({ type: "webauthn.get", challenge, origin: "https://app.tredio.bid" });
    const auth = new Uint8Array([...sha256(new TextEncoder().encode("tredio.bid")), 0x05, 0, 0, 0, 1]);
    const message = new Uint8Array([...auth, ...sha256(new TextEncoder().encode(clientDataJson))]);
    const sig = p256.sign(sha256(message), this.secret, { prehash: false, lowS: true });
    return { authenticator_data: b64url(auth), client_data_json: clientDataJson, signature: hex(sig) };
  }
}

/** Signs an oracle report with a key file `{ secret_key: "ed25519:<base58 seed+pub>" }`. */
export function signReport(reportJson: string, secretKey: string): string {
  const raw = bs58decode(secretKey.replace(/^ed25519:/, "")).slice(0, 32);
  const sig = ed25519.sign(sha256(new TextEncoder().encode(reportJson)), raw);
  return Buffer.from(sig).toString("base64");
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function bs58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

export function bs58encode(b: Uint8Array): string {
  let n = BigInt("0x" + (hex(b) || "0"));
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** A fresh ed25519 key pair in NEAR's string form. */
export function newEd25519(): { publicKey: string; secretKey: string } {
  const sk = ed25519.utils.randomSecretKey();
  const pk = ed25519.getPublicKey(sk);
  return { publicKey: `ed25519:${bs58encode(pk)}`, secretKey: `ed25519:${bs58encode(new Uint8Array([...sk, ...pk]))}` };
}

export const nowSecs = () => Math.floor(Date.now() / 1000);
