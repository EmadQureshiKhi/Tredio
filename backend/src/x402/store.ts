import type { Sql } from "../db";

/**
 * The ledger of x402 payments (migration 020). A verified payment is claimed before its resource
 * is produced: the claim is unique per signed payload while it is settling, pending or settled, so
 * one payment serves one request even across API instances. A failed settlement frees the payload
 * (its delegate action may still be valid), and a request that produced nothing releases it.
 */

export type PaymentStatus = "settling" | "settled" | "pending" | "failed";

export interface PaymentClaim {
  payloadHash: string;
  resource: string;
  network: string;
  asset: string;
  payTo: string;
  amount: bigint;
  payer: string;
  publicKey: string;
  nonce: bigint;
}

export class X402Payments {
  constructor(private readonly sql: Sql) {}

  /** The new claim's id, or null when the payload already serves another request. */
  async claim(c: PaymentClaim): Promise<number | null> {
    const [row] = await this.sql<{ id: string }[]>`
      INSERT INTO x402_payments (payload_hash, resource, network, asset, pay_to, amount, payer, public_key, nonce)
      VALUES (${c.payloadHash}, ${c.resource}, ${c.network}, ${c.asset}, ${c.payTo}, ${c.amount.toString()}, ${c.payer}, ${c.publicKey}, ${c.nonce.toString()})
      ON CONFLICT (payload_hash) WHERE status <> 'failed' DO NOTHING
      RETURNING id`;
    return row ? Number(row.id) : null;
  }

  /** The request produced nothing: nobody pays, and the payload may be used again. */
  async release(id: number): Promise<void> {
    await this.sql`DELETE FROM x402_payments WHERE id = ${id} AND status = 'settling'`;
  }

  async finish(id: number, status: Exclude<PaymentStatus, "settling">, txHash: string | null, error: string | null): Promise<void> {
    await this.sql`
      UPDATE x402_payments SET status = ${status}, tx_hash = ${txHash || null}, error = ${error},
             settled_at = CASE WHEN ${status} = 'settled' THEN now() ELSE settled_at END
       WHERE id = ${id}`;
  }
}
