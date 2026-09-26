import { pool } from "./database.js";
import { runWorkflow } from "./engine.js";
import { retryDemoWorkflow } from "./workflows/retry-demo.js";

async function main(): Promise<void> {
  try {
    const execution = await runWorkflow(retryDemoWorkflow);
    console.dir(execution, { depth: null });
    if (execution.status === "failed") process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("Retry demo failed:", error);
  process.exitCode = 1;
});
