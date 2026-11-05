/**
 * Sealed boxes for Autopilot grants (ECIES: P-256 ECDH, HKDF-SHA256, AES-256-GCM, WebCrypto only,
 * so the same code runs in the browser, the API server and the executor). The app generates a
 * grant's session key in the browser and seals it to the executor's public key; the API server
 * stores the box and never sees the key, and only the executor, which holds the private key, can
 * open it.
 *
 * v2 (current): "v2." then base64url of recipient key id (8 bytes) | ephemeral public key (65,
 * uncompressed) | IV (12) | ciphertext and tag. The box is bound to the account and the session
 * key's id: both go into the HKDF info and, with the header, into the AES-GCM associated data,
 * so a box moved to another account or key does not open. The key id (the first 8 bytes of SHA-256
 * of the recipient's raw public key) lets the API refuse a box sealed to another executor.
 *
 * v1 (legacy, sealed by the API server): base64url of ephemeral public key | IV | ciphertext and
 * tag, with only the ephemeral key as associated data. It still opens, so grants made before v2
 * keep working; nothing seals v1 any more.
 */

/** Who a sealed grant key belongs to: the account, and the id of the session key inside. */
export interface GrantBinding {
  owner: string;
  sessionKey: string;
}

export const SEAL_VERSION = 2;
const V2_PREFIX = "v2.";
const V1_INFO = new TextEncoder().encode("tredio-autopilot-grant-v1");
const V2_INFO = new TextEncoder().encode("tredio-autopilot-grant-v2");
const KEY_ID = 8;
const EPH = 65;
const IV = 12;
const TAG = 16;

type Bytes = Uint8Array<ArrayBuffer>;

const b64url = (b: Uint8Array): string => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function fromB64url(s: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("sealed box is not base64url");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** An account or key id as a box binds it: lowercase UTF-8 behind a one-byte length. */
function idBytes(id: string): Bytes {
  const raw = new TextEncoder().encode(id.trim().toLowerCase());
  if (raw.length === 0 || raw.length > 255) throw new Error(`not an account or key id: ${id}`);
  return concat(Uint8Array.of(raw.length), raw);
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** What a v2 box is bound to, for the HKDF info and the associated data. */
const bindingBytes = (b: GrantBinding) => concat(idBytes(b.owner), idBytes(b.sessionKey));

async function aesKey(shared: ArrayBuffer, salt: Bytes, info: Bytes, usage: KeyUsage): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info }, ikm, { name: "AES-GCM", length: 256 }, false, [usage]);
}

async function keyIdBytes(rawPublicKey: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", rawPublicKey)).slice(0, KEY_ID);
}

/** A new executor key pair: the private key as base64url PKCS#8, the public key as base64url raw. */
export async function generateSealKeyPair(): Promise<{ privateKey: string; publicKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  return {
    privateKey: b64url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
    publicKey: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
  };
}

/** The id of a recipient's public key (hex), as v2 boxes carry it. */
export async function sealKeyId(publicKey: string): Promise<string> {
  return hex(await keyIdBytes(fromB64url(publicKey)));
}

/** The recipient key id a box names (hex), or null for a legacy v1 box or one that is malformed. */
export function boxKeyId(box: string): string | null {
  if (!box.startsWith(V2_PREFIX)) return null;
  try {
    const bytes = fromB64url(box.slice(V2_PREFIX.length));
    return bytes.length >= KEY_ID + EPH + IV + TAG ? hex(bytes.slice(0, KEY_ID)) : null;
  } catch {
    return null;
  }
}

/** Seals `plaintext` (a grant's session key) to the executor's public key, bound to `binding` (v2). */
export async function seal(plaintext: string, recipientPublicKey: string, binding: GrantBinding): Promise<string> {
  const recipientRaw = fromB64url(recipientPublicKey);
  const recipient = await crypto.subtle.importKey("raw", recipientRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const ephRaw = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: recipient }, eph.privateKey, 256);
  const keyId = await keyIdBytes(recipientRaw);
  const bound = bindingBytes(binding);
  const iv = crypto.getRandomValues(new Uint8Array(IV));
  const key = await aesKey(shared, ephRaw, concat(V2_INFO, bound), "encrypt");
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: concat(keyId, ephRaw, bound) }, key, new TextEncoder().encode(plaintext)));
  return V2_PREFIX + b64url(concat(keyId, ephRaw, iv, ct));
}

/**
 * Opens a box with the executor's private key. A v2 box opens only for the account and session key
 * it was sealed for; a legacy v1 box carries no binding, so the caller must check what it opens to.
 */
export async function open(box: string, recipientPrivateKey: string, binding: GrantBinding): Promise<string> {
  const v2 = box.startsWith(V2_PREFIX);
  const bytes = fromB64url(v2 ? box.slice(V2_PREFIX.length) : box);
  const header = v2 ? KEY_ID : 0;
  if (bytes.length < header + EPH + IV + TAG) throw new Error("sealed box is too short");
  const ephRaw = bytes.slice(header, header + EPH);
  const iv = bytes.slice(header + EPH, header + EPH + IV);
  const ct = bytes.slice(header + EPH + IV);
  // Extractable only to read the public half, for the key id.
  const priv = await crypto.subtle.importKey("pkcs8", fromB64url(recipientPrivateKey), { name: "ECDH", namedCurve: "P-256" }, v2, ["deriveBits"]);
  const eph = await crypto.subtle.importKey("raw", ephRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: eph }, priv, 256);
  if (!v2) {
    const key = await aesKey(shared, ephRaw, V1_INFO, "decrypt");
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: ephRaw }, key, ct));
  }
  const keyId = bytes.slice(0, KEY_ID);
  const jwk = await crypto.subtle.exportKey("jwk", priv);
  const ownRaw = concat(new Uint8Array([4]), fromB64url(jwk.x!), fromB64url(jwk.y!));
  if (hex(await keyIdBytes(ownRaw)) !== hex(keyId)) throw new Error("sealed box is for another executor key");
  const bound = bindingBytes(binding);
  const key = await aesKey(shared, ephRaw, concat(V2_INFO, bound), "decrypt");
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: concat(keyId, ephRaw, bound) }, key, ct));
}
