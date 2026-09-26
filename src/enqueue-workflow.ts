import { saveExecution } from "./execution-store.js";
import { getWorkflow } from "./workflow-registry.js";
import { createPendingExecution } from "./workflow-definition.js";
import type { WorkflowExecution } from "./types.js";

export async function enqueueWorkflow(workflowName: string): Promise<WorkflowExecution> {
  const execution = createPendingExecution(getWorkflow(workflowName));
  await saveExecution(execution);
  return execution;
}
