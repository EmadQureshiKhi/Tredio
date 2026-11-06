-- x402 payments (x402/): one row per verified payment from the moment it is claimed for a
-- request, with its settlement. One signed payload serves one request: it is unique while it is
-- settling, pending or settled; a failed settlement frees it. Re-applied on every start: idempotent.
CREATE TABLE IF NOT EXISTS x402_payments (
  id            BIGSERIAL   PRIMARY KEY,
  -- SHA-256 (hex) of the exact signed delegate action bytes.
  payload_hash  TEXT        NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  resource      TEXT        NOT NULL,
  network       TEXT        NOT NULL CHECK (network IN ('near:testnet', 'near:mainnet')),
  asset         TEXT        NOT NULL,
  pay_to        TEXT        NOT NULL,
  -- Atomic units of the asset.
  amount        NUMERIC(39) NOT NULL CHECK (amount > 0),
  payer         TEXT        NOT NULL,
  -- The payer's key and the delegate action's nonce (the chain makes the nonce single-use).
  public_key    TEXT        NOT NULL,
  nonce         NUMERIC(20) NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'settling' CHECK (status IN ('settling', 'settled', 'pending', 'failed')),
  -- The relayer's transaction, once broadcast.
  tx_hash       TEXT,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS x402_payments_payload ON x402_payments (payload_hash) WHERE status <> 'failed';
CREATE UNIQUE INDEX IF NOT EXISTS x402_payments_settled_tx ON x402_payments (tx_hash) WHERE status = 'settled';
CREATE INDEX IF NOT EXISTS x402_payments_payer ON x402_payments (payer, created_at DESC);
