import { validateVersion } from "./versioning.js";
import { validateTimeout } from "./timeout-options.js";
import { jsonSnapshot, type JsonValue } from "./json-data.js";
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
  validateVersion(workflow.version);
  if (!workflow.name.trim()) throw new Error("Workflow name must not be empty.");
  const names = new Set<string>();
  for (const step of workflow.steps) {
    if (names.has(step.name)) throw new Error("Step names must be unique.");
    names.add(step.name);
    if (!step.name.trim() || typeof step.execute !== "function") {
      throw new Error("Every step needs a name and an execute function.");
    }
    retryPolicyFor(step);
  }
}

export function createPendingExecution(workflow: WorkflowDefinition, input: JsonValue = null, timeoutMs?: number): WorkflowExecution {
  validateWorkflowDefinition(workflow);
  validateTimeout(timeoutMs);
  const snapshot = jsonSnapshot(input);
  workflow.validateInput?.(jsonSnapshot(snapshot));
  return {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    workflowVersion: workflow.version ?? 1,
    input: snapshot,
    id: randomUUID(), workflowName: workflow.name, status: "pending",
    steps: workflow.steps.map((step) => ({ name: step.name, status: "pending", attempts: 0 })),
  };
}
