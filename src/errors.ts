export class RetryableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RetryableError";
  }
}

export class LeaseLostError extends Error {
  constructor(message = "This worker no longer owns the execution.", options?: ErrorOptions) {
    super(message, options);
    this.name = "LeaseLostError";
  }
}

export class ExecutionBusyError extends Error {
  constructor(id: string) {
    super(`Execution ${id} is owned by another worker. Wait for its lease to expire before resuming.`);
    this.name = "ExecutionBusyError";
  }
}
