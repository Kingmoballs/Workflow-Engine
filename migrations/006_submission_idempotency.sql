BEGIN;
ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS submission_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS workflow_submission_key_unique ON workflow_executions(submission_key);
COMMIT;
