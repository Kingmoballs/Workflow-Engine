import { RetryableError } from "../errors.js";
import { createSimulatedPayment } from "../simulated-payments.js";
import type { WorkflowDefinition } from "../types.js";

export const retryDemoWorkflow: WorkflowDefinition = {
  name: "retry-demo",
  steps: [
    {
      name: "reserve-inventory",
      execute: async () => {
        console.log("Demo inventory reserved.");
      },
    },
    {
      name: "collect-payment",
      retry: { maxAttempts: 3, initialDelayMs: 1_000, maxDelayMs: 5_000 },
      execute: async ({ attempt, idempotencyKey, signal }) => {
        signal.throwIfAborted();
        const paymentId = await createSimulatedPayment(idempotencyKey);
        console.log("Demo payment reference:", paymentId);
        if (attempt < 3) {
          // The effect succeeded, but its acknowledgement was lost.
          throw new RetryableError("Simulated temporary payment response failure.");
        }
        console.log("Payment acknowledged on attempt", attempt);
      },
    },
    {
      name: "arrange-delivery",
      execute: async () => {
        console.log("Demo delivery arranged.");
      },
    },
  ],
};
