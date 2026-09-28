import { createHash, timingSafeEqual } from "node:crypto";
export function validateApiKey(key: string | undefined): asserts key is string {
  if (!key || !/^[A-Za-z0-9_-]{32,256}$/.test(key)) throw new Error("API_KEY must contain 32–256 letters, digits, underscores, or hyphens. Run npm run setup.");
}
export function authorized(header: string | undefined, key: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(header.slice(7)), digest(key));
}
