import { orderWorkflow } from "./workflows/order-fulfilment.js";
import { retryDemoWorkflow } from "./workflows/retry-demo.js";
import { definitionKey, validateVersion } from "./versioning.js";
import type { WorkflowDefinition } from "./types.js";

// Keep old definitions registered; add changed behavior under a new version.
const definitions: WorkflowDefinition[] = [orderWorkflow, retryDemoWorkflow];
export function getWorkflow(name: string, version?: number): WorkflowDefinition {
  validateVersion(version);
  const matches = definitions.filter(workflow => workflow.name === name);
  const selected = version ?? Math.max(...matches.map(workflow => workflow.version ?? 1));
  const workflow = matches.find(item => definitionKey(item.name, item.version) === definitionKey(name, selected));
  if (!workflow) throw new Error("Unknown workflow definition or version: " + name + "@" + selected);
  return workflow;
}
export function listWorkflows(): WorkflowDefinition[] { return [...definitions]; }
