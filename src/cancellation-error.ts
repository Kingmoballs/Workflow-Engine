export class ExecutionCancelledError extends Error {
  constructor() { super("Execution was cancelled."); }
}

export class CancellationConflictError extends Error {
  constructor() { super("Completed, failed, or timed-out executions cannot be cancelled."); }
}

