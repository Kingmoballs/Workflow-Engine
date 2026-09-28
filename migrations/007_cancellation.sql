BEGIN;
ALTER TABLE workflow_executions DROP CONSTRAINT workflow_executions_status_check;
ALTER TABLE workflow_executions ADD CONSTRAINT workflow_executions_status_check CHECK (status IN ('pending','running','completed','failed','cancelled'));
ALTER TABLE step_executions DROP CONSTRAINT step_executions_status_check;
ALTER TABLE step_executions ADD CONSTRAINT step_executions_status_check CHECK (status IN ('pending','running','completed','failed','cancelled'));
COMMIT;
