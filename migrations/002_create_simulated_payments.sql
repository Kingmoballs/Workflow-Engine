BEGIN;

CREATE TABLE simulated_payments (
  id UUID PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;