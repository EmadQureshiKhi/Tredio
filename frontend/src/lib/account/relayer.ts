import type { ActivationTicket, PasskeyProof } from "@tredio/contracts";
import type { Outcome } from "@/lib/chain/outcome";
import { RELAYER_URL } from "@/lib/config";
import { retryAfterSec } from "@/lib/rate-limit";

/**
 * The relayer (apps/relayer): it creates passkey accounts against the API's activation ticket,
 * relays passkey-signed owner requests, and tops up session gas keys. Every refusal is `{ error }`
 * with a short reason.
 */

export class RelayerError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Seconds the relayer asked to wait (Retry-After), on a 429. */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = "RelayerError";
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${RELAYER_URL}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new RelayerError(0, "Tredio's relayer could not be reached, so nothing was sent. Check your connection and try again.");
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new RelayerError(res.status, json.error ?? `the relayer answered ${res.status}`, retryAfterSec(res.headers.get("retry-after")));
  return json;
}

let relayerAccount: Promise<string | null> | null = null;

export const relayer = {
  /** The account the relayer sends from (public, from its health report), to look its transactions up. */
  account: (): Promise<string | null> => {
    relayerAccount ??= fetch(`${RELAYER_URL}/health`)
      .then((r) => r.json() as Promise<{ wallets?: Array<{ account?: string }> }>)
      .then((b) => b.wallets?.[0]?.account ?? null)
      .catch(() => {
        relayerAccount = null;
        return null;
      });
    return relayerAccount;
  },
  /** Creates the passkey's account and runs its first owner request (adding the first session). */
  createAccount: (b: { ownerKey: string; request: string; proof: PasskeyProof; ticket: ActivationTicket | null }) => post<{ account: string; hash: string }>("/v1/accounts", b),
  /** Relays a passkey-signed owner request to the account. */
  ownerExecute: (b: { account: string; request: string; proof: PasskeyProof }) => post<{ hash: string; value: unknown; outcome?: Outcome }>("/v1/owner-execute", b),
  /** Tops up an active session's gas key when it runs low; `hash` is null when it did not need it. */
  fundSession: (b: { account: string; publicKey: string }) => post<{ hash: string | null; balance: string }>("/v1/sessions/fund", b),
  /** Adds to the account's storage deposit at a Tredio contract when it runs low; `hash` is null when it did not need it. */
  fundStorage: (b: { account: string; contract: string }) => post<{ hash: string | null; available: string }>("/v1/storage/fund", b),
};
