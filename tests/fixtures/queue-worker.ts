import { setTimeout as delay } from "node:timers/promises";
import { pool } from "../../src/database.js";
import { runWorker } from "../../src/worker.js";
import { createSimulatedPayment } from "../../src/simulated-payments.js";
import type { WorkflowDefinition } from "../../src/types.js";

const mode = process.argv[2] ?? "once";
const workflow: WorkflowDefinition = {
  name: "queue-fixture",
  steps: [{
    name: "pay",
    execute: async ({ attempt, idempotencyKey, signal }) => {
      const id = await createSimulatedPayment(idempotencyKey);
      console.log("QUEUE_EFFECT", id, attempt);
      await delay(mode === "crash" && attempt === 1 ? 60_000 : 200, undefined, { signal });
    },
  }],
};
try {
  await runWorker({ once: true, leaseMs: 1_000, pollIntervalMs: 20, workflows: [workflow] });
} finally {
  await pool.end();
}
