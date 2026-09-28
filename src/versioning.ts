import { InvalidInputError } from "./json-data.js";
export function validateVersion(version: unknown): asserts version is number | undefined {
  if (version !== undefined && (!Number.isSafeInteger(version) || (version as number) < 1 || (version as number) > 2147483647)) {
    throw new InvalidInputError("workflowVersion must be a positive 32-bit integer.");
  }
}
export function definitionKey(name: string, version = 1): string { return JSON.stringify([name, version]); }
