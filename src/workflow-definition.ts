import { randomUUID } from "node:crypto";
import type { RetryPolicy, WorkflowDefinition, WorkflowExecution, WorkflowStep } from "./types.js";

export const MAX_TIMER_MS = 2_147_483_647;
const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, initialDelayMs: 1_000, maxDelayMs: 30_000 };

export function retryPolicyFor(step: WorkflowStep): RetryPolicy {
  const policy = step.retry ?? DEFAULT_RETRY;
  if (
    !Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1 ||
    !Number.isSafeInteger(policy.initialDelayMs) || policy.initialDelayMs < 1 ||
    !Number.isSafeInteger(policy.maxDelayMs) || policy.maxDelayMs < policy.initialDelayMs ||
    policy.maxDelayMs > MAX_TIMER_MS
  ) throw new Error(`Invalid retry policy for step "${step.name}".`);
  return policy;
}

export function validateWorkflowDefinition(workflow: WorkflowDefinition): void {
  if (!workflow.name.trim()) throw new Error("Workflow name must not be empty.");
  for (const step of workflow.steps) {
    if (!step.name.trim() || typeof step.execute !== "function") {
      throw new Error("Every step needs a name and an execute function.");
    }
    retryPolicyFor(step);
  }
}

export function createPendingExecution(workflow: WorkflowDefinition): WorkflowExecution {
  validateWorkflowDefinition(workflow);
  return {
    id: randomUUID(), workflowName: workflow.name, status: "pending",
    steps: workflow.steps.map((step) => ({ name: step.name, status: "pending", attempts: 0 })),
  };
}
