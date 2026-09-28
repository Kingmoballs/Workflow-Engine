import { expireLockedExecution } from "./deadlines.js";
import { pool } from "./database.js";
import { loadExecution } from "./execution-store.js";
import type { WorkflowExecution } from "./types.js";

import { CancellationConflictError } from "./cancellation-error.js";

/** Parent lock serializes cancellation with claims and worker checkpoints. */
export async function cancelExecution(id: string): Promise<WorkflowExecution | undefined> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '2s'");
    const result = await client.query<{ status: string }>("SELECT status FROM workflow_executions WHERE id=$1 FOR UPDATE", [id]);
    const row = result.rows[0];
    if (await expireLockedExecution(client, id)) {
      await client.query("COMMIT");
      throw new CancellationConflictError();
    }
    if (row && row.status !== "cancelled") {
      if (row.status === "completed" || row.status === "failed" || row.status === "timed_out") throw new CancellationConflictError();
      await client.query("UPDATE workflow_executions SET status='cancelled', updated_at=clock_timestamp() WHERE id=$1", [id]);
      await client.query("UPDATE step_executions SET status='cancelled', next_attempt_at=NULL, output=NULL WHERE workflow_execution_id=$1 AND status <> 'completed'", [id]);
    }
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { broken = true; }
    throw error;
  } finally { client.release(broken); }
  return loadExecution(id);
}
