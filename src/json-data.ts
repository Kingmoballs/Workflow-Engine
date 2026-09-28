export class InvalidInputError extends Error {}
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export function jsonSnapshot(value: unknown): JsonValue {
  const seen = new Set<object>();
  function check(item: unknown, depth: number): void {
    if (depth > 64) throw new InvalidInputError("JSON data exceeds 64 nesting levels.");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || item === null || seen.has(item)) throw new InvalidInputError("Data must contain only finite, acyclic JSON values.");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new InvalidInputError("Data must use plain JSON objects.");
    seen.add(item);
    if (Array.isArray(item)) { for (let i = 0; i < item.length; i++) check(item[i], depth + 1); }
    else { for (const child of Object.values(item)) check(child, depth + 1); }
    seen.delete(item);
  }
  check(value, 0);
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 65536) throw new InvalidInputError("JSON data exceeds 64 KiB.");
  return JSON.parse(text) as JsonValue;
}
