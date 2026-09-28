import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { pool } from "../../src/database.js";
import { runWorkflow } from "../../src/engine.js";
import { RetryableError } from "../../src/errors.js";
import { loadExecution } from "../../src/execution-store.js";
import { createSimulatedPayment } from "../../src/simulated-payments.js";
import type { WorkflowDefinition } from "../../src/types.js";

const mode = process.argv[2];
const id = process.argv[3];
if (mode !== "retry" && mode !== "effect") throw new Error("Unknown fixture mode.");

const workflow: WorkflowDefinition = {
  name: "process-recovery-test",
  steps: [
    { name: "reserve", execute: async () => { console.log("RESERVE_EXECUTED"); return { reservationId: "R-1" }; } },
    {
      name: "pay",
      retry: { maxAttempts: 3, initialDelayMs: 1_200, maxDelayMs: 1_200 },
      execute: async (context) => {
        assert.deepEqual(context.input, { orderId: "restart-order" });
        assert.deepEqual(context.outputs.reserve, { reservationId: "R-1" });
        console.log("ATTEMPT_START", context.attempt, Date.now());
        const paymentId = await createSimulatedPayment(context.idempotencyKey);
        console.log("PAYMENT_ID", paymentId);
        if (context.attempt === 1) {
          if (mode === "retry") throw new RetryableError("temporary acknowledgement failure");
          console.log("TEST_EFFECT_COMMITTED");
          await delay(60_000);
        }
      },
    },
  ],
};

try {
  const saved = id ? await loadExecution(id) : undefined;
  if (id && !saved) throw new Error("Missing fixture execution.");
  const result = await runWorkflow(workflow, saved, { leaseMs: 1_000, input: { orderId: "restart-order" } });
  console.log("FIXTURE_DONE", result.id, result.status);
  if (result.status !== "completed") process.exitCode = 1;
} finally {
  await pool.end();
}
