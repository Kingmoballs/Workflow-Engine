import { expireExecution, expireLockedExecution, expireOverdueExecutions } from "./deadlines.js";
import { ExecutionTimedOutError } from "./timeout-options.js";
import { ExecutionCancelledError } from "./cancellation-error.js";
import { performance } from "node:perf_hooks";
import { pool } from "./database.js";

export interface ExecutionLease {
  executionId: string;
  workflowName: string;
  workflowVersion?: number;
  ownerId: string;
  token: string;
  durationMs: number;
  /** Conservative deadline measured on this process's monotonic clock. */
  localDeadline: number;
}

interface LeaseRow {
  id: string;
  workflow_name: string;
  workflow_version: number;
  lease_owner: string;
  lease_generation: string;
}

export function validateLeaseOptions(ownerId: string, durationMs: number): void {
  if (!ownerId.trim()) throw new Error("Worker ID must not be empty.");
  if (!Number.isSafeInteger(durationMs) || durationMs < 100 || durationMs > 2_147_483_647) {
    throw new Error("Lease duration must be an integer between 100 and 2147483647 ms.");
  }
}

function leaseFrom(row: LeaseRow, durationMs: number, started: number): ExecutionLease {
  return {
    executionId: row.id, workflowName: row.workflow_name, workflowVersion: row.workflow_version,
    ownerId: row.lease_owner, token: row.lease_generation,
    durationMs, localDeadline: started + durationMs,
  };
}

export async function claimNextExecution(
  ownerId: string,
  workflowNames: string[],
  durationMs = 30_000,
  definitions = workflowNames.map(name => ({ name, version: 1 })),
): Promise<ExecutionLease | undefined> {
  validateLeaseOptions(ownerId, durationMs);
  if (!workflowNames.length) return undefined;
  await expireOverdueExecutions();
  const started = performance.now();
  const result = await pool.query<LeaseRow>(
    `
      WITH candidate AS (
        SELECT w.id FROM workflow_executions w
        WHERE w.status IN ('pending', 'running')
          AND (w.deadline_at IS NULL OR w.deadline_at > clock_timestamp())
          AND EXISTS (SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS d(name text, version integer) WHERE d.name=w.workflow_name AND d.version=w.workflow_version)
          AND (w.lease_expires_at IS NULL OR w.lease_expires_at <= clock_timestamp())
          AND COALESCE((
            SELECT s.next_attempt_at <= clock_timestamp()
            FROM step_executions s
            WHERE s.workflow_execution_id = w.id AND s.status <> 'completed'
            ORDER BY s.step_index LIMIT 1
          ), TRUE)
        ORDER BY w.created_at, w.id
        LIMIT 1 FOR UPDATE OF w SKIP LOCKED
      )
      UPDATE workflow_executions w
      SET lease_owner = $1,
          lease_generation = w.lease_generation + 1,
          lease_expires_at = clock_timestamp() + $3::double precision * INTERVAL '1 millisecond',
          status = 'running', updated_at = clock_timestamp()
      FROM candidate
      WHERE w.id = candidate.id
      RETURNING w.id, w.workflow_name, w.workflow_version, w.lease_owner, w.lease_generation
    `,
    [ownerId, JSON.stringify(definitions), durationMs],
  );
  const row = result.rows[0];
  return row ? leaseFrom(row, durationMs, started) : undefined;
}

export async function claimExecution(
  executionId: string,
  ownerId: string,
  durationMs = 30_000,
): Promise<ExecutionLease | undefined> {
  validateLeaseOptions(ownerId, durationMs);
  await expireExecution(executionId);
  const started = performance.now();
  const result = await pool.query<LeaseRow>(
    `
      WITH candidate AS (
        SELECT id FROM workflow_executions
        WHERE id = $1 AND status IN ('pending', 'running', 'failed')
          AND (deadline_at IS NULL OR deadline_at > clock_timestamp())
          AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
        FOR UPDATE SKIP LOCKED
      )
      UPDATE workflow_executions w
      SET lease_owner = $2,
          lease_generation = w.lease_generation + 1,
          lease_expires_at = clock_timestamp() + $3::double precision * INTERVAL '1 millisecond',
          status = 'running', updated_at = clock_timestamp()
      FROM candidate WHERE w.id = candidate.id
      RETURNING w.id, w.workflow_name, w.workflow_version, w.lease_owner, w.lease_generation
    `,
    [executionId, ownerId, durationMs],
  );
  const row = result.rows[0];
  return row ? leaseFrom(row, durationMs, started) : undefined;
}

export async function renewLease(lease: ExecutionLease): Promise<number | undefined> {
  const started = performance.now();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '2s'");
    // Re-check expiry AFTER obtaining the row lock, not before waiting for it.
    const locked = await client.query<{ status: string }>("SELECT status FROM workflow_executions WHERE id = $1 FOR UPDATE", [lease.executionId]);
    if (await expireLockedExecution(client, lease.executionId)) {
      await client.query("COMMIT");
      throw new ExecutionTimedOutError();
    }
    if (locked.rows[0]?.status === "timed_out") throw new ExecutionTimedOutError();
    if (locked.rows[0]?.status === "cancelled") throw new ExecutionCancelledError();
    const renewed = await client.query(
      `
        UPDATE workflow_executions
        SET lease_expires_at = clock_timestamp() + $4::double precision * INTERVAL '1 millisecond'
        WHERE id = $1 AND lease_owner = $2 AND lease_generation = $3
          AND lease_expires_at > clock_timestamp()
      `,
      [lease.executionId, lease.ownerId, lease.token, lease.durationMs],
    );
    await client.query("COMMIT");
    return renewed.rowCount === 1 ? started + lease.durationMs : undefined;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function releaseLease(lease: ExecutionLease): Promise<boolean> {
  const result = await pool.query(
    `
      UPDATE workflow_executions
      SET lease_owner = NULL, lease_expires_at = NULL
      WHERE id = $1 AND lease_owner = $2 AND lease_generation = $3
    `,
    [lease.executionId, lease.ownerId, lease.token],
  );
  return result.rowCount === 1;
}
