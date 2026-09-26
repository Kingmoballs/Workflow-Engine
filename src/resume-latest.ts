import { pool } from "./database.js";
import { runWorkflow } from "./engine.js";
import { loadExecution } from "./execution-store.js";
import { getWorkflow } from "./workflow-registry.js";

async function resumeLatestExecution(): Promise<void> {
  try {
    const result = await pool.query<{ id: string }>(`
      SELECT id FROM workflow_executions
      ORDER BY created_at DESC, id DESC LIMIT 1
    `);
    const latest = result.rows[0];
    if (!latest) {
      console.log("No saved executions found.");
      return;
    }

    const savedExecution = await loadExecution(latest.id);
    if (!savedExecution) throw new Error("The selected execution no longer exists.");

    console.log(`Resuming execution: ${savedExecution.id}`);
    const execution = await runWorkflow(
      getWorkflow(savedExecution.workflowName),
      savedExecution,
    );
    console.dir(execution, { depth: null });
    if (execution.status === "failed") process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

resumeLatestExecution().catch((error: unknown) => {
  console.error("Could not resume execution:", error);
  process.exitCode = 1;
});
