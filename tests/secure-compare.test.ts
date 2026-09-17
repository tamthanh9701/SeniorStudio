// The bearer secrets on the worker and cron routes are compared in constant time.
import { describe, expect, it } from "vitest";
import { secureEquals } from "../src/lib/security/secure-compare";

describe("secureEquals", () => {
  it("accepts the exact value and rejects everything else", () => {
    expect(secureEquals("Bearer s3cret", "Bearer s3cret")).toBe(true);
    expect(secureEquals("Bearer s3cret ", "Bearer s3cret")).toBe(false);
    expect(secureEquals("Bearer s3cre", "Bearer s3cret")).toBe(false);
    expect(secureEquals("bearer s3cret", "Bearer s3cret")).toBe(false);
  });

  it("rejects a missing or empty credential", () => {
    expect(secureEquals(undefined, "Bearer s3cret")).toBe(false);
    expect(secureEquals(null, "Bearer s3cret")).toBe(false);
    expect(secureEquals("", "Bearer s3cret")).toBe(false);
  });
});
