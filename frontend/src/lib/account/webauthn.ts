import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { PasskeyProof } from "@tredio/contracts";
import { base58Decode, base58Encode, base64UrlDecode, base64UrlEncode, type Bytes, concatBytes, hexEncode, own, randomBytes, utf8 } from "@/lib/chain/encoding";

/**
 * The passkey ceremonies the account contract needs. The passkey is a WebAuthn P-256 credential
 * (ES256 only, so the contract's `p256_verify` can check it); its compressed public key is the
 * account's owner key, `p256:<base58>`. The contract verifies an assertion over a chosen
 * challenge: SHA-256(authenticatorData || SHA-256(clientDataJSON)), signature as 64-byte r || s.
 *
 * Every ceremony also asks for the PRF extension with two salts: the first wraps the trading
 * session key stored on this device, the second derives the private-data keys (caller identity,
 * vault). Authenticators without PRF still work; their private keys simply stay locked.
 */

const ES256 = -7;
const TIMEOUT_MS = 120_000;

const salt = (label: string): Bytes => own(sha256(utf8(label)));
export const PRF_SALTS = { session: salt("tredio.session-store.v1"), private: salt("tredio.private-data.v1") };

export interface PrfOutputs {
  session: Bytes | null;
  private: Bytes | null;
}

/** The user cancelled the prompt or it timed out: nothing was signed. */
export class PasskeyCancelled extends Error {
  constructor() {
    super("The passkey request was cancelled or timed out.");
    this.name = "PasskeyCancelled";
  }
}

export class PasskeyUnsupported extends Error {}

function rethrow(e: unknown): never {
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "AbortError") throw new PasskeyCancelled();
  if (name === "InvalidStateError") throw new Error("This device already holds a Tredio passkey for this site. Sign in with it instead.");
  if (name === "NotSupportedError") throw new PasskeyUnsupported("This device cannot make the kind of passkey Tredio needs (P-256). Try iCloud Keychain, Google Password Manager, 1Password or your phone.");
  if (name === "SecurityError") throw new Error("Passkeys need a secure page (https or localhost) on Tredio's own address.");
  throw e instanceof Error ? e : new Error(String(e));
}

export function supportsPasskeys(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && Boolean(navigator.credentials);
}

type PrfResults = { enabled?: boolean; results?: { first?: BufferSource; second?: BufferSource } };

function bytesOf(source: BufferSource | undefined): Bytes | null {
  if (!source) return null;
  return source instanceof ArrayBuffer ? new Uint8Array(source.slice(0)) : own(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
}

function prfOf(credential: PublicKeyCredential): PrfOutputs {
  const prf = (credential.getClientExtensionResults() as { prf?: PrfResults }).prf;
  return { session: bytesOf(prf?.results?.first), private: bytesOf(prf?.results?.second) };
}

const prfInput = () => ({ prf: { eval: { first: PRF_SALTS.session, second: PRF_SALTS.private } } }) as AuthenticationExtensionsClientInputs;

/** The compressed P-256 key of an uncompressed SPKI public key, as the contract stores it. */
export function ownerKeyFromSpki(spki: Uint8Array): string {
  if (spki.length < 65) throw new Error("The passkey did not report a P-256 public key.");
  const point = p256.Point.fromBytes(spki.slice(spki.length - 65));
  return `p256:${base58Encode(point.toBytes(true))}`;
}

export const ownerKeyHex = (ownerKey: string) => hexEncode(base58Decode(ownerKey.replace(/^p256:/, "")));

export interface CreatedPasskey {
  credentialId: string;
  ownerKey: string;
  prf: PrfOutputs;
}

/** Creates a passkey for Tredio on this site (one prompt). */
export async function createPasskey(rp: { id: string; name: string }, userName: string): Promise<CreatedPasskey> {
  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.create({
      publicKey: {
        rp,
        user: { id: randomBytes(16), name: userName, displayName: userName },
        challenge: randomBytes(32),
        // ES256 only: the account verifies P-256 signatures alone, so an RSA-only authenticator
        // refuses here instead of making a passkey the account could never use.
        pubKeyCredParams: [{ type: "public-key", alg: ES256 }],
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
        attestation: "none",
        timeout: TIMEOUT_MS,
        extensions: prfInput(),
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    rethrow(e);
  }
  if (!credential) throw new PasskeyCancelled();
  const response = credential.response as AuthenticatorAttestationResponse;
  const spki = response.getPublicKey?.();
  if (!spki) throw new PasskeyUnsupported("This browser does not report the passkey's public key. Update it, or use another browser.");
  return { credentialId: base64UrlEncode(new Uint8Array(credential.rawId)), ownerKey: ownerKeyFromSpki(new Uint8Array(spki)), prf: prfOf(credential) };
}

const N = p256.Point.CURVE().n;

/** A DER signature as 64-byte r || s hex with s in the lower half of the order (low-S). */
export function compactLowS(der: Uint8Array): string {
  const sig = p256.Signature.fromBytes(der, "der");
  const s = sig.s > N / 2n ? N - sig.s : sig.s;
  return hexEncode(new p256.Signature(sig.r, s).toBytes("compact"));
}

export interface Assertion {
  credentialId: string;
  proof: PasskeyProof;
  prf: PrfOutputs;
  /** What the signature covers and the signature itself, to find which public key made it. */
  signed: { hash: Uint8Array; der: Uint8Array };
}

/**
 * One prompt: the passkey signs `challenge`. With `credentialId` only that passkey is offered;
 * without it the device lets the user pick any of their Tredio passkeys.
 */
export async function assert(rpId: string, challenge: Uint8Array, credentialId?: string | null): Promise<Assertion> {
  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.get({
      publicKey: {
        rpId,
        challenge: own(challenge),
        allowCredentials: credentialId ? [{ type: "public-key", id: base64UrlDecode(credentialId) }] : [],
        userVerification: "required",
        timeout: TIMEOUT_MS,
        extensions: prfInput(),
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    rethrow(e);
  }
  if (!credential) throw new PasskeyCancelled();
  const r = credential.response as AuthenticatorAssertionResponse;
  const authenticatorData = new Uint8Array(r.authenticatorData);
  const clientDataJson = new TextDecoder().decode(r.clientDataJSON);
  const der = new Uint8Array(r.signature);
  return {
    credentialId: base64UrlEncode(new Uint8Array(credential.rawId)),
    proof: { authenticator_data: base64UrlEncode(authenticatorData), client_data_json: clientDataJson, signature: compactLowS(der) },
    prf: prfOf(credential),
    signed: { hash: sha256(concatBytes(authenticatorData, sha256(utf8(clientDataJson)))), der },
  };
}

/**
 * The owner keys that could have made an assertion. WebAuthn reveals a passkey's public key only at
 * creation, so on a new device the key is recovered from a signature: ECDSA gives two candidates
 * (one per recovery bit), and the account that exists on chain for one of them is the passkey's.
 */
export function candidateOwnerKeys(a: Assertion): string[] {
  const sig = p256.Signature.fromBytes(a.signed.der, "der");
  const out: string[] = [];
  for (const bit of [0, 1]) {
    try {
      const point = sig.addRecoveryBit(bit).recoverPublicKey(a.signed.hash);
      out.push(`p256:${base58Encode(point.toBytes(true))}`);
    } catch {
      // No point for this recovery bit.
    }
  }
  return out;
}
