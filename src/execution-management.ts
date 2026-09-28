import { pool } from "./database.js";
import { loadExecution } from "./execution-store.js";
import { getWorkflow } from "./workflow-registry.js";
import { validateSubmissionKey } from "./submission-key.js";
import { RetryConflictError } from "./control-errors.js";
import { InvalidInputError } from "./json-data.js";
import { expireOverdueExecutions } from "./deadlines.js";
import type { WorkflowExecution } from "./types.js";

export async function retryExecution(id: string, requestKey: string): Promise<WorkflowExecution | undefined> {
  validateSubmissionKey(requestKey);
  if (!requestKey) throw new InvalidInputError("Retry requires an Idempotency-Key.");
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '2s'");
    const result = await client.query("SELECT * FROM workflow_executions WHERE id=$1 FOR UPDATE", [id]);
    const row = result.rows[0];
    if (row) {
      const replay = await client.query("SELECT 1 FROM execution_retries WHERE execution_id=$1 AND request_key=$2", [id, requestKey]);
      if (!replay.rowCount) {
        if (row.status !== "failed") throw new RetryConflictError("Only failed executions can be retried.");
        const active = await client.query("SELECT lease_expires_at > clock_timestamp() AS active FROM workflow_executions WHERE id=$1", [id]);
        if (active.rows[0]?.active) throw new RetryConflictError("The previous worker has not released ownership yet.");
        let definition;
        try { definition = getWorkflow(row.workflow_name, row.workflow_version); }
        catch { throw new RetryConflictError("The pinned workflow version is unavailable."); }
        const steps = (await client.query("SELECT * FROM step_executions WHERE workflow_execution_id=$1 ORDER BY step_index", [id])).rows;
        if (steps.length !== definition.steps.length || steps.some((step, index) => step.name !== definition.steps[index]?.name || step.step_index !== index)) {
          throw new RetryConflictError("Saved steps do not match the pinned definition.");
        }
        await client.query(
          "INSERT INTO execution_retries(execution_id, request_key, retry_number, previous_state) VALUES ($1,$2,$3,$4::jsonb)",
          [id, requestKey, row.retry_count + 1, JSON.stringify({ status: row.status, error: row.error, deadlineAt: row.deadline_at, steps })]);
        await client.query("UPDATE step_executions SET status='pending', attempts=0, error=NULL, next_attempt_at=NULL, output=NULL WHERE workflow_execution_id=$1 AND status <> 'completed'", [id]);
        await client.query("UPDATE workflow_executions SET status='pending', error=NULL, retry_count=retry_count+1, lease_owner=NULL, lease_expires_at=NULL, lease_generation=lease_generation+1, deadline_at=CASE WHEN timeout_ms IS NULL THEN NULL ELSE clock_timestamp()+timeout_ms::double precision*INTERVAL '1 millisecond' END, updated_at=clock_timestamp() WHERE id=$1", [id]);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { broken = true; }
    throw error;
  } finally { client.release(broken); }
  return loadExecution(id);
}

const statuses = new Set(["pending", "running", "completed", "failed", "cancelled", "timed_out"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function listExecutions(params: URLSearchParams) {
  if ([...params.keys()].some(key => !["limit", "cursor", "status", "workflowName"].includes(key))) throw new InvalidInputError("Unknown list filter.");
  for (const key of params.keys()) if (params.getAll(key).length !== 1) throw new InvalidInputError("Duplicate list filter.");
  const rawLimit = params.get("limit") ?? "20";
  const limit = Number(rawLimit);
  if (!/^\d+$/.test(rawLimit) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new InvalidInputError("limit must be between 1 and 100.");
  const status = params.get("status");
  if (status !== null && !statuses.has(status)) throw new InvalidInputError("Unknown execution status.");
  const name = params.get("workflowName");
  if (name !== null && (!name.trim() || name.length > 255)) throw new InvalidInputError("Invalid workflowName filter.");
  let cursorTime: string | null = null;
  let cursorId: string | null = null;
  const cursor = params.get("cursor");
  if (cursor !== null) {
    try {
      if (cursor.length > 512) throw new Error();
      const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string" || !Number.isFinite(Date.parse(parsed[0])) || !uuid.test(parsed[1])) throw new Error();
      cursorTime = parsed[0]; cursorId = parsed[1];
    } catch { throw new InvalidInputError("Invalid pagination cursor."); }
  }
  await expireOverdueExecutions();
  // Keep PostgreSQL microseconds in the cursor rather than rounding through JS Date.
  const rows = (await pool.query(
    `SELECT id, workflow_name AS "workflowName", workflow_version AS "workflowVersion", status,
      retry_count AS "retryCount", created_at AS "createdAt", updated_at AS "updatedAt",
      deadline_at AS "deadlineAt", error, created_at::text AS cursor_time
      FROM workflow_executions WHERE ($1::text IS NULL OR status=$1)
        AND ($2::text IS NULL OR workflow_name=$2)
        AND ($3::timestamptz IS NULL OR (created_at,id) < ($3::timestamptz,$4::uuid))
      ORDER BY created_at DESC,id DESC LIMIT $5`,
    [status, name, cursorTime, cursorId, limit + 1])).rows;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    executions: page.map(({ cursor_time: _cursor, ...row }) => row),
    nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.cursor_time, last.id])).toString("base64url") : null,
  };
}

export async function retryHistory(id: string) {
  const exists = await pool.query("SELECT 1 FROM workflow_executions WHERE id=$1", [id]);
  if (!exists.rowCount) return undefined;
  return (await pool.query('SELECT retry_number AS "retryNumber", requested_at AS "requestedAt", previous_state AS "previousState" FROM execution_retries WHERE execution_id=$1 ORDER BY retry_number', [id])).rows;
}

export async function health() {
  await pool.query("SELECT workflow_version, retry_count FROM workflow_executions LIMIT 0");
  await pool.query("SELECT instance_id FROM worker_presence LIMIT 0");
  return { status: "ready" };
}
export async function metrics() {
  await expireOverdueExecutions();
  const counts = (await pool.query("SELECT status, count(*)::integer AS count FROM workflow_executions GROUP BY status ORDER BY status")).rows;
  const workers = (await pool.query(`SELECT instance_id AS "instanceId", worker_id AS "workerId", started_at AS "startedAt", last_seen_at AS "lastSeenAt",
    (stopped_at IS NULL AND last_seen_at > clock_timestamp()-INTERVAL '20 seconds') AS healthy
    FROM worker_presence ORDER BY last_seen_at DESC LIMIT 100`)).rows;
  const queue = (await pool.query("SELECT count(*)::integer AS overdue FROM workflow_executions WHERE status IN ('pending','running') AND deadline_at <= clock_timestamp()")).rows[0];
  return { executions: counts, workers, overdueAwaitingReconciliation: queue.overdue };
}
