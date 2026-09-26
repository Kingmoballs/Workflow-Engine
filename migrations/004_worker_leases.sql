BEGIN;
ALTER TABLE workflow_executions
  ADD COLUMN IF NOT EXISTS lease_owner TEXT,
  ADD COLUMN IF NOT EXISTS lease_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS error TEXT;
CREATE INDEX IF NOT EXISTS workflow_claim_order
  ON workflow_executions (created_at, id)
  WHERE status IN ('pending', 'running');
COMMIT;
