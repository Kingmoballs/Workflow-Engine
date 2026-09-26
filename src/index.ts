import { pool } from "./database.js";
import { runWorkflow } from "./engine.js";
import { orderWorkflow } from "./workflows/order-fulfilment.js";

async function main(): Promise<void> {
  try {
    const execution = await runWorkflow(orderWorkflow);

    console.log("\nExecution saved to PostgreSQL:");
    console.dir(execution, { depth: null });

    if (execution.status === "failed") {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("Application failed:", error);
  process.exitCode = 1;
});