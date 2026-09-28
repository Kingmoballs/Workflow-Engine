import type { JsonValue } from "./json-data.js";
export interface StepContext {
  input: JsonValue;
  outputs: Record<string, JsonValue>;
  executionId: string;
  stepName: string;
  attempt: number;
  idempotencyKey: string;
  signal: AbortSignal;
}

export interface RetryPolicy {
  /** Total attempts, including the first attempt and interrupted attempts. */
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export interface WorkflowStep {
  name: string;
  execute: (context: StepContext) => Promise<JsonValue | void>;
  retry?: RetryPolicy;
}

export interface WorkflowDefinition {
  version?: number;
  validateInput?: (input: JsonValue) => void;
  name: string;
  steps: WorkflowStep[];
}

export type ExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface StepExecution {
  output?: JsonValue;
  name: string;
  status: ExecutionStatus;
  attempts: number;
  error?: string;
  /** ISO timestamp of a scheduled retry; persisted before the worker sleeps. */
  nextAttemptAt?: string;
}

export interface WorkflowExecution {
  workflowVersion?: number;
  retryCount?: number;
  timeoutMs?: number;
  deadlineAt?: string;
  input?: JsonValue;
  id: string;
  workflowName: string;
  status: ExecutionStatus;
  steps: StepExecution[];
  error?: string;
}
