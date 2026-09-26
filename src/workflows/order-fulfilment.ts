import { setTimeout as delay } from "node:timers/promises";
import { createSimulatedPayment } from "../simulated-payments.js";
import type { WorkflowDefinition } from "../types.js";

export const orderWorkflow: WorkflowDefinition = {
  name: "fulfil-order",
  steps: [
    {
      name: "reserve-inventory",
      execute: async ({ signal }) => {
        await delay(500, undefined, { signal });
        console.log("Inventory reserved.");
      },
    },
    {
      name: "collect-payment",
      execute: async ({ idempotencyKey, signal }) => {
        signal.throwIfAborted();
        const paymentId = await createSimulatedPayment(idempotencyKey);

        console.log("Payment reference:", paymentId);
        console.log("Waiting 30 seconds before completing the step...");

        await delay(30_000, undefined, { signal });

        console.log("Payment step finished.");
      },
    },
    {
      name: "arrange-delivery",
      execute: async ({ signal }) => {
        await delay(500, undefined, { signal });
        console.log("Delivery arranged.");
      },
    },
  ],
};