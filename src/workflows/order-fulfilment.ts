import { InvalidInputError, type JsonValue } from "../json-data.js";
import { setTimeout as delay } from "node:timers/promises";
import { createSimulatedPayment } from "../simulated-payments.js";
import type { WorkflowDefinition } from "../types.js";

function orderInput(input: JsonValue): { orderId: string; amount: number; currency: string } {
  if (input === null) return { orderId: "DEMO-ORDER", amount: 25000, currency: "NGN" };
  if (typeof input !== "object" || Array.isArray(input) ||
      typeof input.orderId !== "string" || !input.orderId.trim() ||
      typeof input.amount !== "number" || !Number.isSafeInteger(input.amount) || input.amount <= 0 ||
      typeof input.currency !== "string" || !/^[A-Z]{3}$/.test(input.currency) ||
      Object.keys(input).some(key => !["orderId", "amount", "currency"].includes(key))) {
    throw new InvalidInputError("Order input requires orderId, positive integer amount in minor units, and a three-letter uppercase currency.");
  }
  return { orderId: input.orderId, amount: input.amount, currency: input.currency };
}

export const orderWorkflow: WorkflowDefinition = {
  name: "fulfil-order",
  validateInput: input => { orderInput(input); },
  steps: [
    {
      name: "reserve-inventory",
      execute: async ({ signal, input }) => {
        await delay(500, undefined, { signal });
        console.log("Inventory reserved.");
        return { orderId: orderInput(input).orderId, reserved: true };
      },
    },
    {
      name: "collect-payment",
      execute: async ({ idempotencyKey, signal, input }) => {
        signal.throwIfAborted();
        const paymentId = await createSimulatedPayment(idempotencyKey);

        console.log("Payment reference:", paymentId);
        console.log("Waiting 30 seconds before completing the step...");

        await delay(30_000, undefined, { signal });

        console.log("Payment step finished.");
        return { ...orderInput(input), paymentId };
      },
    },
    {
      name: "arrange-delivery",
      execute: async ({ signal, input, outputs }) => {
        await delay(500, undefined, { signal });
        console.log("Delivery arranged.");
        return { orderId: orderInput(input).orderId, payment: outputs["collect-payment"] ?? null, deliveryStatus: "arranged" };
      },
    },
  ],
};