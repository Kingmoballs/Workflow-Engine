import { InvalidInputError } from "./json-data.js";
import { ExecutionCancelledError } from "./cancellation-error.js";
export class ExecutionTimedOutError extends ExecutionCancelledError {
  constructor() { super(); this.message = "Execution deadline exceeded."; }
}
export function validateTimeout(timeoutMs: unknown): asserts timeoutMs is number | undefined {
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > 2147483647)) {
    throw new InvalidInputError("timeoutMs must be an integer from 1 to 2147483647.");
  }
}
