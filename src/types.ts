export interface StepContext {
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
  execute: (context: StepContext) => Promise<void>;
  retry?: RetryPolicy;
}

export interface WorkflowDefinition {
  name: string;
  steps: WorkflowStep[];
}

export type ExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export interface StepExecution {
  name: string;
  status: ExecutionStatus;
  attempts: number;
  error?: string;
  /** ISO timestamp of a scheduled retry; persisted before the worker sleeps. */
  nextAttemptAt?: string;
}

export interface WorkflowExecution {
  id: string;
  workflowName: string;
  status: ExecutionStatus;
  steps: StepExecution[];
  error?: string;
}
