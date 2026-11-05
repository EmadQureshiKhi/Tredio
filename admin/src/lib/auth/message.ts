/**
 * The message an admin account signs (NEP-413, recipient `admin.tredio.bid`), byte for byte what
 * adminMessage() in backend/src/api/admin-auth.ts rebuilds and verifies. It binds the method, the
 * path with its query string, a unix timestamp, the request's NEP-413 nonce and the SHA-256 of
 * the raw body (empty for GET).
 */
export const ADMIN_RECIPIENT = "admin.tredio.bid";

export async function adminMessage(method: string, pathWithQuery: string, timestampSec: number, nonce: string, body: string): Promise<string> {
  return `Tredio admin request\n${method.toUpperCase()} ${pathWithQuery}\ntimestamp: ${timestampSec}\nnonce: ${nonce}\nbody: ${await sha256Hex(body)}`;
}

/** A fresh 32-byte NEP-413 nonce, and its base64 form the backend reads from the header. */
export function randomNonce(): { bytes: Uint8Array; base64: string } {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return { bytes, base64: btoa(String.fromCharCode(...bytes)) };
}

/** Lowercase hex SHA-256 of a UTF-8 string, via WebCrypto (secure origins only: HTTPS or localhost). */
export async function sha256Hex(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Signing in needs a secure origin: serve the panel over HTTPS or from localhost.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
