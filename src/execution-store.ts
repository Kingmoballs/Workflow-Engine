import { pool } from "./database.js";
import { LeaseLostError } from "./errors.js";
import type { ExecutionLease } from "./leases.js";
import type { ExecutionStatus, WorkflowExecution } from "./types.js";

/** Without a lease this can only INSERT. Existing executions always require fencing. */
export async function saveExecution(
  execution: WorkflowExecution,
  lease?: ExecutionLease,
): Promise<void> {
  if (lease && lease.executionId !== execution.id) throw new LeaseLostError("Lease belongs to another execution.");
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '2s'");
    if (lease) {
      // Keep this parent locked through all step writes, then evaluate database time.
      await client.query("SELECT id FROM workflow_executions WHERE id = $1 FOR UPDATE", [execution.id]);
      const updated = await client.query(
        `
          UPDATE workflow_executions
          SET workflow_name = $2, status = $3, error = $4, updated_at = clock_timestamp()
          WHERE id = $1 AND lease_owner = $5 AND lease_generation = $6
            AND lease_expires_at > clock_timestamp()
        `,
        [execution.id, execution.workflowName, execution.status, execution.error ?? null, lease.ownerId, lease.token],
      );
      if (updated.rowCount !== 1) throw new LeaseLostError();
    } else {
      await client.query(
        "INSERT INTO workflow_executions (id, workflow_name, status, error) VALUES ($1, $2, $3, $4)",
        [execution.id, execution.workflowName, execution.status, execution.error ?? null],
      );
    }

    for (const [index, step] of execution.steps.entries()) {
      await client.query(
        `
          INSERT INTO step_executions (
            workflow_execution_id, step_index, name, status,
            attempts, error, next_attempt_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (workflow_execution_id, step_index)
          DO UPDATE SET
            name = EXCLUDED.name, status = EXCLUDED.status,
            attempts = EXCLUDED.attempts, error = EXCLUDED.error,
            next_attempt_at = EXCLUDED.next_attempt_at
        `,
        [execution.id, index, step.name, step.status, step.attempts, step.error ?? null, step.nextAttemptAt ?? null],
      );
    }
    await client.query("COMMIT");
  } catch (error: unknown) {
    try { await client.query("ROLLBACK"); }
    catch { broken = true; }
    throw error;
  } finally {
    client.release(broken);
  }
}

interface WorkflowRow {
  id: string;
  workflow_name: string;
  status: ExecutionStatus;
  error: string | null;
}
interface StepRow {
  step_index: number;
  name: string;
  status: ExecutionStatus;
  attempts: number;
  error: string | null;
  next_attempt_at: Date | null;
}

export async function loadExecution(executionId: string): Promise<WorkflowExecution | undefined> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const workflowResult = await client.query<WorkflowRow>(
      "SELECT id, workflow_name, status, error FROM workflow_executions WHERE id = $1",
      [executionId],
    );
    const workflow = workflowResult.rows[0];
    if (!workflow) {
      await client.query("COMMIT");
      return undefined;
    }

    const stepResult = await client.query<StepRow>(
      `
        SELECT step_index, name, status, attempts, error, next_attempt_at
        FROM step_executions WHERE workflow_execution_id = $1 ORDER BY step_index
      `,
      [executionId],
    );
    const execution: WorkflowExecution = {
      id: workflow.id, workflowName: workflow.workflow_name, status: workflow.status,
      ...(workflow.error === null ? {} : { error: workflow.error }),
      steps: stepResult.rows.map((step, index) => {
        if (step.step_index !== index) throw new Error("Saved execution has missing or out-of-order steps.");
        return {
          name: step.name, status: step.status, attempts: step.attempts,
          ...(step.error === null ? {} : { error: step.error }),
          ...(step.next_attempt_at === null ? {} : { nextAttemptAt: step.next_attempt_at.toISOString() }),
        };
      }),
    };
    await client.query("COMMIT");
    return execution;
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
