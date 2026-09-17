import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison of a presented bearer secret against the expected one. Both
 * sides are hashed first, so the comparison never depends on the expected length.
 */
export function secureEquals(presented: string | null | undefined, expected: string): boolean {
  if (typeof presented !== "string" || presented.length === 0) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
