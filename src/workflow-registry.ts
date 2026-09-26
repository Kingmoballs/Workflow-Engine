import { orderWorkflow } from "./workflows/order-fulfilment.js";
import { retryDemoWorkflow } from "./workflows/retry-demo.js";
import type { WorkflowDefinition } from "./types.js";

const workflows = new Map<string, WorkflowDefinition>([
  [orderWorkflow.name, orderWorkflow],
  [retryDemoWorkflow.name, retryDemoWorkflow],
]);

export function getWorkflow(name: string): WorkflowDefinition {
  const workflow = workflows.get(name);
  if (!workflow) throw new Error(`Unknown workflow definition: ${name}`);
  return workflow;
}

export function listWorkflows(): WorkflowDefinition[] {
  return [...workflows.values()];
}
