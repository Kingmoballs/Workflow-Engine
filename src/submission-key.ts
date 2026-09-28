import { InvalidInputError } from "./json-data.js";

export class IdempotencyConflictError extends Error {
  constructor() { super("This Idempotency-Key was already used with a different workflow, input, or timeout."); }
}
export function validateSubmissionKey(key: unknown): asserts key is string | undefined {
  if (key !== undefined && (typeof key !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))) {
    throw new InvalidInputError("Idempotency-Key must contain 1–128 letters, digits, dots, underscores, colons, or hyphens.");
  }
}
