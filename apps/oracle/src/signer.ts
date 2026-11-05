import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58Decode, base58Encode } from "@tredio/chain";

/**
 * Signs reports for the registry, which accepts a report only with an ed25519 signature over
 * SHA-256 of its exact JSON by the key it trusts (`OracleConfig::TeeSigner`).
 *
 * The signer is where the trust lives. `KeySigner` holds the key in this process (the bootstrap
 * mode, while the TEE signer is being rolled out); the registry owner rotates the trusted key
 * with `set_oracle` to a key generated and held inside an OutLayer enclave, after which only code
 * running in that enclave can produce a report the registry accepts.
 */
export interface ReportSigner {
  /** `ed25519:<base58>`, as the registry's oracle config names it. */
  readonly publicKey: string;
  /** Where the key lives, for the status views. */
  readonly kind: "local-key" | "outlayer-tee";
  sign(reportJson: string): Promise<string>;
}

export class KeySigner implements ReportSigner {
  readonly kind = "local-key" as const;
  readonly publicKey: string;
  private readonly seed: Uint8Array;

  constructor(secretKey: string) {
    const raw = base58Decode(secretKey.replace(/^ed25519:/, ""));
    if (raw.length !== 64 && raw.length !== 32) throw new Error("an ed25519 secret key is 32 or 64 bytes");
    this.seed = raw.slice(0, 32);
    this.publicKey = `ed25519:${base58Encode(ed25519.getPublicKey(this.seed))}`;
  }

  async sign(reportJson: string): Promise<string> {
    return Buffer.from(ed25519.sign(sha256(new TextEncoder().encode(reportJson)), this.seed)).toString("base64");
  }
}
