import { validateApiKey } from "./auth.js";
import { listExecutions, retryExecution, retryHistory, health, metrics } from "./execution-management.js";
import { cancelExecution } from "./cancellation.js";
import { createApiServer } from "./api.js";
import { pool } from "./database.js";
import { enqueueWorkflow } from "./enqueue-workflow.js";
import { loadExecution } from "./execution-store.js";
import { listWorkflows } from "./workflow-registry.js";

const port = Number(process.env.API_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("API_PORT must be an integer from 1 to 65535.");

const apiKey = process.env.API_KEY;
validateApiKey(apiKey);
const host = process.env.API_HOST ?? "127.0.0.1";
const server = createApiServer({
  workflowNames: () => [...new Set(listWorkflows().map(workflow => workflow.name))],
  workflowVersions: () => listWorkflows().map(workflow => ({ name: workflow.name, version: workflow.version ?? 1 })),
  list: listExecutions, retry: retryExecution, history: retryHistory, health, metrics,
  enqueue: enqueueWorkflow,
  load: loadExecution,
  cancel: cancelExecution,
}, { apiKey });
server.on("error", async (error) => {
  console.error("API failed:", error);
  await pool.end();
  process.exitCode = 1;
});
server.listen(port, host, () => console.log(`Workflow API listening at http://${host}:${port}`));
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
