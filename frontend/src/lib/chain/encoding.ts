/** Byte encodings NEAR, WebAuthn and the API use, without Node's Buffer (this runs in the browser). */

export type Bytes = Uint8Array<ArrayBuffer>;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export function base58Decode(s: string): Bytes {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("not base58");
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

export function base64Encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

export function base64Decode(s: string): Bytes {
  const raw = atob(s);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export const base64UrlEncode = (bytes: Uint8Array) => base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function base64UrlDecode(s: string): Bytes {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return base64Decode(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

export const hexEncode = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function hexDecode(hex: string): Bytes {
  const h = hex.replace(/^0x/, "");
  if (h.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(h)) throw new Error("not hex");
  const out = new Uint8Array(new ArrayBuffer(h.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const utf8 = (s: string): Bytes => new TextEncoder().encode(s) as Bytes;

export function concatBytes(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, p) => n + p.length, 0)));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A copy backed by its own ArrayBuffer, as WebCrypto wants. */
export const own = (bytes: Uint8Array): Bytes => Uint8Array.from(bytes);

export const randomBytes = (n: number): Bytes => crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n)));
