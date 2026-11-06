import { type Bytes, concatBytes, own, utf8 } from "@/lib/chain/encoding";

/**
 * What this device keeps between visits, in IndexedDB:
 *
 * - The trading session: its public facts and the session key, encrypted with AES-GCM under a
 *   non-extractable key. That key is derived from the passkey's PRF output when the passkey has
 *   PRF (random otherwise), so script on this origin can use the session without a prompt but
 *   cannot export the key, and the stored ciphertext alone is useless.
 * - The private-data keys (caller identity seed and vault key), wrapped the same way.
 *
 * Losing this store (cleared storage, a new device) costs one or two passkey prompts and nothing
 * else: the passkey is the account.
 */

const DB = "tredio-account";
const VERSION = 1;
const SESSION = "session";
const PRIVATE = "private";

export interface StoredSession {
  kind: "passkey";
  account: string;
  ownerKey: string;
  credentialId: string;
  /** The session key's public key (`ed25519:...`). */
  publicKey: string;
  expiresAt: number;
  dailyLimit: string;
}

interface SessionRecord {
  meta: StoredSession;
  wrappingKey: CryptoKey;
  iv: Bytes;
  ciphertext: ArrayBuffer;
}

interface PrivateRecord {
  wrappingKey: CryptoKey;
  iv: Bytes;
  ciphertext: ArrayBuffer;
  vaultKey: CryptoKey;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      for (const s of [SESSION, PRIVATE]) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const r = fn(db.transaction(store, mode).objectStore(store));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}

async function hkdf(ikm: Uint8Array, info: string, length = 32): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", own(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: utf8(info) }, key, length * 8));
}

/** A non-extractable AES-GCM key from a PRF output, or a random one without it. */
export async function wrappingKey(prf: Uint8Array | null, info: string): Promise<CryptoKey> {
  if (!prf) return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return crypto.subtle.importKey("raw", await hkdf(prf, info), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Bound into the ciphertext, so a record cannot be swapped for another account's. */
const aad = (label: string, account: string) => utf8(`tredio/${label}/${account}`);

export async function saveSession(meta: StoredSession, secretKey: string, prf: Uint8Array | null): Promise<void> {
  const key = await wrappingKey(prf, "tredio/session-store/v1");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad("session", meta.account) }, key, utf8(secretKey));
  await run(SESSION, "readwrite", (s) => s.put({ meta, wrappingKey: key, iv, ciphertext } satisfies SessionRecord, "current"));
}

/** The stored session's facts without its key (to renew it), or null. */
export async function storedSessionMeta(): Promise<StoredSession | null> {
  try {
    const r = (await run(SESSION, "readonly", (s) => s.get("current"))) as SessionRecord | undefined;
    return r?.meta ?? null;
  } catch {
    return null;
  }
}

export async function loadSession(): Promise<{ meta: StoredSession; secretKey: string } | null> {
  try {
    const r = (await run(SESSION, "readonly", (s) => s.get("current"))) as SessionRecord | undefined;
    if (!r) return null;
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: r.iv, additionalData: aad("session", r.meta.account) }, r.wrappingKey, r.ciphertext);
    return { meta: r.meta, secretKey: new TextDecoder().decode(plain) };
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  await run(SESSION, "readwrite", (s) => s.delete("current")).catch(() => undefined);
}

export interface PrivateKeys {
  /** Seed of the caller identity's ed25519 key. */
  identitySeed: Bytes;
  /** AES-GCM key that seals vault items; non-extractable. */
  vaultKey: CryptoKey;
}

/** The private-data keys from the passkey's second PRF output (the same on every device). */
export async function derivePrivateKeys(prf: Uint8Array): Promise<PrivateKeys> {
  const identitySeed = await hkdf(prf, "tredio/caller-identity/v1");
  const vaultKey = await crypto.subtle.importKey("raw", await hkdf(prf, "tredio/vault/v1"), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return { identitySeed, vaultKey };
}

export async function savePrivateKeys(account: string, keys: PrivateKeys): Promise<void> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad("private", account) }, key, keys.identitySeed);
  await run(PRIVATE, "readwrite", (s) => s.put({ wrappingKey: key, iv, ciphertext, vaultKey: keys.vaultKey } satisfies PrivateRecord, account));
}

export async function loadPrivateKeys(account: string): Promise<PrivateKeys | null> {
  try {
    const r = (await run(PRIVATE, "readonly", (s) => s.get(account))) as PrivateRecord | undefined;
    if (!r) return null;
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: r.iv, additionalData: aad("private", account) }, r.wrappingKey, r.ciphertext));
    return { identitySeed: own(plain), vaultKey: r.vaultKey };
  } catch {
    return null;
  }
}

export async function clearPrivateKeys(): Promise<void> {
  await run(PRIVATE, "readwrite", (s) => s.clear()).catch(() => undefined);
}

/**
 * Passkeys this device has seen and the owner key each one is (public facts, in localStorage), so
 * signing in here again needs no key recovery. A passkey made for an account whose creation never
 * finished is marked pending, so the next attempt finishes it instead of making another passkey.
 */
const KNOWN = "tredio.passkeys";

interface Known {
  ownerKey: string;
  pending: boolean;
}

function readKnown(): Record<string, Known> {
  try {
    return (JSON.parse(localStorage.getItem(KNOWN) ?? "{}") as Record<string, Known>) ?? {};
  } catch {
    return {};
  }
}

export function knownPasskey(credentialId: string): Known | null {
  return readKnown()[credentialId] ?? null;
}

export function rememberPasskey(credentialId: string, ownerKey: string, pending: boolean) {
  try {
    localStorage.setItem(KNOWN, JSON.stringify({ ...readKnown(), [credentialId]: { ownerKey, pending } }));
  } catch {
    // Storage blocked: the next sign-in recovers the key from the passkey's signature.
  }
}

/** The newest passkey made here whose account was never created, if any. */
export function pendingPasskey(): { credentialId: string; ownerKey: string } | null {
  const entry = Object.entries(readKnown()).find(([, k]) => k.pending);
  return entry ? { credentialId: entry[0], ownerKey: entry[1].ownerKey } : null;
}

export const randomIv = () => concatBytes(crypto.getRandomValues(new Uint8Array(12)));
