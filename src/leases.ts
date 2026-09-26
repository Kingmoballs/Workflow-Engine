import { performance } from "node:perf_hooks";
import { pool } from "./database.js";

export interface ExecutionLease {
  executionId: string;
  workflowName: string;
  ownerId: string;
  token: string;
  durationMs: number;
  /** Conservative deadline measured on this process's monotonic clock. */
  localDeadline: number;
}

interface LeaseRow {
  id: string;
  workflow_name: string;
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
    executionId: row.id, workflowName: row.workflow_name,
    ownerId: row.lease_owner, token: row.lease_generation,
    durationMs, localDeadline: started + durationMs,
  };
}

export async function claimNextExecution(
  ownerId: string,
  workflowNames: string[],
  durationMs = 30_000,
): Promise<ExecutionLease | undefined> {
  validateLeaseOptions(ownerId, durationMs);
  if (!workflowNames.length) return undefined;
  const started = performance.now();
  const result = await pool.query<LeaseRow>(
    `
      WITH candidate AS (
        SELECT w.id FROM workflow_executions w
        WHERE w.status IN ('pending', 'running')
          AND w.workflow_name = ANY($2::text[])
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
      RETURNING w.id, w.workflow_name, w.lease_owner, w.lease_generation
    `,
    [ownerId, workflowNames, durationMs],
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
  const started = performance.now();
  const result = await pool.query<LeaseRow>(
    `
      WITH candidate AS (
        SELECT id FROM workflow_executions
        WHERE id = $1 AND status IN ('pending', 'running', 'failed')
          AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
        FOR UPDATE SKIP LOCKED
      )
      UPDATE workflow_executions w
      SET lease_owner = $2,
          lease_generation = w.lease_generation + 1,
          lease_expires_at = clock_timestamp() + $3::double precision * INTERVAL '1 millisecond',
          status = 'running', updated_at = clock_timestamp()
      FROM candidate WHERE w.id = candidate.id
      RETURNING w.id, w.workflow_name, w.lease_owner, w.lease_generation
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
    await client.query("SELECT id FROM workflow_executions WHERE id = $1 FOR UPDATE", [lease.executionId]);
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
