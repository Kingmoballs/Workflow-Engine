import type { PoolClient } from "pg";
import { pool } from "./database.js";

/** Caller must hold the parent row lock. Check database time after obtaining it. */
export async function expireLockedExecution(client: PoolClient, id: string): Promise<boolean> {
  const result = await client.query(
    "UPDATE workflow_executions SET status='timed_out', error='Execution deadline exceeded.', updated_at=clock_timestamp() WHERE id=$1 AND status IN ('pending','running') AND deadline_at <= clock_timestamp() RETURNING id", [id]);
  if (!result.rowCount) return false;
  await client.query("UPDATE step_executions SET status='timed_out', next_attempt_at=NULL, output=NULL WHERE workflow_execution_id=$1 AND status <> 'completed'", [id]);
  return true;
}
export async function expireExecution(id: string): Promise<void> {
  const due = await pool.query("SELECT 1 FROM workflow_executions WHERE id=$1 AND status IN ('pending','running') AND deadline_at <= clock_timestamp()", [id]);
  if (!due.rowCount) return;
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SELECT id FROM workflow_executions WHERE id=$1 FOR UPDATE", [id]);
    await expireLockedExecution(client, id);
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { broken = true; }
    throw error;
  } finally { client.release(broken); }
}
export async function expireOverdueExecutions(): Promise<void> {
  const candidates = await pool.query<{ id: string }>("SELECT id FROM workflow_executions WHERE status IN ('pending','running') AND deadline_at <= clock_timestamp() ORDER BY deadline_at LIMIT 100");
  for (const row of candidates.rows) await expireExecution(row.id);
}
