import { createApiServer } from "./api.js";
import { pool } from "./database.js";
import { enqueueWorkflow } from "./enqueue-workflow.js";
import { loadExecution } from "./execution-store.js";
import { listWorkflows } from "./workflow-registry.js";

const port = Number(process.env.API_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("API_PORT must be an integer from 1 to 65535.");

const server = createApiServer({
  workflowNames: () => listWorkflows().map(workflow => workflow.name),
  enqueue: enqueueWorkflow,
  load: loadExecution,
});
server.on("error", async (error) => {
  console.error("API failed:", error);
  await pool.end();
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => console.log(`Workflow API listening at http://127.0.0.1:${port}`));
let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  console.log("Stopping API.");
  const deadline = setTimeout(() => server.closeAllConnections(), 10_000);
  deadline.unref();
  server.close(() => {
    clearTimeout(deadline);
    void pool.end();
  });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
