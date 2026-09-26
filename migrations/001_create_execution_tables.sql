BEGIN;

CREATE TABLE workflow_executions (
  id UUID PRIMARY KEY,

  workflow_name TEXT NOT NULL,

  status TEXT NOT NULL CHECK (
    status IN ('pending', 'running', 'completed', 'failed')
  ),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE step_executions (
  workflow_execution_id UUID NOT NULL
    REFERENCES workflow_executions(id),

  step_index INTEGER NOT NULL CHECK (step_index >= 0),

  name TEXT NOT NULL,

  status TEXT NOT NULL CHECK (
    status IN ('pending', 'running', 'completed', 'failed')
  ),

  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),

  error TEXT,

  PRIMARY KEY (workflow_execution_id, step_index)
);

COMMIT;