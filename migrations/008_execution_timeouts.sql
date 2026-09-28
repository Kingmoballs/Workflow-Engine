BEGIN;
ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS timeout_ms INTEGER CHECK (timeout_ms > 0);
ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ;
ALTER TABLE workflow_executions DROP CONSTRAINT workflow_executions_status_check;
ALTER TABLE workflow_executions ADD CONSTRAINT workflow_executions_status_check CHECK (status IN ('pending','running','completed','failed','cancelled','timed_out'));
ALTER TABLE step_executions DROP CONSTRAINT step_executions_status_check;
ALTER TABLE step_executions ADD CONSTRAINT step_executions_status_check CHECK (status IN ('pending','running','completed','failed','cancelled','timed_out'));
CREATE INDEX IF NOT EXISTS workflow_deadlines ON workflow_executions(deadline_at) WHERE status IN ('pending','running') AND deadline_at IS NOT NULL;
COMMIT;
