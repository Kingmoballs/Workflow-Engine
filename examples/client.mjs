import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
if (!process.env.API_KEY) throw new Error("Run npm run setup first.");
const base = process.env.API_URL ?? "http://127.0.0.1:3000";
const headers = { Authorization: "Bearer " + process.env.API_KEY, "Content-Type": "application/json", "Idempotency-Key": randomUUID() };
async function request(path, options = {}) {
  const response = await fetch(base + path, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(10000) });
  const body = await response.json();
  if (!response.ok) throw new Error("API " + response.status + ": " + JSON.stringify(body));
  return body;
}
const body = JSON.stringify({ workflowName: "retry-demo", workflowVersion: 1, input: { orderId: "EXAMPLE-" + Date.now() }, timeoutMs: 60000 });
const execution = await request("/executions", { method: "POST", body });
const replay = await request("/executions", { method: "POST", body });
assert.equal(replay.id, execution.id);
console.log("Submitted once despite two HTTP requests:", execution.id);
const deadline = Date.now() + 70000;
let current = execution;
while (["pending", "running"].includes(current.status) && Date.now() < deadline) {
  await delay(500);
  current = await request("/executions/" + execution.id);
}
assert.equal(current.status, "completed", "Run a worker in another terminal; the example should complete.");
console.log(JSON.stringify(current, null, 2));
console.log("Metrics:", JSON.stringify(await request("/metrics")));
