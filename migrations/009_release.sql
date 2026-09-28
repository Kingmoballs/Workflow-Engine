BEGIN;
ALTER TABLE workflow_executions ADD COLUMN workflow_version INTEGER NOT NULL DEFAULT 1 CHECK (workflow_version > 0);
ALTER TABLE workflow_executions ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0);
CREATE TABLE execution_retries (
  execution_id UUID NOT NULL REFERENCES workflow_executions(id),
  request_key TEXT NOT NULL,
  retry_number INTEGER NOT NULL,
  previous_state JSONB NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(execution_id, request_key),
  UNIQUE(execution_id, retry_number)
);
CREATE TABLE worker_presence (
  instance_id UUID PRIMARY KEY,
  worker_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  stopped_at TIMESTAMPTZ
);
CREATE INDEX execution_list_order ON workflow_executions(created_at DESC, id DESC);
COMMIT;
