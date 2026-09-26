import { pool } from "./database.js";
import type { ExecutionStatus } from "./types.js";

interface LatestExecutionRow {
  id: string;
  workflow_name: string;
  workflow_status: ExecutionStatus;
  workflow_error: string | null;
  lease_owner: string | null;
  lease_generation: string;
  lease_expires_at: Date | null;
  step_index: number | null;
  step_name: string | null;
  step_status: ExecutionStatus | null;
  attempts: number | null;
  error: string | null;
  next_attempt_at: Date | null;
}

async function inspectLatestExecution(): Promise<void> {
  try {
    // Select the execution and its steps together so they share one snapshot.
    const result = await pool.query<LatestExecutionRow>(
      `
        SELECT
          execution.id,
          execution.workflow_name,
          execution.status AS workflow_status,
          execution.error AS workflow_error,
          execution.lease_owner,
          execution.lease_generation,
          execution.lease_expires_at,
          step.step_index,
          step.name AS step_name,
          step.status AS step_status,
          step.attempts,
          step.error,
          step.next_attempt_at
        FROM (
          SELECT id, workflow_name, status, error, lease_owner, lease_generation, lease_expires_at
          FROM workflow_executions
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        ) AS execution
        LEFT JOIN step_executions AS step
          ON step.workflow_execution_id = execution.id
        ORDER BY step.step_index
      `,
    );

    const execution = result.rows[0];

    if (!execution) {
      console.log("No saved executions found. Run the workflow first.");
      return;
    }

    console.log("Execution ID:", execution.id);
    console.log("Workflow:", execution.workflow_name);
    console.log("Status:", execution.workflow_status);
    console.log("Worker:", execution.lease_owner ?? "unclaimed");
    console.log("Lease generation:", execution.lease_generation);
    console.log("Lease expires:", execution.lease_expires_at?.toISOString() ?? "none");
    if (execution.workflow_error) console.log("Execution error:", execution.workflow_error);

    const steps = result.rows
      .filter((row) => row.step_index !== null)
      .map((row) => ({
        step_index: row.step_index,
        name: row.step_name,
        status: row.step_status,
        attempts: row.attempts,
        error: row.error ?? "",
        next_attempt_at: row.next_attempt_at?.toISOString() ?? "",
      }));

    if (steps.length === 0) {
      console.log("This execution has no steps.");
      return;
    }

    console.table(steps);
  } finally {
    await pool.end();
  }
}

inspectLatestExecution().catch((error: unknown) => {
  console.error("Could not inspect the latest execution:", error);
  process.exitCode = 1;
});
