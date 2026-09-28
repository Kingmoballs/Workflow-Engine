import type { JsonValue } from "./json-data.js";
import { validateSubmissionKey } from "./submission-key.js";
import { loadExecution, saveExecution } from "./execution-store.js";
import { getWorkflow } from "./workflow-registry.js";
import { createPendingExecution } from "./workflow-definition.js";
import type { WorkflowExecution } from "./types.js";

export async function enqueueWorkflow(workflowName: string, input: JsonValue = null, submissionKey?: string, timeoutMs?: number, workflowVersion?: number): Promise<WorkflowExecution> {
  validateSubmissionKey(submissionKey);
  const execution = createPendingExecution(getWorkflow(workflowName, workflowVersion), input, timeoutMs);
  const id = await saveExecution(execution, undefined, submissionKey);
  const existing = await loadExecution(id);
  if (!existing) throw new Error("Idempotent execution no longer exists.");
  return existing;
}
