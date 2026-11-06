import { sealKeyId } from "@tredio/autopilot";

/**
 * The executor's grant key: the public half of `AUTOPILOT_SEAL_PRIVATE_KEY` (base64url raw P-256,
 * what the backend's AUTOPILOT_SEAL_PUBLIC_KEY must be) and its key id, which v2 boxes carry.
 */
export async function sealPublicKey(privateKey: string): Promise<{ publicKey: string; keyId: string }> {
  const der = Buffer.from(privateKey, "base64url");
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  if (!jwk.x || !jwk.y) throw new Error("AUTOPILOT_SEAL_PRIVATE_KEY is not a P-256 key");
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  const publicKey = raw.toString("base64url");
  return { publicKey, keyId: await sealKeyId(publicKey) };
}
