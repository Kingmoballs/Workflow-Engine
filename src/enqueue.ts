import { pool } from "./database.js";
import { enqueueWorkflow } from "./enqueue-workflow.js";

async function main(): Promise<void> {
  try {
    const execution = await enqueueWorkflow(process.argv[2] ?? "fulfil-order");
    console.log("Queued workflow:", execution.workflowName);
    console.log("Execution ID:", execution.id);
    console.log("Status:", execution.status);
  } finally {
    await pool.end();
  }
}
main().catch((error: unknown) => {
  console.error("Could not queue workflow:", error);
  process.exitCode = 1;
});
