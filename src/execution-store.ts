import { validateVersion } from "./versioning.js";
import { expireExecution, expireLockedExecution } from "./deadlines.js";
import { ExecutionTimedOutError, validateTimeout } from "./timeout-options.js";
import { ExecutionCancelledError } from "./cancellation-error.js";
import { jsonSnapshot, type JsonValue } from "./json-data.js";
import { IdempotencyConflictError, validateSubmissionKey } from "./submission-key.js";
import { pool } from "./database.js";
import { LeaseLostError } from "./errors.js";
import type { ExecutionLease } from "./leases.js";
import type { ExecutionStatus, WorkflowExecution } from "./types.js";

/** Without a lease this can only INSERT. Existing executions always require fencing. */
export async function saveExecution(
  execution: WorkflowExecution,
  lease?: ExecutionLease,
  submissionKey?: string,
): Promise<string> {
  validateSubmissionKey(submissionKey);
  validateTimeout(execution.timeoutMs);
  validateVersion(execution.workflowVersion);
  if (lease && submissionKey !== undefined) throw new Error("Submission keys are only allowed for new executions.");
  if (lease && lease.executionId !== execution.id) throw new LeaseLostError("Lease belongs to another execution.");
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '2s'");
    if (lease) {
      // Keep this parent locked through all step writes, then evaluate database time.
      const locked = await client.query<{ status: string }>("SELECT status FROM workflow_executions WHERE id = $1 FOR UPDATE", [execution.id]);
      if (await expireLockedExecution(client, execution.id)) {
        await client.query("COMMIT");
        throw new ExecutionTimedOutError();
      }
      if (locked.rows[0]?.status === "timed_out") throw new ExecutionTimedOutError();
      if (locked.rows[0]?.status === "cancelled") throw new ExecutionCancelledError();
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
      const input = JSON.stringify(jsonSnapshot(execution.input ?? null));
      const inserted = await client.query(
        "INSERT INTO workflow_executions (id, workflow_name, status, error, input, submission_key, timeout_ms, deadline_at, workflow_version) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, CASE WHEN $7::integer IS NULL THEN NULL ELSE clock_timestamp() + $7::double precision * INTERVAL '1 millisecond' END, $8) ON CONFLICT (submission_key) DO NOTHING RETURNING id",
        [execution.id, execution.workflowName, execution.status, execution.error ?? null, input, submissionKey ?? null, execution.timeoutMs ?? null, execution.workflowVersion ?? 1],
      );
      if (inserted.rowCount === 0) {
        // The unique index waits for a competing transaction to commit or roll back.
        // This next READ COMMITTED statement sees its fully saved execution.
        const existing = await client.query<{ id: string; matches: boolean }>(
          "SELECT id, (workflow_name = $2 AND input = $3::jsonb AND timeout_ms IS NOT DISTINCT FROM $4::integer AND workflow_version = $5) AS matches FROM workflow_executions WHERE submission_key = $1",
          [submissionKey, execution.workflowName, input, execution.timeoutMs ?? null, execution.workflowVersion ?? 1],
        );
        const row = existing.rows[0];
        if (!row) throw new Error("Idempotent execution disappeared.");
        if (!row.matches) throw new IdempotencyConflictError();
        await client.query("COMMIT");
        return row.id;
      }
    }

    for (const [index, step] of execution.steps.entries()) {
      await client.query(
        `
          INSERT INTO step_executions (
            workflow_execution_id, step_index, name, status,
            attempts, error, next_attempt_at, output
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
          ON CONFLICT (workflow_execution_id, step_index)
          DO UPDATE SET
            name = EXCLUDED.name, status = EXCLUDED.status,
            attempts = EXCLUDED.attempts, error = EXCLUDED.error,
            next_attempt_at = EXCLUDED.next_attempt_at, output = EXCLUDED.output
        `,
        [execution.id, index, step.name, step.status, step.attempts, step.error ?? null, step.nextAttemptAt ?? null, step.output === undefined ? null : JSON.stringify(jsonSnapshot(step.output))],
      );
    }
    await client.query("COMMIT");
    return execution.id;
  } catch (error: unknown) {
    try { await client.query("ROLLBACK"); }
    catch { broken = true; }
    throw error;
  } finally {
    client.release(broken);
  }
}

interface WorkflowRow {
  workflow_version: number;
  retry_count: number;
  timeout_ms: number | null;
  deadline_at: Date | null;
  input: JsonValue;
  id: string;
  workflow_name: string;
  status: ExecutionStatus;
  error: string | null;
}
interface StepRow {
  output: JsonValue;
  has_output: boolean;
  step_index: number;
  name: string;
  status: ExecutionStatus;
  attempts: number;
  error: string | null;
  next_attempt_at: Date | null;
}

export async function loadExecution(executionId: string): Promise<WorkflowExecution | undefined> {
  await expireExecution(executionId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const workflowResult = await client.query<WorkflowRow>(
      "SELECT id, workflow_name, status, error, input, timeout_ms, deadline_at, workflow_version, retry_count FROM workflow_executions WHERE id = $1",
      [executionId],
    );
    const workflow = workflowResult.rows[0];
    if (!workflow) {
      await client.query("COMMIT");
      return undefined;
    }

    const stepResult = await client.query<StepRow>(
      `
        SELECT step_index, name, status, attempts, error, next_attempt_at, output, output IS NOT NULL AS has_output
        FROM step_executions WHERE workflow_execution_id = $1 ORDER BY step_index
      `,
      [executionId],
    );
    const execution: WorkflowExecution = {
      ...(workflow.timeout_ms === null ? {} : { timeoutMs: workflow.timeout_ms }),
      ...(workflow.deadline_at === null ? {} : { deadlineAt: workflow.deadline_at.toISOString() }),
      workflowVersion: workflow.workflow_version,
      retryCount: workflow.retry_count,
      input: workflow.input,
      id: workflow.id, workflowName: workflow.workflow_name, status: workflow.status,
      ...(workflow.error === null ? {} : { error: workflow.error }),
      steps: stepResult.rows.map((step, index) => {
        if (step.step_index !== index) throw new Error("Saved execution has missing or out-of-order steps.");
        return {
          name: step.name, status: step.status, attempts: step.attempts,
          ...(step.has_output ? { output: step.output } : {}),
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
